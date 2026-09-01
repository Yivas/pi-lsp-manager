import type {
	EditToolDetails,
	ExtensionContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import { createPostEditHandler } from "../../src/tools/post-edit.js";
import { TrustedOperationService } from "../../src/tools/shared.js";

const context = {
	cwd: process.cwd(),
	signal: undefined,
	isProjectTrusted: () => true,
} as unknown as ExtensionContext;

const editDetails: EditToolDetails = {
	diff: "@@ -1 +1 @@",
	patch: "-old\n+new",
	firstChangedLine: 1,
};

function editEvent(
	input: Record<string, unknown> = { path: "src/index.ts" },
): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "edit-1",
		toolName: "edit",
		input,
		content: [{ type: "text", text: "edit completed" }],
		isError: false,
		details: editDetails,
	};
}

function writeEvent(
	input: Record<string, unknown> = { path: "src/index.ts" },
): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "write-1",
		toolName: "write",
		input,
		content: [{ type: "text", text: "write completed" }],
		isError: false,
		details: undefined,
	} as ToolResultEvent;
}

function otherEvent(
	toolName: string,
	input: Record<string, unknown> = { path: "src/index.ts" },
): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: `${toolName}-1`,
		toolName,
		input,
		content: [{ type: "text", text: `${toolName} completed` }],
		isError: false,
		details: undefined,
	} as ToolResultEvent;
}

function operation() {
	return {
		target: { rootPath: process.cwd(), filePath: "src/file.ts" },
		server: {} as never,
		runtime: {
			diagnostics: {
				collect: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] }),
			},
			session: {
				capabilities: { diagnosticProvider: true },
				documents: { get: () => ({ version: 1, text: "const value = 1;" }) },
			},
			connection: {
				onNotification: vi.fn(),
				request: vi.fn().mockResolvedValue({ ok: true, value: { items: [] } }),
			},
		},
		entry: {} as never,
		uri: "file:///workspace/src/file.ts",
		diagnosticGeneration: 0,
	};
}

function serviceFor(options: {
	postEditDiagnostics?: boolean;
	trusted?: boolean;
	readDiagnostics?: TrustedOperationService["readDiagnostics"];
	config?: () => Promise<unknown>;
}) {
	const readDiagnostics =
		options.readDiagnostics ??
		(async (_ctx, _path, work) => [
			{ serverId: "fake", value: await work(operation() as never) },
		]);
	return {
		config:
			options.config ??
			(async () => ({
				config: {
					version: 1,
					network: "offline",
					autoInstall: false,
					postEditDiagnostics: options.postEditDiagnostics ?? true,
					servers: createDefaultConfig().servers,
				},
				paths: {},
				globalLayer: "absent",
				projectLayer: "absent",
			})),
		readDiagnostics,
	} as unknown as TrustedOperationService;
}

