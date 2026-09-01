import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	EffectiveConfig,
	EffectiveServerConfig,
} from "../../src/contracts.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import { ToolError, TrustedOperationService } from "../../src/tools/shared.js";
import { afterEach, describe, expect, it, vi } from "vitest";

function server(id: string, priority: number): EffectiveServerConfig {
	return {
		id,
		enabled: true,
		autoInstall: false,
		priority,
		command: id,
		args: [],
		extensions: [".ts"],
		roles: ["diagnostics"],
		languageIds: ["typescript"],
		admission: "tested",
		manualHelp: `Install ${id}.`,
	};
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		signal: undefined,
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
}

async function makeService(
	_cwd: string,
	config: EffectiveConfig,
	starts: { count: number },
	_failsFor?: string,
): Promise<TrustedOperationService> {
	const entries = new Map<
		string,
		{
			session: never;
			queue: { run: (work: () => Promise<unknown>) => Promise<unknown> };
		}
	>();
	return new TrustedOperationService({
		coordinator: () => undefined,
		pool: () =>
			({
				key: async (root: string, id: string) => JSON.stringify([root, id]),
				lifecycleCallbacks: () => ({
					onTaint: async () => undefined,
					onExit: async () => undefined,
				}),
				acquire: async (
					root: string,
					id: string,
					_factory: (signal: AbortSignal) => Promise<never>,
				) => {
					const key = JSON.stringify([root, id]);
					let entry = entries.get(key);
					if (!entry) {
						starts.count += 1;
						const documents = new Map<string, { version: number }>();
						const session = {
							session: {
								capabilities: { diagnosticProvider: {} },
								documents: {
									get: (uri: string) => documents.get(uri),
									open: async (_connection: unknown, uri: string) => {
										const value = { version: 1 };
										documents.set(uri, value);
										return value;
									},
									close: async (_connection: unknown, uri: string) => {
										documents.delete(uri);
									},
								},
							},
							diagnostics: {
								snapshot: () => 0,
								collect: async () => ({
									ok: true as const,
									diagnostics: [
										{
											range: {
												start: { line: 0, character: 0 },
												end: { line: 0, character: 1 },
											},
											severity: 1,
											message: "error",
										},
										{
											range: {
												start: { line: 1, character: 0 },
												end: { line: 1, character: 1 },
											},
											severity: 2,
											message: "warning",
										},
									],
								}),
							},
							connection: {},
						};
						entry = {
							session: session as never,
							queue: { run: async (work) => work() },
						};
						entries.set(key, entry);
					}
					return { entry, lease: { release: vi.fn() } };
				},
			}) as never,
		load: async () => ({
			config,
			paths: {
				globalConfigPath: "global",
				projectConfigPath: "project",
				managedStatePath: "managed",
			},
			globalLayer: "absent" as const,
			projectLayer: "absent" as const,
		}),
		resolveCommand: async () => process.execPath,
		readText: async () => "const value = 1;\n",
		start: async () => {
			throw new Error("The fake pool creates sessions directly.");
		},
	});
}

