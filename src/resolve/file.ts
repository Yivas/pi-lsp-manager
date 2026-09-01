import { lstat, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { DEFAULT_SERVERS } from "../catalog/servers.js";
import type {
	EffectiveServerConfig,
	ResolvedFile,
	Result,
} from "../contracts.js";

const DEFAULT_EFFECTIVE_SERVERS = Object.fromEntries(
	DEFAULT_SERVERS.map((server) => [server.id, { ...server, enabled: true }]),
);

function isWithin(parent: string, child: string): boolean {
	const pathFromParent = relative(parent, child);
	return (
		pathFromParent === "" ||
		(pathFromParent !== ".." &&
			!pathFromParent.startsWith(`..${sep}`) &&
			!isAbsolute(pathFromParent))
	);
}
export function stripSingleAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}
/** Canonicalizes existing paths before comparing them; callers revalidate at each sink. */
export async function isCanonicalPathWithinWorkspace(
	workspacePath: string,
	candidatePath: string,
): Promise<boolean> {
	try {
		const [workspace, candidate] = await Promise.all([
			realpath(workspacePath),
			realpath(candidatePath),
		]);
		return isWithin(workspace, candidate);
	} catch {
		return false;
	}
}
export function languageIdForExtension(
	server: EffectiveServerConfig,
	extension: string,
): string {
	return (
		server.languageIdByExtension?.[extension] ??
		(server.languageIds.length === 1
			? (server.languageIds[0] ?? extension.slice(1))
			: extension.slice(1))
	);
}

function languageFor(
	extension: string,
	servers: Readonly<Record<string, EffectiveServerConfig>>,
): string | undefined {
	const candidates = Object.values(servers)
		.filter((server) => server.enabled && server.extensions.includes(extension))
		.sort(
			(left, right) =>
				right.priority - left.priority ||
				(left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
		);
	const server = candidates[0];
	return server ? languageIdForExtension(server, extension) : undefined;
}
export async function resolveFile(
	cwd: string,
	inputPath: string,
	servers: Readonly<
		Record<string, EffectiveServerConfig>
	> = DEFAULT_EFFECTIVE_SERVERS,
): Promise<Result<ResolvedFile>> {
	const lexicalWorkspacePath = resolve(cwd);
	let workspacePath: string;
	try {
		workspacePath = await realpath(lexicalWorkspacePath);
	} catch {
		return { ok: false, code: "file_not_found" };
	}
	const strippedInput = stripSingleAtPrefix(inputPath);
	const requestedPath = resolve(lexicalWorkspacePath, strippedInput);
	if (
		!isAbsolute(strippedInput) &&
		!isWithin(lexicalWorkspacePath, requestedPath)
	)
		return { ok: false, code: "file_outside_workspace" };
	let filePath: string;
	try {
		filePath = await realpath(requestedPath);
	} catch {
		return { ok: false, code: "file_not_found" };
	}
	if (!isWithin(workspacePath, filePath))
		return { ok: false, code: "file_outside_workspace" };
	try {
		if (!(await lstat(filePath)).isFile())
			return { ok: false, code: "file_not_regular" };
	} catch {
		return { ok: false, code: "file_not_found" };
	}
	const extension = extname(filePath).toLowerCase();
	const languageId = languageFor(extension, servers);
	if (!languageId) return { ok: false, code: "unsupported_file" };
	return {
		ok: true,
		value: {
			workspacePath,
			filePath,
			relativePath: relative(workspacePath, filePath),
			extension,
			languageId,
		},
	};
}
