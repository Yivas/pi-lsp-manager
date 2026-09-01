import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerLspCommand } from "../../src/commands/lsp.js";
import type { InstallResult } from "../../src/install/coordinator.js";
import { createShutdownHandler } from "../../src/index.js";
import {
	ToolError,
	type TrustedOperationService,
} from "../../src/tools/shared.js";

function commandHarness(options: {
	trusted?: boolean;
	mode?: ExtensionContext["mode"];
	hasUI?: boolean;
	service?: Partial<TrustedOperationService>;
}) {
	let command:
		| ((raw: string, ctx: ExtensionCommandContext) => Promise<void>)
		| undefined;
	const notify = vi.fn();
	const pi = {
		registerCommand: vi.fn(
			(_name: string, definition: { handler: typeof command }) => {
				command = definition.handler;
			},
		),
	};
	const loaded = {
		config: {
			version: 1,
			network: "offline",
			autoInstall: false,
			postEditDiagnostics: false,
			servers: {},
		},
		paths: { managedStatePath: "managed" },
		globalLayer: "absent",
		projectLayer: "not-read",
	};
	const service = {
		config: vi.fn().mockResolvedValue(loaded),
		statusSnapshot: vi.fn().mockResolvedValue({ loaded, servers: [] }),
		auditSnapshot: vi.fn().mockResolvedValue({ records: 0 }),
		explicitInstall: vi
			.fn()
			.mockResolvedValue({ status: "ready" } as InstallResult),
		warmup: vi.fn().mockResolvedValue(undefined),
		...options.service,
	} as unknown as TrustedOperationService;
	const ctx = {
		cwd: process.cwd(),
		signal: undefined,
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: { notify },
		isProjectTrusted: () => options.trusted ?? true,
	} as unknown as ExtensionCommandContext;
	registerLspCommand(pi as never, service, {
		controllers: new Set(),
		pending: new Set(),
	});
	if (!command) throw new Error("Command was not registered.");
	return { command, ctx, notify, pi, service };
}

describe("/lsp command matrix", () => {
	it.each(["status", "policy", "audit"])(
		"renders %s in TUI and RPC UI contexts",
		async (mode) => {
			for (const uiMode of ["tui", "rpc"] as const) {
				const harness = commandHarness({ mode: uiMode, hasUI: true });
				await harness.command(mode, harness.ctx);
				expect(harness.notify).toHaveBeenCalledTimes(1);
				expect(harness.notify.mock.calls[0]?.[0]).toContain(`LSP ${mode}`);
			}
		},
	);

	it.each([
		["json", "json"],
		["print", "print"],
		["rpc without UI", "rpc"],
	] as const)("does not assume UI in %s", async (_label, mode) => {
		const harness = commandHarness({ mode, hasUI: false });
		await harness.command("status", harness.ctx);
		expect(harness.notify).not.toHaveBeenCalled();
		expect(harness.service.statusSnapshot).not.toHaveBeenCalled();
		expect(harness.service.auditSnapshot).not.toHaveBeenCalled();
	});

	it("keeps untrusted status/policy/audit global-only and never reads project state", async () => {
		const harness = commandHarness({ trusted: false });
		for (const mode of ["status", "policy", "audit"]) {
			await harness.command(mode, harness.ctx);
		}
		expect(harness.service.statusSnapshot).toHaveBeenCalledTimes(2);
		expect(harness.service.statusSnapshot).toHaveBeenCalledWith(
			harness.ctx,
			true,
			expect.any(AbortSignal),
		);
		expect(harness.service.auditSnapshot).toHaveBeenCalledTimes(1);
	});

	it("allows explicit install to use global policy without reading files or starting a server", async () => {
		const harness = commandHarness({ trusted: false });
		await harness.command("install typescript", harness.ctx);
		expect(harness.service.explicitInstall).toHaveBeenCalledWith(
			harness.ctx,
			"typescript",
			expect.any(AbortSignal),
		);
		expect(harness.service.warmup).not.toHaveBeenCalled();
	});

	it("denies untrusted warmup and warms only trusted existing servers", async () => {
		const denied = commandHarness({ trusted: false });
		await denied.command("warmup typescript", denied.ctx);
		expect(denied.service.warmup).not.toHaveBeenCalled();
		expect(denied.notify).toHaveBeenCalledWith(
			"Trust this project before warming an LSP server.",
			"warning",
		);
		const trusted = commandHarness({ trusted: true });
		await trusted.command("warmup typescript", trusted.ctx);
		expect(trusted.service.warmup).toHaveBeenCalledTimes(1);
	});

	it.each([
		["invalid", "wat"],
		["missing id", "install"],
		["free status arg", "status extra"],
		["free install arg", "install typescript extra"],
		["free warmup arg", "warmup typescript extra"],
	])("rejects %s", async (_name, raw) => {
		const harness = commandHarness({});
		await harness.command(raw, harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith(
			"Usage: /lsp status|policy|install <id>|warmup <id>|audit",
			"warning",
		);
		expect(harness.service.statusSnapshot).not.toHaveBeenCalled();
		expect(harness.service.auditSnapshot).not.toHaveBeenCalled();
	});

	it("aborts and awaits an in-flight command during shutdown", async () => {
		let observedSignal: AbortSignal | undefined;
		let release: (() => void) | undefined;
		const pending = new Promise<InstallResult>((resolve) => {
			release = () => resolve({ status: "ready" } as InstallResult);
		});
		const harness = commandHarness({
			service: {
				explicitInstall: vi.fn((_ctx, _id, signal) => {
					observedSignal = signal;
					signal?.addEventListener("abort", () => release?.(), { once: true });
					return pending;
				}),
			},
		});
		const activity = {
			controllers: new Set<AbortController>(),
			pending: new Set<Promise<void>>(),
		};
		// Re-register with the activity tracked by the shutdown handler.
		let command:
			| ((raw: string, ctx: ExtensionCommandContext) => Promise<void>)
			| undefined;
		const pi = {
			registerCommand: vi.fn(
				(_name: string, definition: { handler: typeof command }) => {
					command = definition.handler;
				},
			),
		};
		registerLspCommand(pi as never, harness.service, activity);
		if (!command) throw new Error("Command was not registered.");
		const running = command("install typescript", harness.ctx);
		await vi.waitFor(() => expect(observedSignal).toBeDefined());
		expect(activity.controllers).toHaveLength(1);
		expect(activity.pending).toHaveLength(1);
		await createShutdownHandler(activity)();
		await running;
		expect(activity.controllers).toHaveLength(0);
		expect(activity.pending).toHaveLength(0);
		expect(observedSignal?.aborted).toBe(true);
	});

	it.each([
		[
			new ToolError("server_unavailable", "Install manually."),
			"Install manually.",
		],
		[new Error("LSP failed"), "LSP request failed."],
	])(
		"reports install and LSP failures without throwing",
		async (error, message) => {
			const harness = commandHarness({
				service: { explicitInstall: vi.fn().mockRejectedValue(error) },
			});
			await expect(
				harness.command("install typescript", harness.ctx),
			).resolves.toBeUndefined();
			expect(harness.notify).toHaveBeenCalledWith(message, "warning");
		},
	);
});
