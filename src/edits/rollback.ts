import {
	chmod,
	link,
	lstat,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	digest,
	type FileIdentity,
	type ValidatedFileEdit,
} from "./validate.js";

export type MutationStatus =
	| "no_changes"
	| "applied"
	| "failed_restored"
	| "rollback_incomplete"
	| "manual_recovery";

export interface StatLike {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	mode: number;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}
export interface MutationFileSystem {
	lstat(path: string): Promise<StatLike>;
	readFile(path: string): Promise<Buffer>;
	writeExclusive(
		path: string,
		data: Buffer | string,
		mode: number,
	): Promise<void>;
	link(source: string, destination: string): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	rename(source: string, destination: string): Promise<void>;
	rm(path: string, options: { force: true }): Promise<void>;
}
export const nodeMutationFileSystem: MutationFileSystem = {
	lstat,
	readFile,
	writeExclusive: (path, data, mode) =>
		writeFile(path, data, { flag: "wx", mode }),
	link,
	chmod,
	rename,
	rm,
};
export interface Artifact {
	path: string;
	identity: FileIdentity;
}
export interface OwnedOutput {
	artifact: Artifact;
	hash: string;
}
export type ReplacementPhase =
	| "prepared"
	| "target_displaced"
	| "installed"
	| "uncertain";
export interface PreparedReplacement {
	edit: ValidatedFileEdit;
	temporary: Artifact;
	backup: Artifact;
	phase: ReplacementPhase;
	displaced?: Artifact;
	output?: OwnedOutput;
}
export interface RollbackResult {
	status: Extract<MutationStatus, "failed_restored" | "rollback_incomplete">;
	/** Relative target paths that may still contain edited bytes. */
	unrestoredFiles: readonly string[];
	/** Opaque relative artifact names; never private absolute paths. */
	recoveryArtifacts: readonly string[];
}
function identity(value: StatLike): FileIdentity {
	return {
		dev: Number(value.dev),
		ino: Number(value.ino),
		size: Number(value.size),
		mtimeMs: Number(value.mtimeMs),
		mode: Number(value.mode),
	};
}
function same(left: FileIdentity, right: FileIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.mode === right.mode
	);
}
export async function ownedArtifact(
	fileSystem: MutationFileSystem,
	path: string,
): Promise<Artifact | undefined> {
	try {
		const metadata = await fileSystem.lstat(path);
		return metadata.isFile() && !metadata.isSymbolicLink()
			? { path, identity: identity(metadata) }
			: undefined;
	} catch {
		return undefined;
	}
}
export async function stillOwned(
	fileSystem: MutationFileSystem,
	artifact: Artifact,
): Promise<boolean> {
	const current = await ownedArtifact(fileSystem, artifact.path);
	return current !== undefined && same(current.identity, artifact.identity);
}
function artifactPathName(item: PreparedReplacement, path: string): string {
	const directory = dirname(item.edit.relativePath);
	return directory === "." ? basename(path) : join(directory, basename(path));
}
function artifactName(
	item: PreparedReplacement,
	artifact: Artifact | undefined,
): string | undefined {
	return artifact ? artifactPathName(item, artifact.path) : undefined;
}
export type ArtifactRemovalResult =
	| { state: "removed" | "absent"; paths: readonly [] }
	| { state: "present" | "uncertain"; paths: readonly [string, ...string[]] };
