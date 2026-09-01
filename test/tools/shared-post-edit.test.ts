import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	codeActions,
	CodeActionPreviews,
} from "../../src/tools/code-actions-preview.js";
import { definition } from "../../src/tools/definition.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import { createPostEditHandler } from "../../src/tools/post-edit.js";
import { prepareRename } from "../../src/tools/prepare-rename.js";
import { references } from "../../src/tools/references.js";
import { status } from "../../src/tools/status.js";
import { symbols } from "../../src/tools/symbols.js";
import {
	type ToolError,
	TrustedOperationService,
} from "../../src/tools/shared.js";

const untrusted = {
	cwd: process.cwd(),
	signal: undefined,
	isProjectTrusted: () => false,
} as unknown as ExtensionContext;

describe("trusted tool boundary and post-edit trigger", () => {
	it("denies before loading configuration or touching a path", async () => {
		const load = vi.fn();
		const pool = vi.fn();
		const resolveCommand = vi.fn();
		const start = vi.fn();
		const readText = vi.fn();
		const service = new TrustedOperationService({
			coordinator: () => undefined,
			pool,
			load: load as never,
			resolveCommand: resolveCommand as never,
			start: start as never,
			readText,
		});
		await expect(
			service.withFile(
				untrusted,
				"secret.ts",
				"semantic",
				"tool",
				async () => undefined,
			),
		).rejects.toMatchObject({
			code: "untrusted_project",
		} satisfies Partial<ToolError>);
		expect(load).not.toHaveBeenCalled();
		expect(pool).not.toHaveBeenCalled();
		expect(resolveCommand).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		expect(readText).not.toHaveBeenCalled();
	});

	it("denies every semantic tool before any project or runtime side effect", async () => {
		const load = vi.fn();
		const pool = vi.fn();
		const coordinator = vi.fn();
		const resolveCommand = vi.fn();
		const start = vi.fn();
		const readText = vi.fn();
		const service = new TrustedOperationService({
			coordinator,
			pool,
			load: load as never,
			resolveCommand: resolveCommand as never,
			start: start as never,
			readText,
		});
		const results = await Promise.all([
			diagnostics(service, untrusted, { filePath: "secret.ts" }, undefined),
			definition(
				service,
				untrusted,
				{ filePath: "secret.ts", line: 1, character: 0 },
				undefined,
			),
			references(
				service,
				untrusted,
				{ filePath: "secret.ts", line: 1, character: 0 },
				undefined,
			),
			symbols(
				service,
				untrusted,
				{ filePath: "secret.ts", scope: "document" },
				undefined,
			),
			prepareRename(
				service,
				untrusted,
				{ filePath: "secret.ts", line: 1, character: 0 },
				undefined,
			),
			codeActions(
				service,
				new CodeActionPreviews(),
				untrusted,
				{ filePath: "secret.ts" },
				undefined,
			),
		]);
		for (const result of results)
			expect(result.details?.code).toBe("untrusted_project");
		expect(load).not.toHaveBeenCalled();
		expect(pool).not.toHaveBeenCalled();
		expect(coordinator).not.toHaveBeenCalled();
		expect(resolveCommand).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		expect(readText).not.toHaveBeenCalled();
	});

	it("keeps warmup behind trust and explicit install on global-only policy", async () => {
		const load = vi.fn();
		const pool = vi.fn();
		const coordinator = vi.fn();
		const service = new TrustedOperationService({
			coordinator,
			pool,
			load: load as never,
		});
		await expect(service.warmup(untrusted, "typescript")).rejects.toMatchObject(
			{
				code: "untrusted_project",
			},
		);
		expect(load).not.toHaveBeenCalled();
		expect(pool).not.toHaveBeenCalled();
		expect(coordinator).not.toHaveBeenCalled();

		const install = vi.fn().mockResolvedValue({
			status: "ready",
			executable: { path: process.execPath, version: "test" },
		});
		const globalLoad = vi.fn().mockResolvedValue({
			config: {
				version: 1,
				network: "auto",
				autoInstall: false,
				postEditDiagnostics: false,
				servers: {
					typescript: {
						id: "typescript",
						enabled: true,
						autoInstall: false,
						priority: 1,
						command: "typescript-language-server",
						args: ["--stdio"],
						extensions: [".ts"],
						roles: ["diagnostics", "semantic", "mutation"],
						languageIds: ["typescript"],
						admission: "auto-installable",
						manualHelp: "Install TypeScript Language Server.",
					},
				},
			},
			paths: {
				globalConfigPath: "global",
				projectConfigPath: "project",
				managedStatePath: "managed",
			},
			globalLayer: "absent",
			projectLayer: "not-read",
		});
		const explicitPool = vi.fn();
		const explicit = new TrustedOperationService({
			coordinator: () => ({ install }) as never,
			pool: explicitPool,
			load: globalLoad as never,
			readText: vi.fn(),
			resolveCommand: vi.fn(),
			start: vi.fn() as never,
		});
		await expect(
			explicit.explicitInstall(untrusted, "typescript"),
		).resolves.toMatchObject({
			status: "ready",
		});
		expect(globalLoad).toHaveBeenCalledWith({
			cwd: process.cwd(),
			isProjectTrusted: false,
		});
		expect(install).toHaveBeenCalledTimes(1);
		expect(explicitPool).not.toHaveBeenCalled();
	});

	it("rejects a file replaced by an external symlink while waiting for the pool", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-lsp-file-race-"));
		const outside = await mkdtemp(join(tmpdir(), "pi-lsp-file-outside-"));
		try {
			const filePath = join(workspace, "file.ts");
			const outsidePath = join(outside, "secret.ts");
			await writeFile(filePath, "const safe = true;\n", "utf8");
			await writeFile(outsidePath, "const secret = true;\n", "utf8");
			const readText = vi.fn();
			const runtime = {
				diagnostics: { snapshot: () => 0 },
				session: {
					documents: {
						open: vi.fn(),
						close: vi.fn(),
					},
				},
				connection: {},
			};
			const entry = {
				session: runtime,
				queue: { run: async (work: () => Promise<unknown>) => work() },
			};
			const pool = {
				acquire: vi.fn(async () => {
					await rm(filePath);
					await symlink(outsidePath, filePath);
					return { entry, lease: { release: vi.fn() } };
				}),
			};
			const service = new TrustedOperationService({
				coordinator: () => undefined,
				pool: () => pool as never,
				load: async () => ({
					config: {
						version: 1,
						network: "offline",
						autoInstall: false,
						postEditDiagnostics: false,
						servers: {
							fake: {
								id: "fake",
								enabled: true,
								autoInstall: false,
								priority: 1,
								command: process.execPath,
								args: [],
								extensions: [".ts"],
								roles: ["semantic"],
								languageIds: ["typescript"],
								admission: "tested",
								manualHelp: "Use the fake server.",
							},
						},
					},
					paths: {
						globalConfigPath: "global",
						projectConfigPath: "project",
						managedStatePath: "managed",
					},
					globalLayer: "absent",
					projectLayer: "absent",
				}),
				resolveCommand: async () => process.execPath,
				readText,
			});
			const ctx = {
				cwd: workspace,
				signal: undefined,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await expect(
				service.withFile(
					ctx,
					filePath,
					"semantic",
					"tool",
					async () => undefined,
				),
			).rejects.toMatchObject({ code: "invalid_file" });
			expect(readText).not.toHaveBeenCalled();
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("uses global-only sanitized status for untrusted contexts", async () => {
		const load = vi.fn().mockResolvedValue({
			config: {
				network: "offline",
				autoInstall: false,
				postEditDiagnostics: false,
				servers: {},
			},
			paths: {},
			globalLayer: "absent",
			projectLayer: "not-read",
		});
		const service = new TrustedOperationService({
			coordinator: () => undefined,
			pool: () => undefined,
			load: load as never,
		});
		const result = await status(service, untrusted);
		expect(result.details).toEqual({ code: "ok" });
		expect(load).toHaveBeenCalledWith({
			cwd: process.cwd(),
			isProjectTrusted: false,
		});
	});

	it("ignores non-edit results and failed mutations", async () => {
		const config = vi.fn();
		const service = { config } as unknown as TrustedOperationService;
		const handler = createPostEditHandler(service);
		await handler(
			{
				toolName: "read",
				isError: false,
				input: { path: "x.ts" },
				content: [],
				toolCallId: "1",
				type: "tool_result",
				details: undefined,
			},
			untrusted,
		);
		await handler(
			{
				toolName: "write",
				isError: true,
				input: { path: "x.ts" },
				content: [],
				toolCallId: "2",
				type: "tool_result",
				details: undefined,
			},
			untrusted,
		);
		expect(config).not.toHaveBeenCalled();
	});
});
