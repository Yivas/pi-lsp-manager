import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import {
	InstallCoordinator,
	type PackageManager,
} from "../../src/install/coordinator.js";
import {
	evaluateInstallPolicy,
	type InstallOrigin,
	type InstallPolicyInput,
} from "../../src/install/policy.js";

function input(
	overrides: Partial<InstallPolicyInput> = {},
): InstallPolicyInput {
	return {
		origin: "tool",
		serverId: "typescript",
		globalConfig: createDefaultConfig(),
		projectTrusted: true,
		platform: "linux",
		...overrides,
	};
}

function disabled(
	kind: "missing" | "server" | "global-auto" | "server-auto" | "offline",
) {
	const config = createDefaultConfig();
	const server = config.servers.typescript;
	if (!server) throw new Error("TypeScript configuration is required.");
	if (kind === "missing") return { ...config, servers: {} };
	if (kind === "server")
		return {
			...config,
			servers: { typescript: { ...server, enabled: false } },
		};
	if (kind === "global-auto") return { ...config, autoInstall: false };
	if (kind === "server-auto")
		return {
			...config,
			servers: { typescript: { ...server, autoInstall: false } },
		};
	return { ...config, network: "offline" as const };
}

describe("installation policy", () => {
	it.each([
		["missing server", input({ serverId: "missing" }), "server_missing"],
		[
			"disabled server",
			input({ globalConfig: disabled("server") }),
			"server_disabled",
		],
		["offline", input({ globalConfig: disabled("offline") }), "offline"],
		["untrusted tool", input({ projectTrusted: false }), "untrusted_project"],
		[
			"global auto-install",
			input({ globalConfig: disabled("global-auto") }),
			"auto_install_disabled",
		],
		[
			"server auto-install",
			input({ globalConfig: disabled("server-auto") }),
			"auto_install_disabled",
		],
		[
			"unsupported platform",
			input({ platform: "freebsd" }),
			"unsupported_platform",
		],
	] as const)("denies %s", (_name, policyInput, reason) => {
		expect(evaluateInstallPolicy(policyInput)).toMatchObject({
			allowed: false,
			reason,
		});
	});

	it.each(["tool", "post-edit"] as const)(
		"requires trust and auto-install for %s",
		(origin: InstallOrigin) => {
			expect(
				evaluateInstallPolicy(input({ origin, projectTrusted: false })),
			).toMatchObject({ allowed: false, reason: "untrusted_project" });
			expect(
				evaluateInstallPolicy(
					input({ origin, globalConfig: disabled("server-auto") }),
				),
			).toMatchObject({ allowed: false, reason: "auto_install_disabled" });
		},
	);

	it("explicit install ignores only trust and auto-install, never global enabled/offline gates", () => {
		expect(
			evaluateInstallPolicy(
				input({
					origin: "explicit",
					projectTrusted: false,
					globalConfig: disabled("global-auto"),
				}),
			),
		).toMatchObject({ allowed: true });
		expect(
			evaluateInstallPolicy(
				input({
					origin: "explicit",
					projectTrusted: false,
					globalConfig: disabled("offline"),
				}),
			),
		).toMatchObject({ allowed: false, reason: "offline" });
		expect(
			evaluateInstallPolicy(
				input({
					origin: "explicit",
					projectTrusted: false,
					globalConfig: disabled("server"),
				}),
			),
		).toMatchObject({ allowed: false, reason: "server_disabled" });
	});

	it("leaves every side-effect seam untouched for policy denials", async () => {
		let touched = 0;
		const process: PackageManager = {
			start: async () => {
				touched += 1;
				throw new Error("must not start");
			},
		};
		const coordinator = new InstallCoordinator({
			packageManager: process,
			verifier: async () => undefined,
			fileSystem: {
				mkdir: async () => {
					touched += 1;
				},
				rename: async () => {
					touched += 1;
				},
				rm: async () => {
					touched += 1;
				},
			},
			lockFileSystem: {
				open: async () => {
					touched += 1;
					throw new Error("must not lock");
				},
				readFile: async () => "",
				rename: async () => undefined,
				link: async () => undefined,
				rm: async () => undefined,
			},
			audit: async () => {
				touched += 1;
			},
		});
		for (const decision of [
			evaluateInstallPolicy(input({ serverId: "missing" })),
			evaluateInstallPolicy(input({ globalConfig: disabled("server") })),
			evaluateInstallPolicy(input({ globalConfig: disabled("offline") })),
			evaluateInstallPolicy(input({ globalConfig: disabled("global-auto") })),
			evaluateInstallPolicy(input({ globalConfig: disabled("server-auto") })),
			evaluateInstallPolicy(input({ projectTrusted: false })),
			evaluateInstallPolicy(input({ platform: "freebsd" })),
		]) {
			expect(
				(await coordinator.install({ decision, managedStatePath: "/not-used" }))
					.status,
			).toBe("blocked");
		}
		expect(touched).toBe(0);
	});
});
