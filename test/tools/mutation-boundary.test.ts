import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { applyCodeAction } from "../../src/tools/apply-code-action.js";
import { CodeActionPreviews } from "../../src/tools/code-actions-preview.js";
import { rename } from "../../src/tools/rename.js";
import { TrustedOperationService } from "../../src/tools/shared.js";

const untrusted = {
	cwd: process.cwd(),
	signal: undefined,
	isProjectTrusted: () => false,
} as unknown as ExtensionContext;

describe("mutation tool boundaries", () => {
	it("denies rename and code-action application before config, file, pool, install, or spawn", async () => {
		const load = vi.fn();
		const pool = vi.fn();
		const coordinator = vi.fn();
		const resolveCommand = vi.fn();
		const start = vi.fn();
		const readText = vi.fn();
		const service = new TrustedOperationService({
			load: load as never,
			pool,
			coordinator,
			resolveCommand: resolveCommand as never,
			start: start as never,
			readText,
		});
		const [renamed, applied] = await Promise.all([
			rename(
				service,
				untrusted,
				{ filePath: "secret.ts", line: 1, character: 0, newName: "renamed" },
				undefined,
			),
			applyCodeAction(
				service,
				new CodeActionPreviews(),
				untrusted,
				{ filePath: "secret.ts", previewId: "preview" },
				undefined,
			),
		]);
		expect(renamed.details?.code).toBe("untrusted_project");
		expect(applied.details?.code).toBe("untrusted_project");
		for (const sideEffect of [
			load,
			pool,
			coordinator,
			resolveCommand,
			start,
			readText,
		])
			expect(sideEffect).not.toHaveBeenCalled();
	});

	it("trims a rename and rejects whitespace before it touches the service", async () => {
		const service = { withFile: vi.fn() } as unknown as TrustedOperationService;
		const result = await rename(
			service,
			untrusted,
			{ filePath: "secret.ts", line: 1, character: 0, newName: " \t " },
			undefined,
		);
		expect(result.details?.code).toBe("invalid_file");
		expect(service.withFile).not.toHaveBeenCalled();
	});

	it("binds rename response edits to the exact opened document bytes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-lsp-rename-stale-"));
		try {
			const filePath = join(directory, "file.ts");
			const uri = pathToFileURL(filePath).href;
			await writeFile(filePath, "alpha\n", "utf8");
			const document = { version: 1, text: "alpha\n" };
			const operation = {
				target: { workspacePath: directory, filePath },
				server: {} as never,
				runtime: {
					session: {
						capabilities: { renameProvider: { prepareProvider: true } },
						documents: { get: () => document },
					},
					connection: {
						request: vi.fn(async (method: string) => {
							if (method === "textDocument/prepareRename")
								return { ok: true, value: { start: {}, end: {} } };
							await writeFile(filePath, "changed-by-race\n", "utf8");
							return {
								ok: true,
								value: {
									changes: {
										[uri]: [
											{
												range: {
													start: { line: 0, character: 0 },
													end: { line: 0, character: 1 },
												},
												newText: "r",
											},
										],
									},
								},
							};
						}),
					},
				},
				entry: {} as never,
				uri,
				diagnosticGeneration: 0,
			};
			const service = {
				withFile: vi.fn(async (_ctx, _file, _role, _origin, work) =>
					work(operation),
				),
			} as unknown as TrustedOperationService;
			const ctx = {
				cwd: directory,
				signal: undefined,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;
			const result = await rename(
				service,
				ctx,
				{ filePath, line: 1, character: 0, newName: "renamed" },
				undefined,
			);
			expect(result.details?.code).toBe("invalid_file");
			expect(
				await (await import("node:fs/promises")).readFile(filePath, "utf8"),
			).toBe("changed-by-race\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("binds preview consumption to hash, file, server, session, and one caller", () => {
		let now = 0;
		const previews = new CodeActionPreviews(10, 8, () => now);
		const session = {};
		const id = previews.put({
			hash: "hash",
			filePath: "/workspace/a.ts",
			serverId: "fake",
			session,
			action: { title: "fix" },
		});
		for (const expected of [
			{
				hash: "other",
				filePath: "/workspace/a.ts",
				serverId: "fake",
				session,
			},
			{
				hash: "hash",
				filePath: "/workspace/other.ts",
				serverId: "fake",
				session,
			},
			{
				hash: "hash",
				filePath: "/workspace/a.ts",
				serverId: "fake",
				session: {},
			},
		])
			expect(previews.take(id, expected)).toBeUndefined();
		expect(
			previews.take(id, {
				hash: "hash",
				filePath: "/workspace/a.ts",
				serverId: "fake",
				session,
			}),
		).toEqual({ title: "fix" });
		expect(
			previews.take(id, {
				hash: "hash",
				filePath: "/workspace/a.ts",
				serverId: "fake",
				session,
			}),
		).toBeUndefined();
		const expired = previews.put({
			hash: "hash",
			filePath: "/workspace/a.ts",
			serverId: "fake",
			session,
			action: {},
		});
		now = 11;
		expect(
			previews.take(expired, {
				hash: "hash",
				filePath: "/workspace/a.ts",
				serverId: "fake",
				session,
			}),
		).toBeUndefined();
	});
});
