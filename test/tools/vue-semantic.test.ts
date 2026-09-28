import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapVueRenameEdits } from "../../src/protocol/vue-tsserver.js";
import { definition } from "../../src/tools/definition.js";
import { prepareRename } from "../../src/tools/prepare-rename.js";
import { references } from "../../src/tools/references.js";
import { rename } from "../../src/tools/rename.js";
import type { TrustedOperationService } from "../../src/tools/shared.js";

const ctx = {} as ExtensionContext;
const source = "alpha\n";
const range = {
	start: { line: 0, character: 0 },
	end: { line: 0, character: 5 },
};

function text(result: { content: readonly { type: string; text?: string }[] }) {
	const item = result.content.find((value) => value.type === "text");
	if (!item?.text) throw new Error("Expected a text result.");
	return JSON.parse(item.text) as Record<string, unknown>;
}

function harness(
	rootPath: string,
	filePath: string,
	lspValue: unknown,
	serverId = "vue",
) {
	const uri = pathToFileURL(filePath).href;
	const location = { uri, range };
	const request = vi.fn(async (_method: string) => ({
		ok: true as const,
		value: lspValue,
	}));
	const vueDefinition = vi.fn(async () => [location]);
	const vueReferences = vi.fn(async () => [location]);
	const vueRename = vi.fn(
		async (
			_file: string,
			_text: string,
			_position: { line: number; character: number },
			_newName: string,
		): Promise<{ range: typeof range; edit: unknown }> => ({
			range,
			edit: null,
		}),
	);
	const operation = {
		target: { rootPath, workspacePath: rootPath, filePath },
		uri,
		server: { id: serverId },
		runtime: {
			connection: { request },
			session: {
				capabilities: {
					definitionProvider: true,
					referencesProvider: true,
					renameProvider: { prepareProvider: true },
				},
				documents: { get: () => ({ version: 1, text: source }) },
			},
			vueDefinition,
			vueReferences,
			vueRename,
		},
	};
	const read = vi.fn(
		async (
			_ctx: unknown,
			_path: unknown,
			_role: unknown,
			work: (value: typeof operation) => Promise<unknown>,
		) => work(operation),
	);
	const withFile = vi.fn(
		async (
			_ctx: unknown,
			_path: unknown,
			_role: unknown,
			_origin: unknown,
			work: (value: typeof operation) => Promise<unknown>,
		) => work(operation),
	);
	const service = { read, withFile } as unknown as TrustedOperationService;
	return {
		service,
		read,
		withFile,
		request,
		vueDefinition,
		vueReferences,
		vueRename,
		location,
	};
}

