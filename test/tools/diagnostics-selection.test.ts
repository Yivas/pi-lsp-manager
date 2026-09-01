import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	EffectiveConfig,
	EffectiveServerConfig,
} from "../../src/contracts.js";
import { TransientRuntimeError } from "../../src/runtime/retry.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import { ToolError, TrustedOperationService } from "../../src/tools/shared.js";
import { afterEach, describe, expect, it, vi } from "vitest";

function server(
	id: string,
	priority: number,
	autoInstall: boolean,
	admission: EffectiveServerConfig["admission"],
): EffectiveServerConfig {
	return {
		id,
		enabled: true,
		autoInstall,
		priority,
		command: id,
		args: [],
		extensions: [".ts"],
		roles: ["diagnostics"],
		languageIds: ["typescript"],
		admission,
		manualHelp: `Install ${id}.`,
	};
}

describe("diagnostics server selection", () => {
	let directory: string | undefined;
	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it.each([
		[true, false, ["primary", "auxiliary"]],
		[false, false, ["primary"]],
		[true, true, ["primary"]],
	] as const)(
		"uses the principal and eligible auxiliaries (available: %s, failing: %s)",
		async (auxiliaryAvailable, auxiliaryFails, expectedIds) => {
			directory = await mkdtemp(join(tmpdir(), "pi-lsp-selection-"));
			const filePath = join(directory, "file.ts");
			await writeFile(filePath, "const value = 1;\n", "utf8");
			const config: EffectiveConfig = {
				version: 1,
				network: "auto",
				autoInstall: true,
				postEditDiagnostics: true,
				servers: {
					primary: server("primary", 10, true, "auto-installable"),
					auxiliary: server("auxiliary", 5, false, "tested"),
				},
			};
			const load = vi.fn(async () => ({
				config,
				paths: {
					globalConfigPath: "global",
					projectConfigPath: "project",
					managedStatePath: "managed",
				},
				globalLayer: "absent" as const,
				projectLayer: "absent" as const,
			}));
			const service = new TrustedOperationService({
				coordinator: () => undefined,
				pool: () => undefined,
				load,
				resolveCommand: async (command) =>
					command === "auxiliary" && auxiliaryAvailable
						? "/available/auxiliary"
						: undefined,
			});
			const withFile = vi
				.spyOn(service, "withFile")
				.mockImplementation(async (...args) => {
					const selected = args[6];
					if (!selected)
						throw new Error("Expected an explicit selected server.");
					if (selected.id === "auxiliary" && auxiliaryFails)
						throw new ToolError(
							"capability_missing",
							"Use a diagnostics-capable auxiliary.",
						);
					return selected.id as never;
				});
			const ctx = {
				cwd: directory,
				signal: undefined,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			const results = await service.readDiagnostics(
				ctx,
				filePath,
				async (operation) => operation.server.id,
			);
			expect(results.map((result) => result.serverId)).toEqual(expectedIds);
			expect(load).toHaveBeenCalledTimes(1);
			expect(withFile).toHaveBeenCalledTimes(auxiliaryAvailable ? 2 : 1);
			expect(withFile.mock.calls[0]?.[7]).toBe(true);
			if (auxiliaryAvailable) expect(withFile.mock.calls[1]?.[7]).toBe(false);
		},
	);

	it("merges diagnostics with deterministic order, deduplication, severity, source, and limits", async () => {
		const diagnostic = (
			line: number,
			severity: number,
			message: string,
			source: string,
		) => ({
			range: {
				start: { line, character: 0 },
				end: { line, character: 1 },
			},
			severity,
			code: message,
			message,
			source,
		});
		const primary: unknown[] = [
			diagnostic(1, 2, "warning", "primary"),
			diagnostic(0, 1, "error", "primary"),
			{
				...diagnostic(3, 2, "invalid code", "primary"),
				code: { private: "not valid LSP" },
			},
		];
		const auxiliary: unknown[] = [
			diagnostic(0, 1, "error", "auxiliary"),
			diagnostic(2, 3, "information", "auxiliary"),
		];
		const operation = (items: unknown[]) => ({
			target: { rootPath: process.cwd(), filePath: "file.ts" },
			server: {} as never,
			runtime: {
				diagnostics: {
					collect: vi.fn().mockResolvedValue({ ok: true, diagnostics: items }),
				},
				session: {
					capabilities: { diagnosticProvider: {} },
					documents: { get: () => ({ version: 1, text: "" }) },
				},
				connection: {},
			},
			entry: {} as never,
			uri: "file:///file.ts",
			diagnosticGeneration: 0,
		});
		const service = {
			readDiagnostics: vi.fn(async (_ctx, _path, work) => [
				{ serverId: "primary", value: await work(operation(primary)) },
				{ serverId: "auxiliary", value: await work(operation(auxiliary)) },
			]),
		} as unknown as TrustedOperationService;
		const ctx = {
			cwd: process.cwd(),
			signal: undefined,
			isProjectTrusted: () => true,
		} as unknown as ExtensionContext;
		const result = await diagnostics(
			service,
			ctx,
			{ filePath: "file.ts", limit: 2 },
			undefined,
		);
		const content = result.content[0];
		if (!content || content.type !== "text") throw new Error("Expected text.");
		const value = JSON.parse(content.text) as { diagnostics: unknown[] };
		expect(value.diagnostics).toEqual([
			expect.objectContaining({ line: 1, message: "error", source: "primary" }),
			expect.objectContaining({
				line: 2,
				message: "warning",
				source: "primary",
			}),
		]);

		const warnings = await diagnostics(
			service,
			ctx,
			{ filePath: "file.ts", severity: "warning" },
			undefined,
		);
		const warningContent = warnings.content[0];
		if (!warningContent || warningContent.type !== "text")
			throw new Error("Expected text.");
		expect(JSON.parse(warningContent.text).diagnostics).toHaveLength(1);
	});

	it("preserves a diagnostics timeout as a stable tool error", async () => {
		const operation = {
			target: { rootPath: process.cwd(), filePath: "file.ts" },
			server: {} as never,
			runtime: {
				diagnostics: {
					collect: vi
						.fn()
						.mockResolvedValue({ ok: false, code: "diagnostics_timed_out" }),
				},
				session: {
					capabilities: {},
					documents: { get: () => ({ version: 1, text: "" }) },
				},
				connection: {},
			},
			entry: {} as never,
			uri: "file:///file.ts",
			diagnosticGeneration: 0,
		};
		const service = {
			readDiagnostics: vi.fn(async (_ctx, _path, work) => [
				{ serverId: "primary", value: await work(operation) },
			]),
		} as unknown as TrustedOperationService;
		const result = await diagnostics(
			service,
			{} as ExtensionContext,
			{ filePath: "file.ts" },
			undefined,
		);
		expect(result.details).toMatchObject({ code: "diagnostics_timed_out" });
	});

	it("retries once when didOpen reports a closed transport", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-notify-retry-"));
		const filePath = join(directory, "file.ts");
		await writeFile(filePath, "const value = 1;\n", "utf8");
		let acquisitions = 0;
		const runtime = (failOpen: boolean) => ({
			diagnostics: { snapshot: () => 0 },
			session: {
				documents: {
					open: vi.fn(async () => {
						if (failOpen) throw new Error("connection_closed");
						return { version: 1 };
					}),
					close: vi.fn().mockResolvedValue(undefined),
				},
			},
			connection: {},
		});
		const pool = {
			acquire: vi.fn(async () => {
				acquisitions += 1;
				return {
					entry: {
						session: runtime(acquisitions === 1),
						queue: {
							run: async (work: () => Promise<unknown>) => work(),
						},
					},
					lease: { release: vi.fn() },
				};
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
							...server("fake", 1, false, "tested"),
							roles: ["semantic"],
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
			readText: async () => "const value = 1;\n",
		});
		const ctx = {
			cwd: directory,
			signal: undefined,
			isProjectTrusted: () => true,
		} as unknown as ExtensionContext;

		await expect(
			service.read(ctx, filePath, "semantic", async () => "ready"),
		).resolves.toBe("ready");
		expect(acquisitions).toBe(2);
	});

	it("retries a read exactly once only for a typed transient runtime failure", async () => {
		const service = new TrustedOperationService({
			coordinator: () => undefined,
			pool: () => undefined,
		});
		const ctx = {
			cwd: process.cwd(),
			signal: undefined,
			isProjectTrusted: () => true,
		} as unknown as ExtensionContext;
		const withFile = vi
			.spyOn(service, "withFile")
			.mockRejectedValueOnce(new TransientRuntimeError("process exited"))
			.mockResolvedValueOnce("ready");
		await expect(
			service.read(ctx, "file.ts", "semantic", async () => "unused"),
		).resolves.toBe("ready");
		expect(withFile).toHaveBeenCalledTimes(2);

		withFile.mockReset();
		withFile.mockRejectedValueOnce(
			new ToolError("capability_missing", "Use another server."),
		);
		await expect(
			service.read(ctx, "file.ts", "semantic", async () => "unused"),
		).rejects.toMatchObject({ code: "capability_missing" });
		expect(withFile).toHaveBeenCalledTimes(1);
	});
});