describe("diagnostics batch orchestration", () => {
	let directory: string | undefined;
	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it("rejects empty paths and unknown severities before service work", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-batch-"));
		const readDiagnosticsBatch = vi.fn();
		const service = {
			readDiagnosticsBatch,
		} as unknown as TrustedOperationService;
		for (const input of [
			{ paths: [""] },
			{ paths: ["."], severity: "fatal" },
		]) {
			const result = await diagnostics(
				service,
				context(directory),
				input as never,
				undefined,
			);
			expect(result.details?.code).toBe("invalid_input");
		}
		expect(readDiagnosticsBatch).not.toHaveBeenCalled();
	});

	it("renders global limits, metadata, omissions, and partial failures without private paths", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-batch-"));
		const diagnostic = (line: number, message: string) => ({
			line,
			character: 0,
			endLine: line,
			endCharacter: 1,
			severity: 1,
			message,
		});
		const service = {
			readDiagnosticsBatch: vi.fn(async () => ({
				filesScanned: 2,
				filesChecked: 2,
				serversUsed: ["alpha", "beta"],
				truncated: false,
				omissions: [{ path: "ignored/file.ts", reason: "directory_excluded" }],
				failures: [
					{ serverId: "beta", paths: ["b.ts"], code: "runtime_failed" },
				],
				files: [
					{
						path: "a.ts",
						servers: [
							{
								serverId: "alpha",
								value: [diagnostic(1, "one"), diagnostic(2, "two")],
							},
						],
					},
					{
						path: "b.ts",
						servers: [
							{
								serverId: "beta",
								value: [diagnostic(3, "three")],
							},
						],
					},
				],
			})),
		} as unknown as TrustedOperationService;
		const result = await diagnostics(
			service,
			context(directory),
			{ paths: ["."], limit: 2 },
			undefined,
		);
		const text = result.content[0];
		if (!text || text.type !== "text") throw new Error("Expected text output.");
		const output = JSON.parse(text.text) as {
			truncated: boolean;
			filesScanned: number;
			omissions: unknown[];
			failures: unknown[];
			files: Array<{ servers: Array<{ diagnostics: unknown[] }> }>;
		};
		expect(output).toMatchObject({
			filesScanned: 2,
			truncated: true,
			omissions: [{ path: "ignored/file.ts", reason: "directory_excluded" }],
			failures: [{ serverId: "beta", paths: ["b.ts"], code: "runtime_failed" }],
		});
		expect(
			output.files.flatMap((file) =>
				file.servers.flatMap((server) => server.diagnostics),
			),
		).toHaveLength(2);
		expect(text.text).not.toContain(directory);
	});

	it("reuses one pool session for multiple files in one root/server group", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-batch-"));
		await writeFile(join(directory, "a.ts"), "a", "utf8");
		await writeFile(join(directory, "b.ts"), "b", "utf8");
		const starts = { count: 0 };
		const service = await makeService(
			directory,
			{
				version: 1,
				network: "offline",
				autoInstall: false,
				postEditDiagnostics: false,
				servers: { typescript: server("typescript", 1) },
			},
			starts,
		);
		const result = await service.readDiagnosticsBatch(
			context(directory),
			["a.ts", "b.ts"],
			undefined,
			async (operation) => operation.target.relativePath,
		);
		expect(result.omissions).toEqual([]);
		expect(result.failures).toEqual([]);
		expect(result).toMatchObject({ filesScanned: 2, filesChecked: 2 });
		expect(starts.count).toBe(1);
		expect(result.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
	});

	it("filters severity before applying the public batch output limit", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-batch-"));
		await writeFile(join(directory, "a.ts"), "a", "utf8");
		const starts = { count: 0 };
		const service = await makeService(
			directory,
			{
				version: 1,
				network: "offline",
				autoInstall: false,
				postEditDiagnostics: false,
				servers: { typescript: server("typescript", 1) },
			},
			starts,
		);
		const result = await diagnostics(
			service,
			context(directory),
			{ paths: ["a.ts"], severity: "warning", limit: 1 },
			undefined,
		);
		const text = result.content[0];
		if (!text || text.type !== "text") throw new Error("Expected text output.");
		expect(text.text).toContain('"message":"warning"');
		expect(text.text).not.toContain('"message":"error"');
	});

	it("starts at most one session per selected server and preserves partial failures", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-batch-"));
		await writeFile(join(directory, "file.ts"), "file", "utf8");
		const starts = { count: 0 };
		const service = await makeService(
			directory,
			{
				version: 1,
				network: "offline",
				autoInstall: false,
				postEditDiagnostics: false,
				servers: { alpha: server("alpha", 10), beta: server("beta", 5) },
			},
			starts,
		);
		const result = await service.readDiagnosticsBatch(
			context(directory),
			["file.ts"],
			["alpha", "beta"],
			async (operation) => {
				if (operation.server.id === "beta") throw new Error("server failed");
				return operation.server.id;
			},
		);
		expect(starts.count).toBe(2);
		expect(result.files[0]?.servers).toEqual([
			{ serverId: "alpha", value: "alpha" },
		]);
		expect(result.failures).toEqual([
			{ serverId: "beta", paths: ["file.ts"], code: "runtime_failed" },
		]);
	});

	it("continues after a file-local failure in the same server group", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-batch-"));
		await writeFile(join(directory, "a.ts"), "a", "utf8");
		await writeFile(join(directory, "b.ts"), "b", "utf8");
		const starts = { count: 0 };
		const service = await makeService(
			directory,
			{
				version: 1,
				network: "offline",
				autoInstall: false,
				postEditDiagnostics: false,
				servers: { typescript: server("typescript", 1) },
			},
			starts,
		);
		const result = await service.readDiagnosticsBatch(
			context(directory),
			["a.ts", "b.ts"],
			undefined,
			async (operation) => {
				if (operation.target.relativePath === "a.ts")
					throw new ToolError("invalid_file", "File changed.");
				return operation.target.relativePath;
			},
		);
		expect(result.failures).toEqual([
			{ serverId: "typescript", paths: ["a.ts"], code: "invalid_file" },
		]);
		expect(result.files.map((file) => file.path)).toEqual(["b.ts"]);
		expect(starts.count).toBe(1);
	});

	it("stops executable probing when cancellation follows discovery", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-batch-"));
		await writeFile(join(directory, "a.ts"), "a", "utf8");
		const controller = new AbortController();
		const probes = vi.fn(async () => {
			controller.abort();
			return process.execPath;
		});
		const config: EffectiveConfig = {
			version: 1,
			network: "offline",
			autoInstall: false,
			postEditDiagnostics: false,
			servers: {
				alpha: server("alpha", 2),
				beta: server("beta", 1),
			},
		};
		const service = new TrustedOperationService({
			coordinator: () => undefined,
			pool: () => undefined,
			load: async () => ({
				config,
				paths: {
					globalConfigPath: "global",
					projectConfigPath: "project",
					managedStatePath: "managed",
				},
				globalLayer: "absent",
				projectLayer: "absent",
			}),
			resolveCommand: probes,
		});
		await expect(
			service.readDiagnosticsBatch(
				context(directory),
				["a.ts"],
				undefined,
				async () => undefined,
				100,
				controller.signal,
			),
		).rejects.toMatchObject({ code: "cancelled" });
		expect(probes).toHaveBeenCalledTimes(1);
	});

	it("rejects untrusted work before loading config or discovering files", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-batch-"));
		const load = vi.fn();
		const service = new TrustedOperationService({
			coordinator: () => undefined,
			pool: () => undefined,
			load,
		});
		const untrusted = { ...context(directory), isProjectTrusted: () => false };
		await expect(
			service.readDiagnosticsBatch(
				untrusted,
				undefined,
				undefined,
				async () => undefined,
			),
		).rejects.toMatchObject({ code: "untrusted_project" });
		expect(load).not.toHaveBeenCalled();
	});
});
