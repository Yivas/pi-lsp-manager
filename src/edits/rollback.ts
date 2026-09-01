import {
	chmod,
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
	chmod(path: string, mode: number): Promise<void>;
	rename(source: string, destination: string): Promise<void>;
	rm(path: string, options: { force: true }): Promise<void>;
}
export const nodeMutationFileSystem: MutationFileSystem = {
	lstat,
	readFile,
	writeExclusive: (path, data, mode) =>
		writeFile(path, data, { flag: "wx", mode }),
	chmod,
	rename,
	rm,
};
export interface Artifact {
	path: string;
	identity: FileIdentity;
}
export interface PreparedReplacement {
	edit: ValidatedFileEdit;
	temporary: Artifact;
	backup: Artifact;
	replaced: boolean;
	displaced?: Artifact;
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
async function discardOwned(
	fileSystem: MutationFileSystem,
	artifact: Artifact,
): Promise<boolean> {
	const quarantine = `${artifact.path}.cleanup-${randomUUID()}`;
	let moved = false;
	try {
		if (!(await stillOwned(fileSystem, artifact))) return false;
		await fileSystem.rename(artifact.path, quarantine);
		moved = true;
		const quarantined = { path: quarantine, identity: artifact.identity };
		if (!(await stillOwned(fileSystem, quarantined))) {
			await fileSystem.rename(quarantine, artifact.path).catch(() => undefined);
			return false;
		}
		await fileSystem.rm(quarantine, { force: true });
		return true;
	} catch {
		if (moved)
			await fileSystem.rename(quarantine, artifact.path).catch(() => undefined);
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
		if (!item.replaced) continue;
		const backupName = artifactName(item, item.backup);
		let restorePath: string | undefined;
		let restoreWritten = false;
		try {
			if (!(await stillOwned(fileSystem, item.backup)))
				throw new Error("backup_changed");
			const bytes = await fileSystem.readFile(item.backup.path);
			if (
				digest(bytes) !== item.edit.hash ||
				!(await stillOwned(fileSystem, item.backup))
			)
				throw new Error("backup_changed");
			restorePath = `${item.backup.path}.restore-${randomUUID()}`;
			await fileSystem.writeExclusive(restorePath, bytes, 0o600);
			restoreWritten = true;
			const restore = await ownedArtifact(fileSystem, restorePath);
			if (!restore || !(await stillOwned(fileSystem, restore)))
				throw new Error("restore_changed");
			await fileSystem.rename(restore.path, item.edit.path);
			await fileSystem.chmod(item.edit.path, item.edit.identity.mode & 0o777);
			item.replaced = false;
			if (backupName) recovery.delete(backupName);
		} catch {
			unrestored.add(item.edit.relativePath);
			if (backupName) recovery.add(backupName);
			if (restorePath && restoreWritten) {
				const restore = await ownedArtifact(fileSystem, restorePath);
				if (!restore) recovery.add(artifactPathName(item, restorePath));
				else {
					const restoreName = artifactName(item, restore);
					if (!(await discardOwned(fileSystem, restore)) && restoreName)
						recovery.add(restoreName);
				}
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
