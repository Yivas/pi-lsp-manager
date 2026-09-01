import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import type { EffectiveConfig } from "../../src/contracts.js";
import { TrustedOperationService } from "../../src/tools/shared.js";

const config: EffectiveConfig = {
	version: 1,
	network: "offline",
	autoInstall: false,
	postEditDiagnostics: false,
	servers: {
		missing: {
			id: "missing",
			enabled: true,
			autoInstall: false,
			priority: 10,
			route: { command: "missing-ls", args: [] },
			extensions: [".test"],
			roles: ["diagnostics"],
			languageIds: ["test"],
			admission: "candidate",
			manualHelp: "Install manually.",
		},
		disabled: {
			id: "disabled",
			enabled: false,
			autoInstall: false,
			priority: 5,
			route: { command: "available-ls", args: [] },
			extensions: [".test"],
			roles: ["diagnostics"],
			languageIds: ["test"],
			admission: "candidate",
			manualHelp: "Install manually.",
		},
	},
};

function context(): ExtensionContext {
	return {
		cwd: "/workspace",
		signal: undefined,
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
}

describe("safe status snapshot", () => {
	it("distinguishes configured routes, availability, and runnable state", async () => {
		const coordinator = vi.fn();
		const service = new TrustedOperationService({
			coordinator,
			pool: () => undefined,
			load: async () => ({
				config,
				paths: {
					globalConfigPath: "global",
					projectConfigPath: "project",
					managedStatePath: "managed",
				},
				globalLayer: "valid",
				projectLayer: "absent",
			}),
			resolveCommand: async (command) =>
				command === "available-ls" ? "/safe/available-ls" : undefined,
		});

		const snapshot = await service.statusSnapshot(context());
		expect(snapshot.servers).toEqual([
			expect.objectContaining({
				id: "disabled",
				available: true,
				routeConfigured: true,
				runnable: false,
			}),
			expect.objectContaining({
				id: "missing",
				available: false,
				routeConfigured: true,
				runnable: false,
			}),
		]);
		expect(JSON.stringify(snapshot.servers)).not.toContain("/safe/");
		expect(coordinator).not.toHaveBeenCalled();
	});

	it("warms a verified managed executable when the route is absent from PATH", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-warmup-"));
		try {
			const acquire = vi.fn(async () => ({
				entry: {},
				lease: { release: vi.fn() },
			}));
			const verifyInstallation = vi.fn(async () => ({
				path: "/managed/typescript-language-server",
				version: "5.3.0",
			}));
			const service = new TrustedOperationService({
				coordinator: () => undefined,
				pool: () => ({ acquire }) as never,
				load: async () => ({
					config: createDefaultConfig(),
					paths: {
						globalConfigPath: "global",
						projectConfigPath: "project",
						managedStatePath: "managed",
					},
					globalLayer: "absent",
					projectLayer: "absent",
				}),
				resolveCommand: async () => undefined,
				verifyInstallation,
			});
			await service.warmup({ ...context(), cwd }, "typescript");
			expect(verifyInstallation).toHaveBeenCalledTimes(1);
			expect(acquire).toHaveBeenCalledWith(
				expect.any(String),
				"typescript",
				expect.any(Function),
				undefined,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