type ArtifactCheck = { state: "owned" } | ArtifactRemovalResult;
async function checkArtifact(
	fileSystem: MutationFileSystem,
	artifact: Artifact,
	expectedHash?: string,
): Promise<ArtifactCheck> {
	let metadata: StatLike;
	try {
		metadata = await fileSystem.lstat(artifact.path);
	} catch (error) {
		return isAbsent(error)
			? { state: "absent", paths: [] }
			: { state: "uncertain", paths: [artifact.path] };
	}
	if (
		!metadata.isFile() ||
		metadata.isSymbolicLink() ||
		!same(artifact.identity, identity(metadata))
	)
		return inspectRemovalCandidates(fileSystem, [artifact.path]);
	if (expectedHash !== undefined) {
		try {
			if (digest(await fileSystem.readFile(artifact.path)) !== expectedHash)
				return inspectRemovalCandidates(fileSystem, [artifact.path]);
		} catch {
			return inspectRemovalCandidates(fileSystem, [artifact.path]);
		}
	}
	return { state: "owned" };
}
async function inspectRemovalCandidates(
	fileSystem: MutationFileSystem,
	paths: readonly string[],
): Promise<ArtifactRemovalResult> {
	const survivors: string[] = [];
	let uncertain = false;
	for (const path of paths) {
		try {
			await fileSystem.lstat(path);
			survivors.push(path);
		} catch (error) {
			if (isAbsent(error)) continue;
			uncertain = true;
			survivors.push(path);
		}
	}
	const [first, ...remaining] = survivors;
	if (first === undefined) return { state: "absent", paths: [] };
	const pathsFound: [string, ...string[]] = [first, ...remaining];
	return uncertain
		? { state: "uncertain", paths: pathsFound }
		: { state: "present", paths: pathsFound };
}
async function restoreUnexpectedArtifact(
	fileSystem: MutationFileSystem,
	originalPath: string,
	quarantinePath: string,
): Promise<ArtifactRemovalResult> {
	const movedArtifact = await ownedArtifact(fileSystem, quarantinePath);
	if (!movedArtifact)
		return inspectRemovalCandidates(fileSystem, [quarantinePath, originalPath]);
	try {
		if (await pathExists(fileSystem, originalPath))
			return inspectRemovalCandidates(fileSystem, [
				quarantinePath,
				originalPath,
			]);
		await fileSystem.link(quarantinePath, originalPath);
	} catch {
		return inspectRemovalCandidates(fileSystem, [quarantinePath, originalPath]);
	}
	if (
		(await stillOwned(fileSystem, movedArtifact)) &&
		(await stillOwned(fileSystem, { ...movedArtifact, path: originalPath }))
	)
		return { state: "present", paths: [quarantinePath, originalPath] };
	return inspectRemovalCandidates(fileSystem, [quarantinePath, originalPath]);
}
function addArtifactRecovery(
	recovery: Set<string>,
	item: PreparedReplacement,
	result: ArtifactRemovalResult,
): void {
	for (const path of result.paths) recovery.add(artifactPathName(item, path));
}
export async function removeOwnedArtifact(
	fileSystem: MutationFileSystem,
	artifact: Artifact,
	expectedHash?: string,
): Promise<ArtifactRemovalResult> {
	const quarantine = `${artifact.path}.cleanup-${randomUUID()}`;
	const sourceCheck = await checkArtifact(fileSystem, artifact, expectedHash);
	if (sourceCheck.state !== "owned") return sourceCheck;
	try {
		await fileSystem.rename(artifact.path, quarantine);
	} catch {
		return inspectRemovalCandidates(fileSystem, [quarantine, artifact.path]);
	}
	const quarantined = { ...artifact, path: quarantine };
	const quarantineCheck = await checkArtifact(
		fileSystem,
		quarantined,
		expectedHash,
	);
	if (quarantineCheck.state === "absent")
		return inspectRemovalCandidates(fileSystem, [quarantine, artifact.path]);
	if (quarantineCheck.state === "present")
		return restoreUnexpectedArtifact(fileSystem, artifact.path, quarantine);
	if (quarantineCheck.state !== "owned") return quarantineCheck;
	try {
		await fileSystem.rm(quarantine, { force: true });
		const outcome = await inspectRemovalCandidates(fileSystem, [
			quarantine,
			artifact.path,
		]);
		return outcome.state === "absent"
			? { state: "removed", paths: [] }
			: outcome;
	} catch {
		return inspectRemovalCandidates(fileSystem, [quarantine, artifact.path]);
	}
}
function isAbsent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}
async function pathExists(
	fileSystem: MutationFileSystem,
	path: string,
): Promise<boolean> {
	try {
		await fileSystem.lstat(path);
		return true;
	} catch (error) {
		if (isAbsent(error)) return false;
		throw error;
	}
}
async function artifactMatches(
	fileSystem: MutationFileSystem,
	artifact: Artifact,
	expectedHash: string,
): Promise<boolean> {
	try {
		if (!(await stillOwned(fileSystem, artifact))) return false;
		const bytes = await fileSystem.readFile(artifact.path);
		return (
			digest(bytes) === expectedHash && (await stillOwned(fileSystem, artifact))
		);
	} catch {
		return false;
	}
}

/**
 * Restores replaced targets in reverse order. A failed restoration deliberately
 * retains its original backup and reports only a workspace-relative artifact name.
 */
