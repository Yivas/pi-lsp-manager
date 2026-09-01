import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { EffectiveConfig } from "../../src/contracts.js";
import {
	InstallCoordinator,
	type PackageManager,
} from "../../src/install/coordinator.js";
import { NodeLspRuntimeSession } from "../../src/protocol/process.js";
import { RuntimePool } from "../../src/runtime/pool.js";
import {
	codeActions,
	CodeActionPreviews,
} from "../../src/tools/code-actions-preview.js";
import { definition } from "../../src/tools/definition.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import { createPostEditHandler } from "../../src/tools/post-edit.js";
import { prepareRename } from "../../src/tools/prepare-rename.js";
import { references } from "../../src/tools/references.js";
import { TrustedOperationService } from "../../src/tools/shared.js";
import { symbols } from "../../src/tools/symbols.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakeServer = resolve("test/fake-lsp/server.mjs");
const config: EffectiveConfig = {
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
			args: [fakeServer],
			extensions: [".ts"],
			roles: ["diagnostics", "semantic"],
			languageIds: ["typescript"],
			admission: "tested",
			manualHelp: "Install fake manually.",
		},
	},
};
const paths = {
	globalConfigPath: "global",
	projectConfigPath: "project",
	managedStatePath: "managed",
};

function text(result: { content: readonly { type: string; text?: string }[] }) {
	const item = result.content.find((value) => value.type === "text");
	if (!item?.text) throw new Error("Expected text result.");
	return JSON.parse(item.text) as Record<string, unknown>;
}

