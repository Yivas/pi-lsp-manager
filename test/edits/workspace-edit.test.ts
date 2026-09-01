import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyValidatedEdits } from "../../src/edits/apply.js";
import {
	applyOffsetEdits,
	offsetEdits,
	utf16Offset,
} from "../../src/edits/offsets.js";
import { normalizeWorkspaceEdit } from "../../src/edits/normalize.js";
import { validateWorkspaceEdit } from "../../src/edits/validate.js";
import { afterEach, describe, expect, it } from "vitest";

const range = (line: number, start: number, end: number) => ({
	start: { line, character: start },
	end: { line, character: end },
});

describe("validated workspace edits", () => {
	let workspace: string | undefined;
	let outside: string | undefined;
	afterEach(async () => {
		if (workspace) await rm(workspace, { recursive: true, force: true });
		if (outside) await rm(outside, { recursive: true, force: true });
		workspace = undefined;
		outside = undefined;
	});
	async function setup() {
		workspace = await mkdtemp(join(tmpdir(), "pi-lsp-edits-"));
		const first = join(workspace, "first.ts");
		const second = join(workspace, "second.ts");
		await writeFile(first, "😀foo\r\nbar\r\n", "utf8");
		await writeFile(second, "second\n", "utf8");
		return { first, second };
	}

	it("normalizes both forms and rejects mixed/resource/malformed forms", () => {
		const uri = "file:///workspace/a.ts";
		expect(
			normalizeWorkspaceEdit({
				changes: { [uri]: [{ range: range(0, 0, 1), newText: "x" }] },
			}),
		).toBeTruthy();
		expect(
			normalizeWorkspaceEdit({
				documentChanges: [
					{
						textDocument: { uri, version: 1 },
						edits: [{ range: range(0, 0, 1), newText: "x" }],
					},
				],
			}),
		).toBeTruthy();
		expect(
			normalizeWorkspaceEdit({
				documentChanges: [
					{
						textDocument: { uri, version: null },
						edits: [{ range: range(0, 0, 1), newText: "x" }],
					},
				],
			}),
		).toMatchObject({ documents: [{ uri }] });
		for (const value of [
			{ changes: {}, documentChanges: [] },
			{ documentChanges: [{ kind: "create", uri }] },
			{ documentChanges: [{ kind: "rename", oldUri: uri, newUri: uri }] },
			{ documentChanges: [{ kind: "delete", uri }] },
			{ changes: { [uri]: [{ range: range(0, 0, 1) }] } },
			{ changes: { [uri]: [] } },
		])
			expect(normalizeWorkspaceEdit(value)).toBeUndefined();
	});

	it("validates UTF-16/CRLF offsets and applies descending multi-file edits", async () => {
		const { first, second } = await setup();
		const firstUri = pathToFileURL(first).href;
		const secondUri = pathToFileURL(second).href;
		const normalized = normalizeWorkspaceEdit({
			changes: {
				[firstUri]: [
					{ range: range(0, 2, 5), newText: "ONE" },
					{ range: range(1, 0, 3), newText: "TWO" },
				],
				[secondUri]: [{ range: range(0, 0, 6), newText: "third" }],
			},
		});
		if (!normalized || !workspace) throw new Error("Expected normalized edit.");
		const validated = await validateWorkspaceEdit(normalized, {
			workspacePath: workspace,
		});
		if (!validated) throw new Error("Expected validated edit.");
		const result = await applyValidatedEdits(validated);
		expect(result).toMatchObject({ status: "applied", editCount: 3 });
		expect(await readFile(first, "utf8")).toBe("😀ONE\r\nTWO\r\n");
		expect(await readFile(second, "utf8")).toBe("third\n");
		expect(utf16Offset("😀x\r\n", { line: 0, character: 1 })).toBeUndefined();
		expect(
			offsetEdits("😀x\r\n", [{ range: range(0, 1, 2), newText: "z" }]),
		).toBeUndefined();
		expect(
			applyOffsetEdits("abcdef", [
				{ start: 4, end: 6, newText: "X" },
				{ start: 0, end: 2, newText: "Y" },
			]),
		).toBe("YcdX");
	});

	it("rejects external schemes, authorities, symlink escape, duplicate canonical files, versions, and overlaps without writes", async () => {
		const { first } = await setup();
		if (!workspace) throw new Error("Expected workspace.");
		outside = await mkdtemp(join(tmpdir(), "pi-lsp-outside-"));
		const secret = join(outside, "secret.ts");
		await writeFile(secret, "secret\n");
		const link = join(workspace, "link.ts");
		await symlink(secret, link);
		const before = await readFile(first);
		const badUris = [
			"https://example.test/a.ts",
			"file://host/tmp/a.ts",
			pathToFileURL(link).href,
		];
		for (const uri of badUris) {
			const edit = normalizeWorkspaceEdit({
				changes: { [uri]: [{ range: range(0, 0, 1), newText: "x" }] },
			});
			expect(
				edit &&
					(await validateWorkspaceEdit(edit, { workspacePath: workspace })),
			).toBeUndefined();
		}
		const uri = pathToFileURL(first).href;
		const internalAlias = join(workspace, "alias.ts");
		await symlink(first, internalAlias);
		const duplicate = normalizeWorkspaceEdit({
			documentChanges: [
				{
					textDocument: { uri },
					edits: [{ range: range(0, 0, 1), newText: "x" }],
				},
				{
					textDocument: { uri: pathToFileURL(internalAlias).href },
					edits: [{ range: range(0, 1, 2), newText: "y" }],
				},
			],
		});
		expect(
			duplicate &&
				(await validateWorkspaceEdit(duplicate, { workspacePath: workspace })),
		).toBeUndefined();
		const overlap = normalizeWorkspaceEdit({
			changes: {
				[uri]: [
					{ range: range(0, 0, 3), newText: "x" },
					{ range: range(0, 2, 4), newText: "y" },
				],
			},
		});
		expect(
			overlap &&
				(await validateWorkspaceEdit(overlap, { workspacePath: workspace })),
		).toBeUndefined();
		const sameInsert = normalizeWorkspaceEdit({
			changes: {
				[uri]: [
					{ range: range(0, 1, 1), newText: "x" },
					{ range: range(0, 1, 1), newText: "y" },
				],
			},
		});
		expect(
			sameInsert &&
				(await validateWorkspaceEdit(sameInsert, { workspacePath: workspace })),
		).toBeUndefined();
		const versioned = normalizeWorkspaceEdit({
			documentChanges: [
				{
					textDocument: { uri, version: 2 },
					edits: [{ range: range(0, 0, 1), newText: "x" }],
				},
			],
		});
		expect(
			versioned &&
				(await validateWorkspaceEdit(versioned, {
					workspacePath: workspace,
					versions: new Map([[uri, 1]]),
				})),
		).toBeUndefined();
		const missing = normalizeWorkspaceEdit({
			changes: {
				[pathToFileURL(join(workspace, "missing.ts")).href]: [
					{ range: range(0, 0, 0), newText: "x" },
				],
			},
		});
		expect(
			missing &&
				(await validateWorkspaceEdit(missing, { workspacePath: workspace })),
		).toBeUndefined();
		const expectedMismatch = normalizeWorkspaceEdit({
			changes: { [uri]: [{ range: range(0, 0, 1), newText: "x" }] },
		});
		expect(
			expectedMismatch &&
				(await validateWorkspaceEdit(expectedMismatch, {
					workspacePath: workspace,
					expectedHashes: new Map([[uri, "not-the-file-hash"]]),
				})),
		).toBeUndefined();
		expect(await readFile(first)).toEqual(before);
	});
});
