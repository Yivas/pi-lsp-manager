import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { applyCodeAction } from "../../src/tools/apply-code-action.js";
import { codeActionsSchema } from "../../src/tools/code-actions-preview.js";
import { fix, fixSchema } from "../../src/tools/fix.js";
import { CodeActionPreviews } from "../../src/tools/source-action.js";
import type { TrustedOperationService } from "../../src/tools/shared.js";

function text(result: { content: readonly { type: string; text?: string }[] }) {
	const value = result.content[0];
	if (!value?.text) throw new Error("Expected tool text.");
	return JSON.parse(value.text) as Record<string, unknown>;
}

async function fixture(
	actions: unknown[],
	options: { resolve?: boolean } = {},
) {
	const workspacePath = await mkdtemp(join(tmpdir(), "pi-lsp-source-action-"));
	const filePath = join(workspacePath, "file.ts");
	const content = "alpha\n";
	await writeFile(filePath, content, "utf8");
	const uri = pathToFileURL(filePath).href;
	const document = { version: 1, text: content };
	const request = vi.fn(async (method: string, _params?: unknown) => {
		if (method === "textDocument/codeAction")
			return { ok: true, value: actions };
		if (method === "codeAction/resolve")
			return {
				ok: true,
				value: {
					title: "resolved",
					edit: edit(uri, "R"),
				},
			};
		return { ok: false, code: "closed" };
	});
	const runtime = {
		diagnostics: {
			collect: vi.fn(async () => ({ ok: true, diagnostics: [] })),
		},
		session: {
			capabilities: {
				codeActionProvider: options.resolve ? { resolveProvider: true } : true,
			},
			documents: { get: () => document },
		},
		connection: { request },
	};
	const operation = {
		target: { workspacePath, filePath, relativePath: "file.ts" },
		server: { id: "fake" },
		runtime,
		entry: {} as never,
		uri,
		diagnosticGeneration: 0,
	};
	const withFile = vi.fn(async (...args: unknown[]) =>
		(args[4] as (value: typeof operation) => Promise<unknown>)(operation),
	);
	const service = { withFile } as unknown as TrustedOperationService;
	const ctx = {
		cwd: workspacePath,
		signal: undefined,
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
	return { workspacePath, filePath, uri, request, service, ctx, withFile };
}

function edit(uri: string, replacement: string) {
	return {
		changes: {
			[uri]: [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					newText: replacement,
				},
			],
		},
	};
}

describe("source actions", () => {
	it("keeps schemas closed and declares fix defaults", () => {
		const schema = fixSchema as unknown as {
			additionalProperties?: unknown;
			properties: { kind: { default?: unknown }; write: { default?: unknown } };
		};
		expect(schema.additionalProperties).toBe(false);
		expect(
			(codeActionsSchema as unknown as { additionalProperties?: unknown })
				.additionalProperties,
		).toBe(false);
		expect(schema.properties.kind.default).toBe("source.fixAll");
		expect(schema.properties.write.default).toBe(false);
	});

	it("uses source.fixAll context, mutation selection, explicit server, order, and limit", async () => {
		const item = await fixture(
			Array.from({ length: 60 }, (_, index) => ({
				title: `fix-${String(60 - index).padStart(2, "0")}`,
				kind: "source.fixAll",
			})),
		);
		try {
			const result = text(
				await fix(
					item.service,
					new CodeActionPreviews(),
					item.ctx,
					{ filePath: item.filePath, server: "fake" },
					undefined,
				),
			);
			expect(result.previewOnly).toBe(true);
			expect(result.codeActions).toHaveLength(50);
			expect((result.codeActions as { title: string }[])[0]?.title).toBe(
				"fix-01",
			);
			expect(item.request.mock.calls[0]?.[1]).toMatchObject({
				context: { only: ["source.fixAll"] },
			});
			expect(item.withFile.mock.calls[0]?.[2]).toBe("mutation");
			expect(item.withFile.mock.calls[0]?.[9]).toBe("fake");
		} finally {
			await rm(item.workspacePath, { recursive: true, force: true });
		}
	});

	it("returns capability_missing without requesting actions", async () => {
		const item = await fixture([]);
		try {
			const operation = item.withFile.mock.calls;
			void operation;
			const service = {
				withFile: vi.fn(async (_ctx, _file, _role, _origin, work) =>
					work({
						target: {
							workspacePath: item.workspacePath,
							filePath: item.filePath,
						},
						server: { id: "fake" },
						runtime: {
							diagnostics: { collect: vi.fn() },
							session: { capabilities: {}, documents: { get: vi.fn() } },
							connection: { request: item.request },
						},
						uri: item.uri,
						diagnosticGeneration: 0,
					}),
				),
			} as unknown as TrustedOperationService;
			const result = await fix(
				service,
				new CodeActionPreviews(),
				item.ctx,
				{ filePath: item.filePath },
				undefined,
			);
			expect(result.details?.code).toBe("capability_missing");
			expect(item.request).not.toHaveBeenCalled();
		} finally {
			await rm(item.workspacePath, { recursive: true, force: true });
		}
	});

	it("writes zero bytes for preview, zero, and ambiguous action sets", async () => {
		for (const actions of [[], [{ title: "a" }, { title: "b" }]]) {
			const item = await fixture(actions);
			try {
				const result = text(
					await fix(
						item.service,
						new CodeActionPreviews(),
						item.ctx,
						{ filePath: item.filePath, write: true },
						undefined,
					),
				);
				expect(result.previewOnly).toBe(true);
				expect(await readFile(item.filePath, "utf8")).toBe("alpha\n");
			} finally {
				await rm(item.workspacePath, { recursive: true, force: true });
			}
		}
	});

	it("applies one fresh preview and resolves it through the existing apply path", async () => {
		const item = await fixture([{ title: "resolve me" }], { resolve: true });
		try {
			const result = text(
				await fix(
					item.service,
					new CodeActionPreviews(),
					item.ctx,
					{ filePath: item.filePath, write: true },
					undefined,
				),
			);
			expect(result.mutation).toMatchObject({ status: "applied" });
			expect(item.request).toHaveBeenCalledWith(
				"codeAction/resolve",
				expect.anything(),
				undefined,
			);
			expect(await readFile(item.filePath, "utf8")).toBe("Rlpha\n");
		} finally {
			await rm(item.workspacePath, { recursive: true, force: true });
		}
	});

	it("rejects stale previews and unsafe workspace edits without writing", async () => {
		const item = await fixture([]);
		try {
			const previews = new CodeActionPreviews();
			const id = previews.put({
				hash: createHash("sha256").update("other").digest("hex"),
				filePath: item.filePath,
				serverId: "fake",
				session: item.withFile as never as object,
				action: {
					title: "unsafe",
					edit: { documentChanges: [{ kind: "create" }] },
				},
			});
			const stale = await applyCodeAction(
				item.service,
				previews,
				item.ctx,
				{ filePath: item.filePath, previewId: id },
				undefined,
			);
			expect(stale.details?.code).toBe("invalid_file");
			expect(await readFile(item.filePath, "utf8")).toBe("alpha\n");
		} finally {
			await rm(item.workspacePath, { recursive: true, force: true });
		}
	});
});