describe("semantic tools against the owned stdio fake LSP", () => {
	let pool: RuntimePool | undefined;
	let directory: string | undefined;
	afterEach(async () => {
		await pool?.shutdown();
		if (directory) await rm(directory, { recursive: true, force: true });
		pool = undefined;
		directory = undefined;
	});

	it("uses diagnostics, locations, symbols, prepare-rename, and preview-only code actions", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-tools-"));
		const filePath = join(directory, "semantic.ts");
		await writeFile(filePath, "😀x\nreference\n", "utf8");
		pool = new RuntimePool();
		const service = new TrustedOperationService({
			coordinator: () => undefined,
			pool: () => pool,
			load: async () => ({
				config,
				paths,
				globalLayer: "absent",
				projectLayer: "absent",
			}),
			resolveCommand: async () => process.execPath,
			start: NodeLspRuntimeSession.start,
		});
		const ctx = {
			cwd: directory,
			signal: undefined,
			isProjectTrusted: () => true,
		} as never;

		expect(
			text(await diagnostics(service, ctx, { filePath }, undefined))
				.diagnostics,
		).toHaveLength(1);
		expect(
			text(
				await definition(
					service,
					ctx,
					{ filePath, line: 1, character: 2 },
					undefined,
				),
			).definitions,
		).toEqual([{ path: "semantic.ts", line: 1, character: 0 }]);
		expect(
			text(
				await references(
					service,
					ctx,
					{ filePath, line: 1, character: 2, limit: 1 },
					undefined,
				),
			).references,
		).toHaveLength(1);
		expect(
			text(
				await symbols(
					service,
					ctx,
					{ filePath, scope: "document", limit: 1 },
					undefined,
				),
			).symbols,
		).toEqual([{ name: "alpha", kind: 12, detail: "fake" }]);
		expect(
			text(
				await symbols(
					service,
					ctx,
					{ filePath, scope: "workspace", query: "a" },
					undefined,
				),
			).symbols,
		).toHaveLength(2);
		expect(
			text(
				await prepareRename(
					service,
					ctx,
					{ filePath, line: 1, character: 2 },
					undefined,
				),
			).prepareRename,
		).toEqual({
			start: { line: 1, character: 0 },
			end: { line: 1, character: 1 },
		});
		const actions = text(
			await codeActions(
				service,
				new CodeActionPreviews(),
				ctx,
				{ filePath },
				undefined,
			),
		);
		expect(actions.previewOnly).toBe(true);
		expect(actions.codeActions).toHaveLength(1);
	}, 20_000);

	it("captures fast unversioned push diagnostics without pull support", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-push-tools-"));
		const filePath = join(directory, "push.ts");
		await writeFile(filePath, "const value = 1;\n", "utf8");
		pool = new RuntimePool();
		const fakeConfig = config.servers.fake;
		if (!fakeConfig) throw new Error("Fake server configuration is required.");
		const pushConfig: EffectiveConfig = {
			...config,
			servers: {
				fake: {
					...fakeConfig,
					initialization: { pushOnly: true, unversionedDiagnostics: true },
				},
			},
		};
		const service = new TrustedOperationService({
			coordinator: () => undefined,
			pool: () => pool,
			load: async () => ({
				config: pushConfig,
				paths,
				globalLayer: "absent",
				projectLayer: "absent",
			}),
			resolveCommand: async () => process.execPath,
			start: NodeLspRuntimeSession.start,
		});
		const ctx = {
			cwd: directory,
			signal: undefined,
			isProjectTrusted: () => true,
		} as never;

		const result = text(
			await diagnostics(service, ctx, { filePath }, undefined),
		);
		expect(result.diagnostics).toHaveLength(1);
	}, 20_000);

	it.each([
		["offline", "offline", true],
		["auto-install disabled", "auto", false],
	] as const)(
		"uses an existing server for post-edit when %s",
		async (_name, network, autoInstall) => {
			directory = await mkdtemp(join(tmpdir(), "pi-lsp-post-policy-"));
			const filePath = join(directory, "policy.ts");
			await writeFile(filePath, "const policy = true;\n", "utf8");
			pool = new RuntimePool();
			const policyConfig: EffectiveConfig = {
				...config,
				network,
				autoInstall,
				postEditDiagnostics: true,
			};
			const install = vi.fn();
			const service = new TrustedOperationService({
				coordinator: () => ({ install }) as never,
				pool: () => pool,
				load: async () => ({
					config: policyConfig,
					paths,
					globalLayer: "absent",
					projectLayer: "absent",
				}),
				resolveCommand: async () => process.execPath,
				start: NodeLspRuntimeSession.start,
			});
			const ctx = {
				cwd: directory,
				signal: undefined,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;
			const event = {
				type: "tool_result",
				toolCallId: "write-policy",
				toolName: "write",
				input: { path: filePath, content: "const policy = true;\n" },
				content: [{ type: "text", text: "Created policy.ts" }],
				isError: false,
				details: undefined,
			} as ToolResultEvent;

			const result = await createPostEditHandler(service)(event, ctx);
			expect(result?.isError).toBe(false);
			expect(result?.content).toHaveLength(2);
			expect(install).not.toHaveBeenCalled();
		},
		20_000,
	);

	it.each([
		[
			"textDocument/diagnostic",
			(
				service: TrustedOperationService,
				ctx: ExtensionContext,
				filePath: string,
			) => diagnostics(service, ctx, { filePath }, undefined),
		],
		[
			"textDocument/definition",
			(
				service: TrustedOperationService,
				ctx: ExtensionContext,
				filePath: string,
			) =>
				definition(
					service,
					ctx,
					{ filePath, line: 1, character: 0 },
					undefined,
				),
		],
		[
			"textDocument/references",
			(
				service: TrustedOperationService,
				ctx: ExtensionContext,
				filePath: string,
			) =>
				references(
					service,
					ctx,
					{ filePath, line: 1, character: 0 },
					undefined,
				),
		],
		[
			"textDocument/documentSymbol",
			(
				service: TrustedOperationService,
				ctx: ExtensionContext,
				filePath: string,
			) => symbols(service, ctx, { filePath, scope: "document" }, undefined),
		],
		[
			"workspace/symbol",
			(
				service: TrustedOperationService,
				ctx: ExtensionContext,
				filePath: string,
			) => symbols(service, ctx, { filePath, scope: "workspace" }, undefined),
		],
		[
			"textDocument/prepareRename",
			(
				service: TrustedOperationService,
				ctx: ExtensionContext,
				filePath: string,
			) =>
				prepareRename(
					service,
					ctx,
					{ filePath, line: 1, character: 0 },
					undefined,
				),
		],
		[
			"textDocument/codeAction",
			(
				service: TrustedOperationService,
				ctx: ExtensionContext,
				filePath: string,
			) =>
				codeActions(
					service,
					new CodeActionPreviews(),
					ctx,
					{ filePath },
					undefined,
				),
		],
	] as const)(
		"retries one real transport crash for %s",
		async (method, run) => {
			directory = await mkdtemp(join(tmpdir(), "pi-lsp-retry-tools-"));
			const filePath = join(directory, "retry.ts");
			const marker = join(directory, "crashed-once.marker");
			await writeFile(filePath, "const retry = true;\n", "utf8");
			pool = new RuntimePool();
			const fakeConfig = config.servers.fake;
			if (!fakeConfig)
				throw new Error("Fake server configuration is required.");
			const crashConfig: EffectiveConfig = {
				...config,
				servers: {
					fake: {
						...fakeConfig,
						initialization: {
							crashOnceMethod: method,
							crashOnceMarker: marker,
						},
					},
				},
			};
			let starts = 0;
			const service = new TrustedOperationService({
				coordinator: () => undefined,
				pool: () => pool,
				load: async () => ({
					config: crashConfig,
					paths,
					globalLayer: "absent",
					projectLayer: "absent",
				}),
				resolveCommand: async () => process.execPath,
				start: async (options) => {
					starts += 1;
					return NodeLspRuntimeSession.start(options);
				},
			});
			const ctx = {
				cwd: directory,
				signal: undefined,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			const result = await run(service, ctx, filePath);
			expect(starts).toBe(2);
			expect(result.details?.code).toBe("ok");
		},
		20_000,
	);

	it("auto-installs the principal once and appends diagnostics after a created file", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-post-edit-tools-"));
		const workspace = directory;
		const filePath = join(workspace, "created.ts");
		await writeFile(filePath, "const created = true;\n", "utf8");
		pool = new RuntimePool();
		const fakeConfig = config.servers.fake;
		if (!fakeConfig) throw new Error("Fake server configuration is required.");
		const installableConfig: EffectiveConfig = {
			...config,
			network: "auto",
			autoInstall: true,
			postEditDiagnostics: true,
			servers: {
				typescript: {
					...fakeConfig,
					id: "typescript",
					command: "missing-fake-lsp",
					autoInstall: true,
					admission: "auto-installable",
				},
			},
		};
		let packageManagerStarts = 0;
		const packageManager: PackageManager = {
			start: async () => {
				packageManagerStarts += 1;
				return {
					completed: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
					terminate: async () => undefined,
				};
			},
		};
		const coordinator = new InstallCoordinator({
			packageManager,
			resolvePackageManagerCommand: async () => process.execPath,
			verifier: async (installationPath, recipe) =>
				readFile(join(installationPath, "package-lock.json"), "utf8").then(
					() => ({ path: process.execPath, version: recipe.expectedVersion }),
					() => undefined,
				),
		});
		const service = new TrustedOperationService({
			coordinator: () => coordinator,
			pool: () => pool,
			load: async () => ({
				config: installableConfig,
				paths: {
					globalConfigPath: join(workspace, "global.json"),
					projectConfigPath: join(workspace, "project.json"),
					managedStatePath: join(workspace, "managed"),
				},
				globalLayer: "absent",
				projectLayer: "absent",
			}),
			resolveCommand: async () => undefined,
			start: NodeLspRuntimeSession.start,
		});
		const ctx = {
			cwd: workspace,
			signal: undefined,
			isProjectTrusted: () => true,
		} as unknown as ExtensionContext;
		const event = {
			type: "tool_result",
			toolCallId: "write-created",
			toolName: "write",
			input: { path: filePath, content: "const created = true;\n" },
			content: [{ type: "text", text: "Created created.ts" }],
			isError: false,
			details: undefined,
		} as ToolResultEvent;

		const result = await createPostEditHandler(service)(event, ctx);
		expect(packageManagerStarts).toBe(1);
		expect(result?.isError).toBe(false);
		expect(result?.content).toHaveLength(2);
		await coordinator.shutdown();
	}, 20_000);
});