describe("post-edit event matrix", () => {
	it.each([
		["edit success", editEvent(), "edit completed"],
		["write success with undefined details", writeEvent(), "write completed"],
	])("runs diagnostics after %s", async (_name, event, original) => {
		const service = serviceFor({});
		const result = await createPostEditHandler(service)(event, context);
		expect(result?.isError).toBe(false);
		expect(result?.content[0]).toEqual({ type: "text", text: original });
		const appended = result?.content.at(-1);
		expect(appended?.type).toBe("text");
		if (appended?.type === "text")
			expect(appended.text).toContain("LSP diagnostics");
	});

	it.each([
		["read", otherEvent("read")],
		["bash", otherEvent("bash")],
		["grep", otherEvent("grep")],
		["find", otherEvent("find")],
		["ls", otherEvent("ls")],
		["unknown", otherEvent("unknown")],
		["custom LSP", otherEvent("lsp_custom")],
		["failed edit", { ...editEvent(), isError: true }],
		["ambiguous path", editEvent({ path: ["src/file.ts", "other.ts"] })],
		["missing path", editEvent({})],
		["empty path", editEvent({ path: "" })],
	])(
		"preserves the original non-trigger result for %s",
		async (_name, event) => {
			const config = vi.fn();
			const service = serviceFor({
				config: config as never,
				readDiagnostics: vi.fn().mockRejectedValue(new Error("invalid file")),
			});
			const result = await createPostEditHandler(service)(event, context);
			expect(result).toBeUndefined();
			expect(event.content).toEqual([
				{ type: "text", text: expect.any(String) },
			]);
			expect(event.isError).toBe(_name === "failed edit");
			expect(config).not.toHaveBeenCalled();
		},
	);

	it("revalidates an existing unsupported file after mutation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-lsp-post-unsupported-"));
		try {
			const filePath = join(directory, "notes.txt");
			await writeFile(filePath, "not supported\n", "utf8");
			const config = vi.fn();
			const service = serviceFor({ config: config as never });
			const ctx = { ...context, cwd: directory } as ExtensionContext;
			expect(
				await createPostEditHandler(service)(
					writeEvent({ path: filePath }),
					ctx,
				),
			).toBeUndefined();
			expect(config).toHaveBeenCalledTimes(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("uses effective global manual routes for post-edit diagnostics", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-lsp-post-manual-"));
		try {
			const filePath = join(directory, "notes.custom");
			await writeFile(filePath, "custom\n", "utf8");
			const service = serviceFor({
				config: async () => ({
					config: {
						version: 1,
						network: "offline",
						autoInstall: false,
						postEditDiagnostics: true,
						servers: {
							custom: {
								id: "custom",
								enabled: true,
								autoInstall: false,
								priority: 1,
								route: { command: "custom-ls", args: [] },
								extensions: [".custom"],
								roles: ["diagnostics"],
								languageIds: ["custom"],
								admission: "candidate",
								manualHelp: "Install manually.",
							},
						},
					},
					paths: {},
					globalLayer: "valid",
					projectLayer: "absent",
				}),
			});
			const result = await createPostEditHandler(service)(
				writeEvent({ path: filePath }),
				{ ...context, cwd: directory } as ExtensionContext,
			);
			expect(result?.content.at(-1)).toMatchObject({
				type: "text",
				text: expect.stringContaining("LSP diagnostics"),
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		["untrusted", { ...context, isProjectTrusted: () => false }],
		["postEdit false", context],
		["autoInstall false", context],
		["offline", context],
		["signal abort", context],
		["install failure", context],
		["LSP failure", context],
	])("does not replace content after %s", async (name, ctxFactory) => {
		const config = vi.fn().mockResolvedValue({
			config: {
				version: 1,
				network: name === "offline" ? "offline" : "auto",
				autoInstall: name !== "autoInstall false",
				postEditDiagnostics: name !== "postEdit false",
				servers: {},
			},
			paths: {},
			globalLayer: "absent",
			projectLayer: "absent",
		});
		const readDiagnostics = vi.fn().mockRejectedValue(new Error(name));
		const service = serviceFor({ config: config as never, readDiagnostics });
		const event = editEvent();
		const result = await createPostEditHandler(service)(
			event,
			ctxFactory as ExtensionContext,
		);
		expect(result).toBeUndefined();
		expect(event.content[0]).toEqual({ type: "text", text: "edit completed" });
		expect(event.isError).toBe(false);
	});

	it.each([
		["offline", "offline", true],
		["auto-install disabled", "auto", false],
	] as const)(
		"does not install a missing server after post-edit when %s",
		async (_name, network, autoInstall) => {
			const coordinator = vi.fn();
			const pool = vi.fn();
			const service = new TrustedOperationService({
				coordinator,
				pool,
				load: async () => ({
					config: {
						version: 1,
						network,
						autoInstall,
						postEditDiagnostics: true,
						servers: {
							typescript: {
								id: "typescript",
								enabled: true,
								autoInstall: true,
								priority: 1,
								command: "missing-typescript-language-server",
								args: ["--stdio"],
								extensions: [".ts"],
								roles: ["diagnostics"],
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
					projectLayer: "absent",
				}),
				resolveCommand: async () => undefined,
			});
			const event = editEvent({ path: "src/index.ts" });
			expect(
				await createPostEditHandler(service)(event, context),
			).toBeUndefined();
			expect(event.isError).toBe(false);
			expect(coordinator).not.toHaveBeenCalled();
			expect(pool).not.toHaveBeenCalled();
		},
	);

	it("honors an already-aborted post-edit signal before install or runtime work", async () => {
		const controller = new AbortController();
		controller.abort();
		const coordinator = vi.fn();
		const pool = vi.fn();
		const resolveCommand = vi.fn();
		const service = new TrustedOperationService({
			coordinator,
			pool,
			resolveCommand: resolveCommand as never,
			load: async () => ({
				config: {
					version: 1,
					network: "auto",
					autoInstall: true,
					postEditDiagnostics: true,
					servers: {},
				},
				paths: {
					globalConfigPath: "global",
					projectConfigPath: "project",
					managedStatePath: "managed",
				},
				globalLayer: "absent",
				projectLayer: "absent",
			}),
		});
		const event = editEvent({ path: "src/index.ts" });
		const ctx = { ...context, signal: controller.signal } as ExtensionContext;
		expect(await createPostEditHandler(service)(event, ctx)).toBeUndefined();
		expect(event.isError).toBe(false);
		expect(resolveCommand).not.toHaveBeenCalled();
		expect(coordinator).not.toHaveBeenCalled();
		expect(pool).not.toHaveBeenCalled();
	});

	it("does not recursively process its own diagnostic result", async () => {
		const readDiagnostics = vi.fn(async (_ctx, _path, work) => [
			{ serverId: "fake", value: await work(operation() as never) },
		]);
		const service = serviceFor({ readDiagnostics });
		const handler = createPostEditHandler(service);
		const result = await handler(editEvent(), context);
		expect(result?.isError).toBe(false);
		expect(readDiagnostics).toHaveBeenCalledTimes(1);
	});
});
