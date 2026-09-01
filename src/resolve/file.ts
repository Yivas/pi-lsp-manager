import { lstat, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ResolvedFile, Result } from "../contracts.js";

const LANGUAGE_IDS: Readonly<Record<string, string>> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
};

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

/**
 * Canonicalizes existing paths before comparing them. Callers still revalidate
 * at each mutation or process boundary because filesystem changes can race this check.
 */
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

export async function resolveFile(
	cwd: string,
	inputPath: string,
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
	) {
		return { ok: false, code: "file_outside_workspace" };
	}
	let filePath: string;
	try {
		filePath = await realpath(requestedPath);
	} catch {
		return { ok: false, code: "file_not_found" };
	}
	if (!isWithin(workspacePath, filePath)) {
		return { ok: false, code: "file_outside_workspace" };
	}
	try {
		if (!(await lstat(filePath)).isFile()) {
			return { ok: false, code: "file_not_regular" };
		}
	} catch {
		return { ok: false, code: "file_not_found" };
	}
	const extension = extname(filePath).toLowerCase();
	const languageId = LANGUAGE_IDS[extension];
	if (!languageId) {
		return { ok: false, code: "unsupported_file" };
	}
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
