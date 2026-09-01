import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOffsetEdits, offsetEdits, type OffsetEdit } from "./offsets.js";
import type { NormalizedWorkspaceEdit } from "./normalize.js";

export interface FileIdentity {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	mode: number;
}
export interface ValidatedFileEdit {
	path: string;
	parentPath: string;
	relativePath: string;
	text: string;
	bytes: Buffer;
	hash: string;
	identity: FileIdentity;
	version?: number;
	edits: readonly OffsetEdit[];
	output: string;
}
export interface ValidationLimits {
	maxFiles?: number;
	maxEdits?: number;
	maxBytesPerFile?: number;
	maxReplacementBytes?: number;
	maxOutputBytes?: number;
	maxAggregateOutputBytes?: number;
}
export interface ValidationOptions {
	workspacePath: string;
	/** Numeric TextDocumentEdit versions must have this exact open-document snapshot. */
	versions?: ReadonlyMap<string, number>;
	/**
	 * Main documents bind their WorkspaceEdit to the exact bytes sent to the server.
	 * Unversioned secondary edits have no LSP document snapshot in v1: we snapshot
	 * immediately after the response and revalidate under every mutation queue.
	 */
	expectedHashes?: ReadonlyMap<string, string>;
	/** Canonical path bindings prevent equivalent URI spellings bypassing a hash. */
	expectedFileHashes?: ReadonlyMap<string, string>;
	limits?: ValidationLimits;
}
const defaults: Required<ValidationLimits> = {
	maxFiles: 64,
	maxEdits: 4_096,
	maxBytesPerFile: 4 * 1024 * 1024,
	maxReplacementBytes: 2 * 1024 * 1024,
	maxOutputBytes: 6 * 1024 * 1024,
	maxAggregateOutputBytes: 32 * 1024 * 1024,
};
function within(parent: string, child: string): boolean {
	const value = relative(parent, child);
	return (
		value !== "" &&
		value !== ".." &&
		!value.startsWith(`..${sep}`) &&
		!isAbsolute(value)
	);
}
export function digest(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}
function identity(value: Awaited<ReturnType<typeof stat>>): FileIdentity {
	return {
		dev: Number(value.dev),
		ino: Number(value.ino),
		size: Number(value.size),
		mtimeMs: Number(value.mtimeMs),
		mode: Number(value.mode),
	};
}
export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.mode === right.mode
	);
}
function safeFileUri(uri: string): string | undefined {
	try {
		const parsed = new URL(uri);
		if (
			parsed.protocol !== "file:" ||
			parsed.username ||
			parsed.password ||
			parsed.host
		)
			return undefined;
		return fileURLToPath(parsed);
	} catch {
		return undefined;
	}
}

/** Resolves all inputs before producing output, so every validation failure writes zero target bytes. */
export async function validateWorkspaceEdit(
	edit: NormalizedWorkspaceEdit,
	options: ValidationOptions,
): Promise<readonly ValidatedFileEdit[] | undefined> {
	const limits = { ...defaults, ...options.limits };
	if (edit.documents.length === 0 || edit.documents.length > limits.maxFiles)
		return undefined;
	let workspace: string;
	try {
		workspace = await realpath(options.workspacePath);
	} catch {
		return undefined;
	}
	const seen = new Set<string>();
	let editCount = 0;
	let replacementBytes = 0;
	let aggregateOutput = 0;
	const values: ValidatedFileEdit[] = [];
	for (const document of edit.documents) {
		const rawPath = safeFileUri(document.uri);
		if (!rawPath) return undefined;
		if (
			document.version !== undefined &&
			options.versions?.get(document.uri) !== document.version
		)
			return undefined;
		let path: string;
		let parentPath: string;
		try {
			path = await realpath(rawPath);
			parentPath = await realpath(dirname(path));
			const link = await lstat(path);
			if (
				!link.isFile() ||
				!within(workspace, path) ||
				(parentPath !== workspace && !within(workspace, parentPath))
			)
				return undefined;
		} catch {
			return undefined;
		}
		if (seen.has(path)) return undefined;
		seen.add(path);
		editCount += document.edits.length;
		if (editCount > limits.maxEdits) return undefined;
		replacementBytes += document.edits.reduce(
			(total, item) => total + Buffer.byteLength(item.newText, "utf8"),
			0,
		);
		if (replacementBytes > limits.maxReplacementBytes) return undefined;
		let before: Awaited<ReturnType<typeof stat>>;
		let bytes: Buffer;
		let after: Awaited<ReturnType<typeof stat>>;
		try {
			before = await stat(path);
			if (!before.isFile() || before.size > limits.maxBytesPerFile)
				return undefined;
			bytes = await readFile(path);
			after = await stat(path);
		} catch {
			return undefined;
		}
		if (!sameIdentity(identity(before), identity(after))) return undefined;
		const text = bytes.toString("utf8");
		if (!Buffer.from(text, "utf8").equals(bytes)) return undefined;
		const hash = digest(bytes);
		const expectedHash =
			options.expectedFileHashes?.get(path) ??
			options.expectedHashes?.get(document.uri);
		if (expectedHash !== undefined && expectedHash !== hash) return undefined;
		const edits = offsetEdits(text, document.edits);
		if (!edits) return undefined;
		const output = applyOffsetEdits(text, edits);
		const outputBytes = Buffer.byteLength(output, "utf8");
		if (outputBytes > limits.maxOutputBytes) return undefined;
		aggregateOutput += outputBytes;
		if (aggregateOutput > limits.maxAggregateOutputBytes) return undefined;
		values.push({
			path,
			parentPath,
			relativePath: relative(workspace, path),
			text,
			bytes,
			hash,
			identity: identity(after),
			...(document.version === undefined ? {} : { version: document.version }),
			edits,
			output,
		});
	}
	return values.sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
}

/** Rechecks target bytes, identity and canonical parent after all host queues are held. */
export async function revalidateFile(
	edit: ValidatedFileEdit,
): Promise<boolean> {
	try {
		if ((await realpath(dirname(edit.path))) !== edit.parentPath) return false;
		const metadata = await stat(edit.path);
		if (!metadata.isFile() || !sameIdentity(edit.identity, identity(metadata)))
			return false;
		return digest(await readFile(edit.path)) === edit.hash;
	} catch {
		return false;
	}
}
