import { lstat, readdir, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_INPUT_PATHS = 32;
export const MAX_FILESYSTEM_ENTRIES = 10_000;
export const MAX_ACCEPTED_FILES = 100;
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_FILE_LIMIT = 100;

export const DEFAULT_EXCLUDED_DIRECTORIES = [
	".git",
	".hg",
	".svn",
	"node_modules",
	"bower_components",
	"vendor",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".nyc_output",
	".cache",
	".parcel-cache",
	".turbo",
	".next",
	".nuxt",
	"tmp",
	"temp",
	".tmp",
	".venv",
	"venv",
	"env",
	".env",
	"__pycache__",
	".tox",
	".gradle",
] as const;

const DEFAULT_EXCLUSIONS = new Set(DEFAULT_EXCLUDED_DIRECTORIES);

export type OmissionReason =
	| "outside_workspace"
	| "missing"
	| "symlink"
	| "non_regular"
	| "directory_excluded"
	| "file_too_large"
	| "filesystem_limit"
	| "cancelled";

export interface DiscoveryFile {
	filePath: string;
	relativePath: string;
	size: number;
}

export interface DiscoveryOmission {
	path: string;
	relativePath?: string;
	reason: OmissionReason;
}

export interface DiscoveryResult {
	files: readonly DiscoveryFile[];
	entriesInspected: number;
	filesInspected: number;
	filesAccepted: number;
	truncated: boolean;
	cancelled: boolean;
	omissions: readonly DiscoveryOmission[];
}

export interface DiscoverOptions {
	workspacePath: string;
	paths?: readonly string[];
	excludeDirectories?: readonly string[];
	fileLimit?: number;
	maxEntries?: number;
	maxDocumentBytes?: number;
	signal?: AbortSignal;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(parent: string, child: string): boolean {
	const pathFromParent = relative(parent, child);
	return (
		pathFromParent === "" ||
		(pathFromParent !== ".." &&
			!pathFromParent.startsWith(`..${sep}`) &&
			!isAbsolute(pathFromParent))
	);
}

function isWindows(): boolean {
	return process.platform === "win32";
}

function directoryKey(name: string): string {
	return isWindows() ? name.toLowerCase() : name;
}

function exclusionNames(
	names: readonly string[] | undefined,
): ReadonlySet<string> {
	const values = new Set<string>();
	for (const name of DEFAULT_EXCLUSIONS) values.add(directoryKey(name));
	for (const name of names ?? []) {
		if (
			typeof name === "string" &&
			name.length > 0 &&
			!name.includes("/") &&
			!name.includes("\\") &&
			!name.includes("\u0000")
		)
			values.add(directoryKey(name));
	}
	return values;
}

function boundedInteger(
	value: number | undefined,
	fallback: number,
	maximum: number,
	minimum = 0,
): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function relativePath(workspacePath: string, filePath: string): string {
	return relative(workspacePath, filePath);
}

function addOmission(
	omissions: DiscoveryOmission[],
	path: string,
	reason: OmissionReason,
	workspacePath: string,
): void {
	const relativePathValue = isWithin(workspacePath, path)
		? relativePath(workspacePath, path)
		: undefined;
	omissions.push({
		path,
		...(relativePathValue !== undefined
			? { relativePath: relativePathValue }
			: {}),
		reason,
	});
}

async function hasSymlinkComponent(
	workspacePath: string,
	candidatePath: string,
	signal: AbortSignal | undefined,
): Promise<boolean | "cancelled"> {
	const suffix = relative(workspacePath, candidatePath);
	if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`))
		return false;
	let current = workspacePath;
	for (const component of suffix.split(sep)) {
		if (signal?.aborted) return "cancelled";
		current = resolve(current, component);
		try {
			if ((await lstat(current)).isSymbolicLink()) return true;
		} catch {
			return false;
		}
	}
	return false;
}

interface DiscoveryState {
	readonly workspacePath: string;
	readonly workspaceLexicalPath: string;
	readonly exclusions: ReadonlySet<string>;
	readonly fileLimit: number;
	readonly maxEntries: number;
	readonly maxDocumentBytes: number;
	readonly signal: AbortSignal | undefined;
	readonly files: Map<string, DiscoveryFile>;
	readonly omissions: DiscoveryOmission[];
	entriesInspected: number;
	filesInspected: number;
	truncated: boolean;
	cancelled: boolean;
}

function stopped(state: DiscoveryState): boolean {
	if (state.cancelled || state.truncated) return true;
	if (state.signal?.aborted) {
		state.cancelled = true;
		state.truncated = true;
		return true;
	}
	if (state.files.size >= state.fileLimit) {
		state.truncated = true;
		return true;
	}
	return false;
}

function inspectEntry(state: DiscoveryState): boolean {
	if (stopped(state)) return false;
	if (state.entriesInspected >= state.maxEntries) {
		state.truncated = true;
		return false;
	}
	state.entriesInspected += 1;
	return true;
}

async function inspectPath(
	state: DiscoveryState,
	path: string,
	explicitRoot: boolean,
): Promise<void> {
	if (stopped(state)) return;
	const symlink = await hasSymlinkComponent(
		state.workspaceLexicalPath,
		path,
		state.signal,
	);
	if (symlink === "cancelled") {
		state.cancelled = true;
		state.truncated = true;
		return;
	}
	if (symlink) {
		addOmission(state.omissions, path, "symlink", state.workspacePath);
		return;
	}
	if (state.signal?.aborted) {
		state.cancelled = true;
		state.truncated = true;
		return;
	}
	if (!isWithin(state.workspaceLexicalPath, path)) {
		addOmission(
			state.omissions,
			path,
			"outside_workspace",
			state.workspacePath,
		);
		return;
	}
	if (!inspectEntry(state)) return;
	let status: Awaited<ReturnType<typeof lstat>>;
	try {
		status = await lstat(path);
	} catch {
		addOmission(state.omissions, path, "missing", state.workspacePath);
		return;
	}
	if (status.isSymbolicLink()) {
		addOmission(state.omissions, path, "symlink", state.workspacePath);
		return;
	}
	let canonicalPath: string;
	try {
		canonicalPath = await realpath(path);
	} catch {
		addOmission(state.omissions, path, "missing", state.workspacePath);
		return;
	}
	if (!isWithin(state.workspacePath, canonicalPath)) {
		addOmission(
			state.omissions,
			canonicalPath,
			"outside_workspace",
			state.workspacePath,
		);
		return;
	}
	if (status.isDirectory()) {
		await inspectDirectory(state, path, canonicalPath, explicitRoot);
		return;
	}
	if (!status.isFile()) {
		addOmission(
			state.omissions,
			canonicalPath,
			"non_regular",
			state.workspacePath,
		);
		return;
	}
	state.filesInspected += 1;
	if (status.size > state.maxDocumentBytes) {
		addOmission(
			state.omissions,
			canonicalPath,
			"file_too_large",
			state.workspacePath,
		);
		return;
	}
	if (state.files.has(canonicalPath)) return;
	state.files.set(canonicalPath, {
		filePath: canonicalPath,
		relativePath: relativePath(state.workspacePath, canonicalPath),
		size: status.size,
	});
}

async function inspectDirectory(
	state: DiscoveryState,
	lexicalPath: string,
	canonicalPath: string,
	explicitRoot: boolean,
): Promise<void> {
	if (stopped(state)) return;
	let entries: Dirent<string>[];
	try {
		entries = await readdir(lexicalPath, {
			withFileTypes: true,
			encoding: "utf8",
		});
	} catch {
		return;
	}
	if (state.signal?.aborted) {
		state.cancelled = true;
		state.truncated = true;
		return;
	}
	const sortedEntries = entries.sort((left, right) =>
		compareText(
			resolve(lexicalPath, left.name),
			resolve(lexicalPath, right.name),
		),
	);
	for (const entry of sortedEntries) {
		if (stopped(state)) return;
		const childPath = resolve(lexicalPath, entry.name);
		if (!explicitRoot && state.exclusions.has(directoryKey(entry.name))) {
			if (!inspectEntry(state)) return;
			addOmission(
				state.omissions,
				resolve(canonicalPath, entry.name),
				"directory_excluded",
				state.workspacePath,
			);
			continue;
		}
		await inspectPath(state, childPath, false);
	}
}

async function discoverWithOptions(
	options: DiscoverOptions,
): Promise<DiscoveryResult> {
	const signal = options.signal;
	const empty = (): DiscoveryResult => ({
		files: [],
		entriesInspected: 0,
		filesInspected: 0,
		filesAccepted: 0,
		truncated: Boolean(signal?.aborted),
		cancelled: Boolean(signal?.aborted),
		omissions: [],
	});
	if (signal?.aborted) return empty();
	const workspaceLexicalPath = resolve(options.workspacePath);
	let workspacePath: string;
	try {
		workspacePath = await realpath(workspaceLexicalPath);
		const workspaceStatus = await lstat(workspacePath);
		if (!workspaceStatus.isDirectory()) return empty();
	} catch {
		return empty();
	}
	if (signal?.aborted) return empty();
	const fileLimit = boundedInteger(
		options.fileLimit,
		DEFAULT_FILE_LIMIT,
		MAX_ACCEPTED_FILES,
		1,
	);
	const maxEntries = boundedInteger(
		options.maxEntries,
		MAX_FILESYSTEM_ENTRIES,
		MAX_FILESYSTEM_ENTRIES,
		1,
	);
	const maxDocumentBytes = boundedInteger(
		options.maxDocumentBytes,
		MAX_DOCUMENT_BYTES,
		MAX_DOCUMENT_BYTES,
	);
	const state: DiscoveryState = {
		workspacePath,
		workspaceLexicalPath,
		exclusions: exclusionNames(options.excludeDirectories),
		fileLimit,
		maxEntries,
		maxDocumentBytes,
		signal,
		files: new Map(),
		omissions: [],
		entriesInspected: 0,
		filesInspected: 0,
		truncated: false,
		cancelled: false,
	};
	const hasExplicitPaths = options.paths !== undefined;
	const requestedPaths = options.paths ?? ["."];
	const paths = requestedPaths.slice(0, MAX_INPUT_PATHS);
	const inputPathsTruncated = requestedPaths.length > MAX_INPUT_PATHS;
	for (const requestedPath of paths) {
		if (stopped(state)) break;
		const lexicalPath = resolve(workspaceLexicalPath, requestedPath);
		if (!isWithin(workspaceLexicalPath, lexicalPath)) {
			addOmission(
				state.omissions,
				lexicalPath,
				"outside_workspace",
				state.workspacePath,
			);
			continue;
		}
		await inspectPath(state, lexicalPath, hasExplicitPaths);
	}
	if (inputPathsTruncated) state.truncated = true;
	if (signal?.aborted) {
		state.cancelled = true;
		state.truncated = true;
	}
	const files = [...state.files.values()].sort((left, right) =>
		compareText(left.filePath, right.filePath),
	);
	return {
		files,
		entriesInspected: state.entriesInspected,
		filesInspected: state.filesInspected,
		filesAccepted: files.length,
		truncated: state.truncated,
		cancelled: state.cancelled,
		omissions: state.omissions,
	};
}

export function discoverFiles(
	options: DiscoverOptions,
): Promise<DiscoveryResult>;
export function discoverFiles(
	workspacePath: string,
	paths?: readonly string[],
	options?: Omit<DiscoverOptions, "workspacePath" | "paths">,
): Promise<DiscoveryResult>;
export function discoverFiles(
	workspaceOrOptions: string | DiscoverOptions,
	paths: readonly string[] = ["."],
	options: Omit<DiscoverOptions, "workspacePath" | "paths"> = {},
): Promise<DiscoveryResult> {
	return typeof workspaceOrOptions === "string"
		? discoverWithOptions({
				workspacePath: workspaceOrOptions,
				paths,
				...options,
			})
		: discoverWithOptions(workspaceOrOptions);
}

export const discover = discoverFiles;
