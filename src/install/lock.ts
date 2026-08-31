import { link, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface LockIdentity {
	pid: number;
	startedAt: number;
	nonce: string;
	serverId: string;
	revision: string;
}

export type LockAcquireResult =
	| { acquired: true; release(): Promise<void> }
	| {
			acquired: false;
			state: "waiting-lock" | "manual-repair";
			owner?: LockIdentity;
	  };

export interface LockFileSystem {
	open(
		path: string,
		flags: string,
		mode?: number,
	): Promise<{
		writeFile(value: string): Promise<void>;
		close(): Promise<void>;
	}>;
	readFile(path: string, encoding: "utf8"): Promise<string>;
	rename(from: string, to: string): Promise<void>;
	link(existingPath: string, newPath: string): Promise<void>;
	rm(path: string, options: { force: true }): Promise<void>;
}

const NODE_FILE_SYSTEM: LockFileSystem = { open, readFile, rename, link, rm };

function parseIdentity(text: string): LockIdentity | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return undefined;
		const candidate = value as Record<string, unknown>;
		if (
			typeof candidate.pid !== "number" ||
			!Number.isInteger(candidate.pid) ||
			typeof candidate.startedAt !== "number" ||
			typeof candidate.nonce !== "string" ||
			typeof candidate.serverId !== "string" ||
			typeof candidate.revision !== "string"
		)
			return undefined;
		return {
			pid: candidate.pid,
			startedAt: candidate.startedAt,
			nonce: candidate.nonce,
			serverId: candidate.serverId,
			revision: candidate.revision,
		} as LockIdentity;
	} catch {
		return undefined;
	}
}

function sameOwner(
	left: LockIdentity | undefined,
	right: LockIdentity,
): boolean {
	return (
		left?.nonce === right.nonce &&
		left.pid === right.pid &&
		left.startedAt === right.startedAt &&
		left.serverId === right.serverId &&
		left.revision === right.revision
	);
}

async function releaseOwnedLock(
	path: string,
	identity: LockIdentity,
	fileSystem: LockFileSystem,
): Promise<void> {
	const owner = parseIdentity(
		await fileSystem.readFile(path, "utf8").catch(() => ""),
	);
	if (!sameOwner(owner, identity)) return;
	// Move the owned lock away before deletion. Cooperative acquirers can only create
	// the public lock path after this atomic rename; cleanup never deletes that path.
	const tombstone = join(dirname(path), `.${identity.nonce}.released`);
	try {
		await fileSystem.rename(path, tombstone);
	} catch {
		return;
	}
	const movedOwner = parseIdentity(
		await fileSystem.readFile(tombstone, "utf8").catch(() => ""),
	);
	if (!sameOwner(movedOwner, identity)) {
		// A replacement won the race. Restore it without overwriting a third owner;
		// if that proof fails, retain the tombstone for manual repair.
		try {
			await fileSystem.link(tombstone, path);
			await fileSystem.rm(tombstone, { force: true });
		} catch {
			await fileSystem
				.rename(tombstone, `${tombstone}.manual-repair`)
				.catch(() => undefined);
		}
		return;
	}
	await fileSystem.rm(tombstone, { force: true }).catch(() => undefined);
}

export async function acquireLock(
	path: string,
	identity: LockIdentity,
	ownerIsAlive: (owner: LockIdentity) => Promise<boolean>,
	fileSystem: LockFileSystem = NODE_FILE_SYSTEM,
): Promise<LockAcquireResult> {
	try {
		const handle = await fileSystem.open(path, "wx", 0o600);
		try {
			await handle.writeFile(JSON.stringify(identity));
			await handle.close();
		} catch (error) {
			await handle.close().catch(() => undefined);
			await fileSystem.rm(path, { force: true }).catch(() => undefined);
			throw error;
		}
		return {
			acquired: true,
			release: () => releaseOwnedLock(path, identity, fileSystem),
		};
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const existingText = await fileSystem
		.readFile(path, "utf8")
		.catch(() => undefined);
	const owner = existingText ? parseIdentity(existingText) : undefined;
	if (!owner) return { acquired: false, state: "manual-repair" };
	// Do not reclaim dead locks with read/compare/unlink. A user can repair them;
	// conservative recovery cannot delete a replacement acquired by another process.
	if (!(await ownerIsAlive(owner)))
		return { acquired: false, state: "manual-repair", owner };
	return { acquired: false, state: "waiting-lock", owner };
}
