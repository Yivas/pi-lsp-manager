import { lstat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { ResolvedFile, ResolvedTarget } from "../contracts.js";
import { isCanonicalPathWithinWorkspace } from "./file.js";

export const ROOT_MARKERS = [
	".git",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
] as const;

async function hasRootMarker(directory: string): Promise<boolean> {
	for (const marker of ROOT_MARKERS) {
		try {
			await lstat(join(directory, marker));
			return true;
		} catch {
			// A missing marker is the normal search path.
		}
	}
	return false;
}

export async function resolveRoot(file: ResolvedFile): Promise<ResolvedTarget> {
	if (
		!(await isCanonicalPathWithinWorkspace(file.workspacePath, file.filePath))
	) {
		return { ...file, rootPath: file.workspacePath };
	}
	let current = dirname(file.filePath);
	while (true) {
		if (await hasRootMarker(current)) {
			return { ...file, rootPath: current };
		}
		if (current === file.workspacePath) {
			return { ...file, rootPath: file.workspacePath };
		}
		const parent = dirname(current);
		const pathFromWorkspace = relative(file.workspacePath, parent);
		if (
			parent === current ||
			pathFromWorkspace === ".." ||
			pathFromWorkspace.startsWith(`..${sep}`)
		) {
			return { ...file, rootPath: file.workspacePath };
		}
		current = parent;
	}
}
