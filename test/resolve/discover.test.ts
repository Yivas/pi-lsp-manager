import {
	mkdtemp,
	mkdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverFiles, MAX_INPUT_PATHS } from "../../src/resolve/discover.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "pi-lsp-manager-discover-")),
	);
	temporaryDirectories.push(directory);
	return directory;
}

async function makeFile(
	root: string,
	path: string,
	content = "content\n",
): Promise<string> {
	const target = join(root, path);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, content);
	return target;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("pure file discovery", () => {
	it("discovers an explicit regular file with canonical metadata", async () => {
		const workspace = await fixture();
		const file = await makeFile(workspace, "src/example.ts");

		const result = await discoverFiles({
			workspacePath: workspace,
			paths: ["src/example.ts"],
		});

		expect(result).toMatchObject({
			files: [
				{
					filePath: file,
					relativePath: join("src", "example.ts"),
					size: 8,
				},
			],
			filesAccepted: 1,
			entriesInspected: 1,
			truncated: false,
		});
	});

	it("recursively discovers an explicit directory and an implicit root", async () => {
		const workspace = await fixture();
		await makeFile(workspace, "src/a.ts");
		await makeFile(workspace, "nested/b.ts");

		const explicit = await discoverFiles({
			workspacePath: workspace,
			paths: ["src"],
		});
		const implicit = await discoverFiles({ workspacePath: workspace });

		expect(explicit.files.map((file) => file.relativePath)).toEqual([
			join("src", "a.ts"),
		]);
		expect(implicit.files.map((file) => file.relativePath)).toEqual([
			join("nested", "b.ts"),
			join("src", "a.ts"),
		]);
	});

	it("uses canonical path order, independent of creation order", async () => {
		const workspace = await fixture();
		await makeFile(workspace, "z/file.ts");
		await makeFile(workspace, "a/file.ts");
		await makeFile(workspace, "m.ts");

		const result = await discoverFiles(workspace);

		expect(result.files.map((file) => file.relativePath)).toEqual([
			join("a", "file.ts"),
			"m.ts",
			join("z", "file.ts"),
		]);
	});

	it("applies default and configured directory exclusions", async () => {
		const workspace = await fixture();
		await makeFile(workspace, "node_modules/dependency.ts");
		await makeFile(workspace, ".git/index.ts");
		await makeFile(workspace, "generated/output.ts");
		await makeFile(workspace, "src/source.ts");

		const result = await discoverFiles({
			workspacePath: workspace,
			excludeDirectories: ["generated"],
		});

		expect(result.files.map((file) => file.relativePath)).toEqual([
			join("src", "source.ts"),
		]);
		expect(
			result.omissions
				.filter((omission) => omission.reason === "directory_excluded")
				.map((omission) => omission.relativePath),
		).toEqual([".git", "generated", "node_modules"]);
	});

	it("traverses an omitted directory when it is explicitly supplied", async () => {
		const workspace = await fixture();
		await makeFile(workspace, "node_modules/package/index.ts");

		const result = await discoverFiles({
			workspacePath: workspace,
			paths: ["node_modules"],
		});

		expect(result.files.map((file) => file.relativePath)).toEqual([
			join("node_modules", "package", "index.ts"),
		]);
	});

	it("rejects lexical and canonical escapes", async () => {
		const workspace = await fixture();
		const outside = await fixture();
		const outsideFile = await makeFile(outside, "outside.ts");
		await symlink(outsideFile, join(workspace, "external.ts"));

		const result = await discoverFiles({
			workspacePath: workspace,
			paths: ["../outside.ts", "external.ts"],
		});

		expect(result.files).toEqual([]);
		expect(result.omissions.map((omission) => omission.reason)).toEqual([
			"outside_workspace",
			"symlink",
		]);
	});

	it("does not follow symlinked files, directories, or cycles", async () => {
		const workspace = await fixture();
		await makeFile(workspace, "real/file.ts");
		await symlink(
			join(workspace, "real", "file.ts"),
			join(workspace, "link.ts"),
		);
		await symlink(
			join(workspace, "real"),
			join(workspace, "linked-directory"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await symlink(
			workspace,
			join(workspace, "real", "cycle"),
			process.platform === "win32" ? "junction" : "dir",
		);

		const result = await discoverFiles({ workspacePath: workspace });

		expect(result.files.map((file) => file.relativePath)).toEqual([
			join("real", "file.ts"),
		]);
		expect(
			result.omissions.filter((omission) => omission.reason === "symlink"),
		).toHaveLength(3);
	});

	it("omits missing, directory, and non-regular inputs", async () => {
		const workspace = await fixture();
		await mkdir(join(workspace, "directory"));
		const result = await discoverFiles({
			workspacePath: workspace,
			paths: ["missing.ts", "directory"],
		});

		expect(result.files).toEqual([]);
		expect(result.omissions.map((omission) => omission.reason)).toEqual([
			"missing",
		]);
		expect(result.entriesInspected).toBe(2);
	});

	it("reports file and filesystem-entry truncation separately from results", async () => {
		const workspace = await fixture();
		await makeFile(workspace, "a.ts");
		await makeFile(workspace, "b.ts");
		await makeFile(workspace, "c.ts");

		const fileLimited = await discoverFiles({
			workspacePath: workspace,
			fileLimit: 1,
		});
		const entryLimited = await discoverFiles({
			workspacePath: workspace,
			maxEntries: 2,
		});

		expect(fileLimited.files).toHaveLength(1);
		expect(fileLimited.truncated).toBe(true);
		expect(entryLimited.entriesInspected).toBe(2);
		expect(entryLimited.files.length).toBeLessThan(3);
		expect(entryLimited.truncated).toBe(true);
	});

	it("tracks document size and does not accept oversized files", async () => {
		const workspace = await fixture();
		await makeFile(workspace, "small.ts", "1234");
		await makeFile(workspace, "large.ts", "12345");

		const result = await discoverFiles({
			workspacePath: workspace,
			maxDocumentBytes: 4,
		});

		expect(result.files.map((file) => [file.relativePath, file.size])).toEqual([
			["small.ts", 4],
		]);
		expect(result.omissions).toContainEqual(
			expect.objectContaining({
				relativePath: "large.ts",
				reason: "file_too_large",
			}),
		);
	});

	it("stops before filesystem work when cancelled", async () => {
		const workspace = await fixture();
		await makeFile(workspace, "source.ts");
		const controller = new AbortController();
		controller.abort();

		await expect(
			discoverFiles({ workspacePath: workspace, signal: controller.signal }),
		).resolves.toMatchObject({
			files: [],
			entriesInspected: 0,
			cancelled: true,
			truncated: true,
		});
	});

	it("bounds the number of explicit input paths", async () => {
		const workspace = await fixture();
		const paths = await Promise.all(
			Array.from({ length: MAX_INPUT_PATHS + 1 }, (_, index) =>
				makeFile(workspace, `file-${index}.ts`),
			),
		);
		const result = await discoverFiles({
			workspacePath: workspace,
			paths: paths.map((path) => path.slice(workspace.length + 1)),
		});

		expect(result.files).toHaveLength(MAX_INPUT_PATHS);
		expect(result.truncated).toBe(true);
	});
});
