import { appendFile, lstat, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AuditRecord {
	at: string;
	serverId: string;
	revision: string;
	phase: string;
	durationMs: number;
	result: "ready" | "failed" | "cancelled" | "timed_out";
}

const pendingByPath = new Map<string, Promise<void>>();

function boundedRecord(
	record: AuditRecord,
	maxBytes: number,
): string | undefined {
	let revision = record.revision;
	while (true) {
		const line = `${JSON.stringify({
			...record,
			revision,
			phase: revision === record.revision ? record.phase : "truncated",
		})}\n`;
		if (Buffer.byteLength(line) <= maxBytes) return line;
		if (revision.length === 0) return undefined;
		revision = revision.slice(0, Math.floor(revision.length / 2));
	}
}

async function assertSafeAuditPath(path: string): Promise<void> {
	try {
		if ((await lstat(path)).isSymbolicLink()) {
			throw new Error("Audit path is symbolic.");
		}
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** Appends one bounded record at a time per process. Cross-process rotation is best effort. */
export function appendAuditRecord(
	path: string,
	record: AuditRecord,
	maxBytes = 64 * 1024,
): Promise<void> {
	const previous = pendingByPath.get(path) ?? Promise.resolve();
	const next = previous.then(async () => {
		const line = boundedRecord(record, maxBytes);
		if (!line) return;
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await assertSafeAuditPath(path);
		const size = await stat(path)
			.then((entry) => entry.size)
			.catch(() => 0);
		if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
			const rotated = join(dirname(path), "install.audit.1.jsonl");
			try {
				await rename(path, rotated);
			} catch {
				return;
			}
		}
		await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
	});
	pendingByPath.set(path, next);
	return next.finally(() => {
		if (pendingByPath.get(path) === next) pendingByPath.delete(path);
	});
}