export async function rollback(
	prepared: readonly PreparedReplacement[],
	fileSystem: MutationFileSystem,
): Promise<RollbackResult> {
	const recovery = new Set<string>();
	const unrestored = new Set<string>();
	for (const item of [...prepared].reverse()) {
		if (item.phase === "prepared") continue;
		const backupName = artifactName(item, item.backup);
		if (item.phase === "uncertain") {
			unrestored.add(item.edit.relativePath);
			if (backupName) recovery.add(backupName);
			if (item.displaced)
				addArtifactRecovery(
					recovery,
					item,
					await inspectRemovalCandidates(fileSystem, [item.displaced.path]),
				);
			continue;
		}
		let restorePath: string | undefined;
		let restore: Artifact | undefined;
		let outputQuarantine: Artifact | undefined;
		try {
			if (!(await artifactMatches(fileSystem, item.backup, item.edit.hash)))
				throw new Error("backup_changed");
			if (item.phase === "installed") {
				if (!item.output || !(await pathExists(fileSystem, item.edit.path)))
					throw new Error("installed_target_missing");
				if (
					!item.output ||
					!(await artifactMatches(
						fileSystem,
						item.output.artifact,
						item.output.hash,
					))
				)
					throw new Error("target_changed");
			} else {
				if (
					(await pathExists(fileSystem, item.edit.path)) ||
					!item.displaced ||
					!(await artifactMatches(fileSystem, item.displaced, item.edit.hash))
				)
					throw new Error("displaced_target_unverified");
			}
			restorePath = `${item.backup.path}.restore-${randomUUID()}`;
			await fileSystem.writeExclusive(
				restorePath,
				await fileSystem.readFile(item.backup.path),
				0o600,
			);
			restore = await ownedArtifact(fileSystem, restorePath);
			if (
				!restore ||
				!(await artifactMatches(fileSystem, restore, item.edit.hash))
			)
				throw new Error("restore_changed");
			await fileSystem.chmod(restorePath, item.edit.identity.mode & 0o777);
			restore = await ownedArtifact(fileSystem, restorePath);
			if (
				!restore ||
				!(await artifactMatches(fileSystem, restore, item.edit.hash))
			)
				throw new Error("restore_changed");
			if (item.phase === "installed") {
				if (
					!item.output ||
					!(await artifactMatches(
						fileSystem,
						item.output.artifact,
						item.output.hash,
					))
				)
					throw new Error("target_changed");
				const quarantinePath = `${item.edit.path}.rollback-${randomUUID()}`;
				outputQuarantine = {
					path: quarantinePath,
					identity: item.output.artifact.identity,
				};
				try {
					await fileSystem.rename(item.edit.path, quarantinePath);
				} catch (error) {
					let targetAbsent = false;
					try {
						targetAbsent = !(await pathExists(fileSystem, item.edit.path));
					} catch {
						// An uninspectable target keeps the backup and quarantine for recovery.
					}
					if (
						!targetAbsent ||
						!(await artifactMatches(
							fileSystem,
							outputQuarantine,
							item.output.hash,
						))
					)
						throw error;
				}
				if (
					!(await artifactMatches(
						fileSystem,
						outputQuarantine,
						item.output.hash,
					))
				)
					throw new Error("quarantined_target_changed");
			}
			await fileSystem.link(restorePath, item.edit.path);
			if (
				!(await artifactMatches(fileSystem, restore, item.edit.hash)) ||
				!(await artifactMatches(
					fileSystem,
					{ ...restore, path: item.edit.path },
					item.edit.hash,
				))
			)
				throw new Error("restored_target_changed");
			addArtifactRecovery(
				recovery,
				item,
				await removeOwnedArtifact(fileSystem, restore, item.edit.hash),
			);
			restore = undefined;
			if (outputQuarantine) {
				addArtifactRecovery(
					recovery,
					item,
					await removeOwnedArtifact(
						fileSystem,
						outputQuarantine,
						item.output?.hash,
					),
				);
				outputQuarantine = undefined;
			}
			if (item.phase === "target_displaced" && item.displaced) {
				addArtifactRecovery(
					recovery,
					item,
					await removeOwnedArtifact(fileSystem, item.displaced, item.edit.hash),
				);
			}
			item.phase = "prepared";
			if (backupName) recovery.delete(backupName);
		} catch {
			unrestored.add(item.edit.relativePath);
			if (backupName) recovery.add(backupName);
			if (item.displaced)
				addArtifactRecovery(
					recovery,
					item,
					await inspectRemovalCandidates(fileSystem, [item.displaced.path]),
				);
			if (outputQuarantine)
				addArtifactRecovery(
					recovery,
					item,
					await inspectRemovalCandidates(fileSystem, [outputQuarantine.path]),
				);
			if (restore) {
				addArtifactRecovery(
					recovery,
					item,
					await removeOwnedArtifact(fileSystem, restore),
				);
			} else if (restorePath) {
				const restoreExists = await pathExists(fileSystem, restorePath).catch(
					() => true,
				);
				if (restoreExists) recovery.add(artifactPathName(item, restorePath));
			}
		}
	}
	return recovery.size > 0
		? {
				status: "rollback_incomplete",
				unrestoredFiles: [...unrestored].sort(),
				recoveryArtifacts: [...recovery].sort(),
			}
		: {
				status: "failed_restored",
				unrestoredFiles: [],
				recoveryArtifacts: [],
			};
}
