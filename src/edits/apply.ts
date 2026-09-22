import {
	chmod,
	link as fsLink,
	lstat,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	digest,
	sameIdentity,
	type FileIdentity,
	type ValidatedFileEdit,
} from "./validate.js";
import {
	ownedArtifact,
	removeOwnedArtifact,
	rollback,
	stillOwned,
	type Artifact,
	type MutationFileSystem,
	type MutationStatus,
	type OwnedOutput,
	type PreparedReplacement,
	type StatLike,
} from "./rollback.js";

export interface ApplyFileSystem extends MutationFileSystem {
	stat(path: string): Promise<StatLike>;
	realpath(path: string): Promise<string>;
}
const nodeFileSystem: ApplyFileSystem = {
	lstat,
	stat,
	readFile,
	realpath,
	writeExclusive: (path, data, mode) =>
		writeFile(path, data, { flag: "wx", mode }),
	link: fsLink,
	chmod,
	rename,
	rm,
};
export type MutationQueue = <T>(
	path: string,
	fn: () => Promise<T>,
) => Promise<T>;
export type ApplyPhase =
	| "validated"
	| "temporary"
	| "backup"
	| "prepared"
	| "commit"
	| "replaced"
	| "rollback"
	| "cleanup";
export interface ApplyOptions {
	signal?: AbortSignal;
	fileSystem?: ApplyFileSystem;
	queue?: MutationQueue;
	platform?: NodeJS.Platform;
	onPhase?: (phase: ApplyPhase, index?: number) => void;
}
export interface ApplyResult {
	status: MutationStatus;
	files: readonly string[];
	editCount: number;
	/** Relative artifact basenames only, present solely if manual recovery is needed. */
	recoveryArtifacts: readonly string[];
}
function result(
	status: MutationStatus,
	files: readonly string[] = [],
	editCount = 0,
	recoveryArtifacts: readonly string[] = [],
): ApplyResult {
	return {
		status,
		files,
		editCount,
		recoveryArtifacts: [...recoveryArtifacts].sort(),
	};
}
function fileIdentity(value: StatLike): FileIdentity {
	return {
		dev: Number(value.dev),
		ino: Number(value.ino),
		size: Number(value.size),
		mtimeMs: Number(value.mtimeMs),
		mode: Number(value.mode),
	};
}
async function withQueues<T>(
	paths: readonly string[],
	queue: MutationQueue,
	work: () => Promise<T>,
	index = 0,
): Promise<T> {
	const path = paths[index];
	return path === undefined
		? work()
		: queue(path, () => withQueues(paths, queue, work, index + 1));
}
async function targetMatches(
	edit: ValidatedFileEdit,
	fileSystem: ApplyFileSystem,
): Promise<boolean> {
	try {
		if ((await fileSystem.realpath(dirname(edit.path))) !== edit.parentPath)
			return false;
		const metadata = await fileSystem.stat(edit.path);
		if (
			!metadata.isFile() ||
			!sameIdentity(edit.identity, fileIdentity(metadata))
		)
			return false;
		return digest(await fileSystem.readFile(edit.path)) === edit.hash;
	} catch {
		return false;
	}
}
function relativeArtifactName(edit: ValidatedFileEdit, path: string): string {
	const directory = dirname(edit.relativePath);
	return directory === "." ? basename(path) : join(directory, basename(path));
}
function recoveryName(item: PreparedReplacement, artifact: Artifact): string {
	return relativeArtifactName(item.edit, artifact.path);
}
function names(item: PreparedReplacement): Artifact[] {
	return [
		item.temporary,
		item.backup,
		...(item.displaced ? [item.displaced] : []),
	];
}
/** Deletes only artifacts that still match our lstat identity. Every failure is surfaced. */
async function cleanupStandalone(
	artifacts: readonly Artifact[],
	fileSystem: ApplyFileSystem,
): Promise<readonly string[]> {
	const recovery: string[] = [];
	for (const artifact of artifacts) {
		const removal = await removeOwnedArtifact(fileSystem, artifact);
		for (const path of removal.paths)
			recovery.push(path.split(/[\\/]/).at(-1) ?? "artifact");
	}
	return recovery.sort();
}
async function cleanup(
	prepared: readonly PreparedReplacement[],
	fileSystem: ApplyFileSystem,
	preserve = new Set<string>(),
): Promise<readonly string[]> {
	const recovery = new Set<string>();
	for (const item of prepared) {
		for (const artifact of names(item)) {
			const artifactName = recoveryName(item, artifact);
			if (preserve.has(artifact.path)) {
				recovery.add(artifactName);
				continue;
			}
			const removal = await removeOwnedArtifact(fileSystem, artifact);
			for (const path of removal.paths)
				recovery.add(recoveryName(item, { ...artifact, path }));
		}
	}
	return [...recovery].sort();
}
class ArtifactIdentityError extends Error {
	public constructor(public readonly recoveryArtifact: string) {
		super("owned_artifact_identity_failed");
	}
}
async function artifactMatches(
	fileSystem: ApplyFileSystem,
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
async function captureOutput(
	fileSystem: ApplyFileSystem,
	item: PreparedReplacement,
	expectedHash: string,
): Promise<OwnedOutput> {
	const artifact = await ownedArtifact(fileSystem, item.edit.path);
	if (!artifact || !(await artifactMatches(fileSystem, artifact, expectedHash)))
		throw new Error("replacement_output_changed");
	return { artifact, hash: expectedHash };
}
async function reconcileReplacement(
	item: PreparedReplacement,
	fileSystem: ApplyFileSystem,
	outputHash: string,
): Promise<"installed" | "unchanged" | "uncertain"> {
	const outputAtTarget = await artifactMatches(
		fileSystem,
		{ ...item.temporary, path: item.edit.path },
		outputHash,
	);
	const temporaryRemains = await artifactMatches(
		fileSystem,
		item.temporary,
		outputHash,
	);
	if (outputAtTarget && !temporaryRemains) {
		item.phase = "installed";
		item.output = {
			artifact: { ...item.temporary, path: item.edit.path },
			hash: outputHash,
		};
		return "installed";
	}
	if (temporaryRemains && (await targetMatches(item.edit, fileSystem)))
		return "unchanged";
	item.phase = "uncertain";
	return "uncertain";
}
async function reconcileDisplacedReplacement(
	item: PreparedReplacement,
	fileSystem: ApplyFileSystem,
	outputHash: string,
): Promise<"installed" | "unchanged" | "uncertain"> {
	const outputAtTarget = await artifactMatches(
		fileSystem,
		{ ...item.temporary, path: item.edit.path },
		outputHash,
	);
	const temporaryRemains = await artifactMatches(
		fileSystem,
		item.temporary,
		outputHash,
	);
	const displacedRemains =
		item.displaced !== undefined &&
		(await artifactMatches(fileSystem, item.displaced, item.edit.hash));
	let targetAbsent = false;
	try {
		await fileSystem.lstat(item.edit.path);
	} catch (error) {
		targetAbsent =
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT";
	}
	if (outputAtTarget && !temporaryRemains) {
		item.phase = "installed";
		item.output = {
			artifact: { ...item.temporary, path: item.edit.path },
			hash: outputHash,
		};
		return "installed";
	}
	if (temporaryRemains && displacedRemains && targetAbsent) return "unchanged";
	item.phase = "uncertain";
	return "uncertain";
}
async function makeArtifact(
	fileSystem: ApplyFileSystem,
	path: string,
	bytes: Buffer | string,
	recoveryArtifact: string,
): Promise<Artifact> {
	await fileSystem.writeExclusive(path, bytes, 0o600);
	const artifact = await ownedArtifact(fileSystem, path);
	if (!artifact || !(await stillOwned(fileSystem, artifact)))
		throw new ArtifactIdentityError(recoveryArtifact);
	return artifact;
}
async function replace(
	item: PreparedReplacement,
	fileSystem: ApplyFileSystem,
	platform: NodeJS.Platform,
): Promise<void> {
	const outputHash = digest(item.edit.output);
	if (
		!(await artifactMatches(fileSystem, item.temporary, outputHash)) ||
		!(await targetMatches(item.edit, fileSystem))
	)
		throw new Error("commit_boundary_changed");
	try {
		await fileSystem.rename(item.temporary.path, item.edit.path);
		item.phase = "installed";
		item.output = await captureOutput(fileSystem, item, outputHash);
		await fileSystem.chmod(item.edit.path, item.edit.identity.mode & 0o777);
		item.output = await captureOutput(fileSystem, item, outputHash);
		return;
	} catch (error) {
		const state = await reconcileReplacement(item, fileSystem, outputHash);
		if (state !== "unchanged" || platform !== "win32") throw error;
	}
	// Windows may reject rename over an existing target. Move the target aside only
	// after revalidation; the independent exclusive backup remains intact throughout.
	if (
		!(await targetMatches(item.edit, fileSystem)) ||
		!(await artifactMatches(fileSystem, item.temporary, outputHash))
	)
		throw new Error("commit_boundary_changed");
	const displacedPath = `${item.backup.path}.replace-${randomUUID()}`;
	const displaced: Artifact = {
		path: displacedPath,
		identity: item.edit.identity,
	};
	item.displaced = displaced;
	try {
		await fileSystem.rename(item.edit.path, displacedPath);
	} catch (error) {
		const displacedExists = await artifactMatches(
			fileSystem,
			displaced,
			item.edit.hash,
		);
		const targetUnchanged = await targetMatches(item.edit, fileSystem);
		let targetExists = true;
		try {
			await fileSystem.lstat(item.edit.path);
		} catch (inspectionError) {
			if (
				typeof inspectionError === "object" &&
				inspectionError !== null &&
				"code" in inspectionError &&
				(inspectionError as NodeJS.ErrnoException).code === "ENOENT"
			)
				targetExists = false;
		}
		if (displacedExists && !targetExists) {
			item.phase = "target_displaced";
		} else if (targetUnchanged && !displacedExists) {
			delete item.displaced;
			throw error;
		} else {
			item.phase = "uncertain";
			throw error;
		}
	}
	item.phase = "target_displaced";
	if (!(await artifactMatches(fileSystem, displaced, item.edit.hash)))
		throw new Error("displaced_target_invalid");
	try {
		if (!(await artifactMatches(fileSystem, item.temporary, outputHash)))
			throw new Error("temporary_changed");
		await fileSystem.rename(item.temporary.path, item.edit.path);
		item.phase = "installed";
		item.output = await captureOutput(fileSystem, item, outputHash);
		await fileSystem.chmod(item.edit.path, item.edit.identity.mode & 0o777);
		item.output = await captureOutput(fileSystem, item, outputHash);
	} catch (error) {
		const state = await reconcileDisplacedReplacement(
			item,
			fileSystem,
			outputHash,
		);
		if (state !== "unchanged") throw error;
		try {
			if (await artifactMatches(fileSystem, displaced, item.edit.hash)) {
				await fileSystem.link(displaced.path, item.edit.path);
				if (
					(await artifactMatches(fileSystem, displaced, item.edit.hash)) &&
					(await artifactMatches(
						fileSystem,
						{ ...displaced, path: item.edit.path },
						item.edit.hash,
					))
				) {
					item.phase = "prepared";
					const [survivingPath] = (
						await removeOwnedArtifact(fileSystem, displaced, item.edit.hash)
					).paths;
					if (survivingPath)
						item.displaced = { ...displaced, path: survivingPath };
				}
			}
		} catch {
			// rollback keeps the separately-created backup as recovery material.
		}
		throw error;
	}
}

/**
 * Applies validated edits under nested host queues in canonical path order. This is
 * rollback-aware only; it deliberately makes no multi-file transaction claim.
 */
export async function applyValidatedEdits(
	edits: readonly ValidatedFileEdit[],
	options: ApplyOptions = {},
): Promise<ApplyResult> {
	if (edits.length === 0 || options.signal?.aborted)
		return result("no_changes");
	const fileSystem = options.fileSystem ?? nodeFileSystem;
	const queue = options.queue ?? withFileMutationQueue;
	const platform = options.platform ?? process.platform;
	const ordered = [...edits].sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
	return withQueues(
		ordered.map((item) => item.path),
		queue,
		async () => {
			if (options.signal?.aborted) return result("no_changes");
			for (const edit of ordered)
				if (!(await targetMatches(edit, fileSystem)))
					return result("no_changes");
			options.onPhase?.("validated");
			const nonce = randomUUID();
			const prepared: PreparedReplacement[] = [];
			const unpaired: Artifact[] = [];
			const unsafeArtifacts: string[] = [];
			try {
				for (const [index, edit] of ordered.entries()) {
					if (options.signal?.aborted) {
						options.onPhase?.("cleanup");
						const leftover = await cleanup(prepared, fileSystem);
						return leftover.length
							? result("manual_recovery", [], 0, leftover)
							: result("no_changes");
					}
					const prefix = join(
						dirname(edit.path),
						`.pi-lsp-manager-${nonce}-${index}`,
					);
					const temporaryPath = `${prefix}.tmp`;
					const temporary = await makeArtifact(
						fileSystem,
						temporaryPath,
						edit.output,
						relativeArtifactName(edit, temporaryPath),
					);
					options.onPhase?.("temporary", index);
					unpaired.push(temporary);
					const backupPath = `${prefix}.bak`;
					const backup = await makeArtifact(
						fileSystem,
						backupPath,
						edit.bytes,
						relativeArtifactName(edit, backupPath),
					);
					options.onPhase?.("backup", index);
					unpaired.pop();
					prepared.push({ edit, temporary, backup, phase: "prepared" });
				}
				options.onPhase?.("prepared");
				if (options.signal?.aborted) {
					options.onPhase?.("cleanup");
					const leftover = await cleanup(prepared, fileSystem);
					return leftover.length
						? result("manual_recovery", [], 0, leftover)
						: result("no_changes");
				}
				options.onPhase?.("commit");
				for (const [index, item] of prepared.entries()) {
					await replace(item, fileSystem, platform);
					options.onPhase?.("replaced", index);
				}
				const appliedFiles = ordered.map((item) => item.relativePath);
				const appliedEdits = ordered.reduce(
					(count, item) => count + item.edits.length,
					0,
				);
				options.onPhase?.("cleanup");
				const leftover = await cleanup(prepared, fileSystem);
				return leftover.length
					? result("manual_recovery", appliedFiles, appliedEdits, leftover)
					: result("applied", appliedFiles, appliedEdits);
			} catch (error) {
				if (error instanceof ArtifactIdentityError)
					unsafeArtifacts.push(error.recoveryArtifact);
				options.onPhase?.("rollback");
				const restored = await rollback(prepared, fileSystem);
				options.onPhase?.("cleanup");
				const unpairedLeftover = await cleanupStandalone(unpaired, fileSystem);
				const preserve = new Set(
					prepared
						.filter((item) =>
							restored.unrestoredFiles.includes(item.edit.relativePath),
						)
						.flatMap((item) => [
							item.backup.path,
							...(item.displaced ? [item.displaced.path] : []),
						]),
				);
				const leftover = await cleanup(prepared, fileSystem, preserve);
				const recovery = [
					...new Set([
						...restored.recoveryArtifacts,
						...unsafeArtifacts,
						...unpairedLeftover,
						...leftover,
					]),
				].sort();
				return recovery.length
					? result("rollback_incomplete", restored.unrestoredFiles, 0, recovery)
					: result("failed_restored");
			}
		},
	);
}
