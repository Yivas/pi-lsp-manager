import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import {
	getRecipe,
	INACTIVE_PYTHON_RECIPES,
} from "../../src/install/catalog.js";
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
		architecture: "x64",
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
		[
			"untested architecture",
			input({ architecture: "arm64" }),
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

	it("gates the admitted Vue recipe with the same denials as the built-in one", () => {
		const config = createDefaultConfig();
		const vue = config.servers.vue;
		if (!vue) throw new Error("Vue configuration is required.");
		const denials: readonly [string, InstallPolicyInput, string][] = [
			[
				"untrusted tool",
				input({ serverId: "vue", projectTrusted: false }),
				"untrusted_project",
			],
			[
				"offline",
				input({
					serverId: "vue",
					globalConfig: { ...config, network: "offline" },
				}),
				"offline",
			],
			[
				"disabled server",
				input({
					serverId: "vue",
					globalConfig: {
						...config,
						servers: { vue: { ...vue, enabled: false } },
					},
				}),
				"server_disabled",
			],
			[
				"global auto-install",
				input({
					serverId: "vue",
					globalConfig: { ...config, autoInstall: false },
				}),
				"auto_install_disabled",
			],
			[
				"server auto-install",
				input({
					serverId: "vue",
					globalConfig: {
						...config,
						servers: { vue: { ...vue, autoInstall: false } },
					},
				}),
				"auto_install_disabled",
			],
			[
				"unsupported platform",
				input({ serverId: "vue", platform: "freebsd" }),
				"unsupported_platform",
			],
		];
		for (const [name, policyInput, reason] of denials)
			expect(evaluateInstallPolicy(policyInput), name).toMatchObject({
				allowed: false,
				reason,
			});
		// Explicit `/lsp install vue` keeps ignoring trust and auto-install while it
		// still honors the global enabled and network gates.
		expect(
			evaluateInstallPolicy(
				input({
					serverId: "vue",
					origin: "explicit",
					projectTrusted: false,
					globalConfig: { ...config, autoInstall: false },
				}),
			),
		).toMatchObject({ allowed: true });
		expect(
			evaluateInstallPolicy(
				input({
					serverId: "vue",
					origin: "explicit",
					projectTrusted: false,
					globalConfig: { ...config, network: "offline" },
				}),
			),
		).toMatchObject({ allowed: false, reason: "offline" });
		expect(
			evaluateInstallPolicy(
				input({
					serverId: "vue",
					origin: "explicit",
					projectTrusted: false,
					globalConfig: {
						...config,
						servers: { vue: { ...vue, enabled: false } },
					},
				}),
			),
		).toMatchObject({ allowed: false, reason: "server_disabled" });
	});

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

describe("active format installation policy", () => {
	it("keeps the ordinary denials for the activated JSON and YAML recipes", () => {
		const config = createDefaultConfig();
		for (const serverId of [
			"vscode-json-language-server",
			"yaml-language-server",
		] as const) {
			const server = config.servers[serverId];
			if (!server) throw new Error(`${serverId} configuration is required.`);
			const denials: readonly [string, InstallPolicyInput, string][] = [
				[
					"untrusted tool",
					input({ serverId, projectTrusted: false }),
					"untrusted_project",
				],
				[
					"offline",
					input({
						serverId,
						globalConfig: { ...config, network: "offline" },
					}),
					"offline",
				],
				[
					"disabled server",
					input({
						serverId,
						globalConfig: {
							...config,
							servers: { [serverId]: { ...server, enabled: false } },
						},
					}),
					"server_disabled",
				],
				[
					"global auto-install",
					input({
						serverId,
						globalConfig: { ...config, autoInstall: false },
					}),
					"auto_install_disabled",
				],
				[
					"server auto-install",
					input({
						serverId,
						globalConfig: {
							...config,
							servers: { [serverId]: { ...server, autoInstall: false } },
						},
					}),
					"auto_install_disabled",
				],
				[
					"unsupported platform",
					input({ serverId, platform: "freebsd" }),
					"unsupported_platform",
				],
			];
			for (const [name, policyInput, reason] of denials)
				expect(
					evaluateInstallPolicy(policyInput),
					`${serverId}:${name}`,
				).toMatchObject({ allowed: false, reason });
		}
	});

	it("admits managed installation for both activated formats at every origin", () => {
		for (const serverId of [
			"vscode-json-language-server",
			"yaml-language-server",
		] as const) {
			for (const origin of ["tool", "post-edit", "explicit"] as const) {
				const decision = evaluateInstallPolicy(input({ serverId, origin }));
				expect(decision, `${serverId}:${origin}`).toMatchObject({
					allowed: true,
				});
				if (!decision.allowed)
					throw new Error(`The ${serverId} recipe must be admitted.`);
				expect(decision.recipe.serverId).toBe(serverId);
			}
		}
	});
});

describe("Python installation policy", () => {
	const recipeLookup = (serverId: string) =>
		serverId === "ty" ? INACTIVE_PYTHON_RECIPES.ty : getRecipe(serverId);

	it("keeps the inactive candidate at recipe_missing for every origin", () => {
		for (const origin of ["tool", "post-edit", "explicit"] as const) {
			const decision = evaluateInstallPolicy(input({ serverId: "ty", origin }));
			expect(decision, origin).toMatchObject({
				allowed: false,
				reason: "recipe_missing",
			});
		}
	});

	it("denies an admitted Python recipe without the global interpreter", () => {
		// The trust and auto-install gates now precede the interpreter gate, so enable
		// auto-install for the tool origin to reach the interpreter denial.
		const config = createDefaultConfig();
		const ty = config.servers.ty;
		if (!ty) throw new Error("ty configuration is required.");
		const enabled = {
			...config,
			autoInstall: true,
			servers: { ...config.servers, ty: { ...ty, autoInstall: true } },
		};
		for (const origin of ["tool", "post-edit"] as const) {
			const decision = evaluateInstallPolicy(
				input({ serverId: "ty", origin, globalConfig: enabled, recipeLookup }),
			);
			expect(decision, origin).toMatchObject({
				allowed: false,
				reason: "package_manager_missing",
			});
			if (!decision.allowed)
				expect(decision.manualHelp).toContain("trusted installer interpreter");
		}
		// Explicit install skips trust and auto-install and still reports the interpreter.
		const explicit = evaluateInstallPolicy(
			input({ serverId: "ty", origin: "explicit", recipeLookup }),
		);
		expect(explicit).toMatchObject({
			allowed: false,
			reason: "package_manager_missing",
		});
		if (!explicit.allowed)
			expect(explicit.manualHelp).toContain("trusted installer interpreter");
	});

	it("reports trust and auto-install denials before the missing interpreter", () => {
		// An untrusted tool with an admitted Python recipe and no interpreter: trust wins,
		// matching the historical `untrusted_project` message.
		expect(
			evaluateInstallPolicy(
				input({ serverId: "ty", projectTrusted: false, recipeLookup }),
			),
		).toMatchObject({ allowed: false, reason: "untrusted_project" });
		// Auto-install disabled with the same recipe and no interpreter: that denial wins.
		expect(
			evaluateInstallPolicy(
				input({
					serverId: "ty",
					globalConfig: disabled("global-auto"),
					recipeLookup,
				}),
			),
		).toMatchObject({ allowed: false, reason: "auto_install_disabled" });
		// An explicit install skips both and still reports the missing interpreter.
		expect(
			evaluateInstallPolicy(
				input({
					serverId: "ty",
					origin: "explicit",
					projectTrusted: false,
					globalConfig: disabled("global-auto"),
					recipeLookup,
				}),
			),
		).toMatchObject({ allowed: false, reason: "package_manager_missing" });
	});

	it("rejects an unsupported platform before the interpreter gate", () => {
		expect(
			evaluateInstallPolicy(
				input({
					serverId: "ty",
					platform: "freebsd",
					pythonInterpreter: "/usr/bin/python3",
					recipeLookup,
				}),
			),
		).toMatchObject({ allowed: false, reason: "unsupported_platform" });
	});

	it("cuts offline before trust, auto-install and the interpreter gate", () => {
		expect(
			evaluateInstallPolicy(
				input({
					serverId: "ty",
					globalConfig: { ...createDefaultConfig(), network: "offline" },
					pythonInterpreter: "/usr/bin/python3",
					projectTrusted: false,
					recipeLookup,
				}),
			),
		).toMatchObject({ allowed: false, reason: "offline" });
	});

	it("admits an explicit Python install only with the interpreter and the global gates", () => {
		expect(
			evaluateInstallPolicy(
				input({
					serverId: "ty",
					origin: "explicit",
					pythonInterpreter: "/usr/bin/python3",
					projectTrusted: false,
					recipeLookup,
				}),
			),
		).toMatchObject({ allowed: true });
		expect(
			evaluateInstallPolicy(
				input({
					serverId: "ty",
					pythonInterpreter: "/usr/bin/python3",
					recipeLookup,
				}),
			),
		).toMatchObject({ allowed: false, reason: "auto_install_disabled" });
	});
});