describe("Vue semantic fallback boundaries", () => {
	let rootPath = "";
	let filePath = "";

	afterEach(async () => {
		if (rootPath) await rm(rootPath, { recursive: true, force: true });
		rootPath = "";
		filePath = "";
	});

	async function workspace() {
		rootPath = await mkdtemp(join(tmpdir(), "pi-vue-tools-"));
		filePath = join(rootPath, "Component.vue");
		await writeFile(filePath, source);
	}

	it.each(["definition", "references"] as const)(
		"uses the Vue fallback for empty %s, not for an LSP location",
		async (tool) => {
			await workspace();
			const input = { filePath, line: 1, character: 0 };
			const run = (service: TrustedOperationService) =>
				tool === "definition"
					? definition(service, ctx, input, undefined)
					: references(service, ctx, input, undefined);
			const empty = harness(rootPath, filePath, []);
			const fallback = await run(empty.service);
			expect(fallback.details?.code).toBe("ok");
			expect(
				text(fallback)[tool === "definition" ? "definitions" : "references"],
			).toEqual([{ path: "Component.vue", line: 1, character: 0 }]);
			expect(
				tool === "definition" ? empty.vueDefinition : empty.vueReferences,
			).toHaveBeenCalledTimes(1);
			expect(empty.read).toHaveBeenCalledWith(
				ctx,
				filePath,
				"semantic",
				expect.any(Function),
				undefined,
			);
			if (tool === "definition") {
				expect(empty.vueDefinition).toHaveBeenCalledWith(
					filePath,
					source,
					{ line: 0, character: 0 },
					undefined,
				);
			} else {
				expect(empty.vueReferences).toHaveBeenCalledWith(
					filePath,
					source,
					{ line: 0, character: 0 },
					false,
					undefined,
				);
			}
			const populated = harness(rootPath, filePath, [empty.location]);
			const direct = await run(populated.service);
			expect(
				text(direct)[tool === "definition" ? "definitions" : "references"],
			).toEqual([{ path: "Component.vue", line: 1, character: 0 }]);
			expect(populated.vueDefinition).not.toHaveBeenCalled();
			expect(populated.vueReferences).not.toHaveBeenCalled();
			expect(populated.read).toHaveBeenCalledWith(
				ctx,
				filePath,
				"semantic",
				expect.any(Function),
				undefined,
			);
		},
	);

	it("does not invoke the Vue fallback for another server", async () => {
		await workspace();
		const other = harness(rootPath, filePath, [], "typescript");
		const result = await definition(
			other.service,
			ctx,
			{ filePath, line: 1, character: 0 },
			undefined,
		);
		expect(text(result).definitions).toEqual([]);
		expect(other.vueDefinition).not.toHaveBeenCalled();
	});

	it("prepares rename via Vue only when the LSP returns null", async () => {
		await workspace();
		const input = { filePath, line: 1, character: 0 };
		const empty = harness(rootPath, filePath, null);
		expect(
			text(await prepareRename(empty.service, ctx, input, undefined))
				.prepareRename,
		).toEqual({
			start: { line: 1, character: 0 },
			end: { line: 1, character: 5 },
		});
		expect(empty.vueRename).toHaveBeenCalledTimes(1);
		expect(empty.read).toHaveBeenCalledWith(
			ctx,
			filePath,
			"semantic",
			expect.any(Function),
			undefined,
		);
		const populated = harness(rootPath, filePath, range);
		expect(
			text(await prepareRename(populated.service, ctx, input, undefined))
				.prepareRename,
		).toEqual({
			start: { line: 1, character: 0 },
			end: { line: 1, character: 5 },
		});
		expect(populated.vueRename).not.toHaveBeenCalled();
		expect(populated.read).toHaveBeenCalledWith(
			ctx,
			filePath,
			"semantic",
			expect.any(Function),
			undefined,
		);
	});

	it("applies a same-file Vue rename only when LSP preparation is empty", async () => {
		await workspace();
		const { service, request, vueRename, withFile } = harness(
			rootPath,
			filePath,
			null,
		);
		const edit = {
			changes: {
				[pathToFileURL(filePath).href]: [{ range, newText: "changed" }],
			},
		};
		vueRename.mockResolvedValue({ range, edit });
		const result = await rename(
			service,
			ctx,
			{ filePath, line: 1, character: 0, newName: "changed" },
			undefined,
		);
		expect(result.details?.code).toBe("ok");
		expect(vueRename).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledTimes(1);
		expect(withFile).toHaveBeenCalledWith(
			ctx,
			filePath,
			"mutation",
			"tool",
			expect.any(Function),
			undefined,
		);
		expect(await readFile(filePath, "utf8")).toBe("changed\n");
	});

	it("uses a nonempty LSP rename edit without consulting the Vue fallback", async () => {
		await workspace();
		const { service, request, vueRename, withFile } = harness(
			rootPath,
			filePath,
			range,
		);
		const edit = {
			changes: {
				[pathToFileURL(filePath).href]: [{ range, newText: "updated" }],
			},
		};
		request.mockImplementation(async (method) => ({
			ok: true,
			value: method === "textDocument/prepareRename" ? range : edit,
		}));
		const result = await rename(
			service,
			ctx,
			{ filePath, line: 1, character: 0, newName: "updated" },
			undefined,
		);
		expect(result.details?.code).toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
		expect(vueRename).not.toHaveBeenCalled();
		expect(withFile).toHaveBeenCalledWith(
			ctx,
			filePath,
			"mutation",
			"tool",
			expect.any(Function),
			undefined,
		);
		expect(await readFile(filePath, "utf8")).toBe("updated\n");
	});

	it("falls back when Vue LSP prepares rename but returns no edit", async () => {
		await workspace();
		const { service, request, vueRename, withFile } = harness(
			rootPath,
			filePath,
			range,
		);
		const edit = {
			changes: {
				[pathToFileURL(filePath).href]: [{ range, newText: "fallback" }],
			},
		};
		request.mockImplementation(async (method) => ({
			ok: true,
			value: method === "textDocument/prepareRename" ? range : null,
		}));
		vueRename.mockResolvedValue({ range, edit });
		const result = await rename(
			service,
			ctx,
			{ filePath, line: 1, character: 0, newName: "fallback" },
			undefined,
		);
		expect(result.details?.code).toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
		expect(vueRename).toHaveBeenCalledTimes(1);
		expect(withFile).toHaveBeenCalledWith(
			ctx,
			filePath,
			"mutation",
			"tool",
			expect.any(Function),
			undefined,
		);
		expect(await readFile(filePath, "utf8")).toBe("fallback\n");
	});

	it("rejects cross-file Vue rename without writing to either file", async () => {
		await workspace();
		const secondary = join(rootPath, "Secondary.vue");
		await writeFile(secondary, "beta\n");
		const { service, vueRename, request, withFile } = harness(
			rootPath,
			filePath,
			null,
		);
		vueRename.mockImplementation(async (_file, _text, _position, newName) => {
			return {
				range,
				edit: mapVueRenameEdits(
					rootPath,
					filePath,
					{
						locs: [
							{
								file: secondary,
								locs: [
									{
										start: { line: 1, offset: 1 },
										end: { line: 1, offset: 5 },
									},
								],
							},
						],
					},
					newName,
				),
			};
		});
		const result = await rename(
			service,
			ctx,
			{ filePath, line: 1, character: 0, newName: "changed" },
			undefined,
		);
		expect(result.details?.code).toBe("invalid_file");
		expect(vueRename).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledTimes(1);
		expect(withFile).toHaveBeenCalledWith(
			ctx,
			filePath,
			"mutation",
			"tool",
			expect.any(Function),
			undefined,
		);
		expect(await readFile(filePath, "utf8")).toBe(source);
		expect(await readFile(secondary, "utf8")).toBe("beta\n");
	});
});
