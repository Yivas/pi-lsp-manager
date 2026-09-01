import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import type { EffectiveConfig } from "../../src/contracts.js";
import {
	InstallCoordinator,
	type CoordinatorDependencies,
	type ManagedFileSystem,
	type PackageManager,
	type RunningPackageManager,
} from "../../src/install/coordinator.js";
import { prepareControlledNpmFiles } from "../../src/install/launch.js";
import {
	evaluateInstallPolicy,
	type InstallPolicyInput,
} from "../../src/install/policy.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-lsp-manager-matrix-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	if (!check()) throw new Error("Timed out waiting for test barrier.");
}

function allowedDecision() {
	const decision = evaluateInstallPolicy({
		origin: "tool",
		serverId: "typescript",
		globalConfig: createDefaultConfig(),
		projectTrusted: true,
		platform: "linux",
		architecture: "x64",
	});
	if (!decision.allowed)
		throw new Error("The test policy must allow installation.");
	return decision;
}

class CountingPackageManager implements PackageManager {
	public starts = 0;
	public async start(): Promise<RunningPackageManager> {
		this.starts += 1;
		return {
			completed: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
			terminate: async () => undefined,
		};
	}
}

function defaultVerifier(
	path: string,
	recipe: ReturnType<typeof allowedDecision>["recipe"],
): Promise<{ path: string; version: string } | undefined> {
	return readFile(join(path, "package-lock.json"), "utf8")
		.then(() => ({
			path: join(path, "node_modules", ".bin", recipe.executable),
			version: recipe.expectedVersion,
		}))
		.catch(() => undefined);
}

function coordinator(
	packageManager: PackageManager,
	overrides: Partial<Omit<CoordinatorDependencies, "packageManager">> = {},
): InstallCoordinator {
	return new InstallCoordinator({
		packageManager,
		verifier: overrides.verifier ?? defaultVerifier,
		resolvePackageManagerCommand:
			overrides.resolvePackageManagerCommand ?? (async () => "/safe/npm"),
		random: overrides.random ?? (() => "matrix-nonce"),
		...overrides,
	});
}

async function assertNoOwnedArtifacts(
	root: string,
	revision: string,
	nonce = "matrix-nonce",
): Promise<void> {
	const serverRoot = join(root, "servers", "typescript");
	await expect(
		access(join(root, "locks", `typescript-${revision}.lock`)),
	).rejects.toThrow();
	await expect(
		access(join(serverRoot, `${revision}.partial-${nonce}`)),
	).rejects.toThrow();
	await expect(access(join(serverRoot, revision))).rejects.toThrow();
}

describe("deterministic cancellation matrix", () => {
	it("aborts before waiter work without touching managed state", async () => {
		const root = await temporaryDirectory();
		const controller = new AbortController();
		controller.abort();
		let filesystemCalls = 0;
		const fileSystem: ManagedFileSystem = {
			mkdir: async () => {
				filesystemCalls += 1;
			},
			rename: async () => {
				filesystemCalls += 1;
			},
			rm: async () => {
				filesystemCalls += 1;
			},
		};
		const phases: string[] = [];
		const result = await coordinator(new CountingPackageManager(), {
			fileSystem,
		}).install({
			decision: allowedDecision(),
			managedStatePath: root,
			signal: controller.signal,
			onPhase: (phase) => phases.push(phase),
		});
		expect(result).toEqual({ status: "failed", reason: "cancelled" });
		expect(phases).toEqual(["failed"]);
		expect(filesystemCalls).toBe(0);
	});

	it("aborts during existing-target verification and releases its lock", async () => {
		const root = await temporaryDirectory();
		const recipe = allowedDecision().recipe;
		const target = join(root, "servers", recipe.serverId, recipe.revision);
		const verification = deferred<undefined>();
		let entered = false;
		const phases: string[] = [];
		const controller = new AbortController();
		const instance = coordinator(new CountingPackageManager(), {
			verifier: async (path) => {
				if (path === target) {
					entered = true;
					return verification.promise;
				}
				return undefined;
			},
		});
		const pending = instance.install({
			decision: allowedDecision(),
			managedStatePath: root,
			signal: controller.signal,
			onPhase: (phase) => phases.push(phase),
		});
		await waitFor(() => entered);
		controller.abort();
		verification.resolve(undefined);
		expect(await pending).toEqual({ status: "failed", reason: "cancelled" });
		await instance.shutdown();
		expect(phases).toEqual(["waiting-lock", "verifying", "failed"]);
		await assertNoOwnedArtifacts(root, recipe.revision);
	});

	it("aborts during staging preparation and cleans the partial directory", async () => {
		const root = await temporaryDirectory();
		const preparation = deferred<void>();
		let entered = false;
		const controller = new AbortController();
		const phases: string[] = [];
		const instance = coordinator(new CountingPackageManager(), {
			prepareStaging: async (path, recipe) => {
				const files = await prepareControlledNpmFiles(path, recipe);
				entered = true;
				await preparation.promise;
				return files;
			},
		});
		const pending = instance.install({
			decision: allowedDecision(),
			managedStatePath: root,
			signal: controller.signal,
			onPhase: (phase) => phases.push(phase),
		});
		await waitFor(() => entered);
		controller.abort();
		preparation.resolve();
		expect(await pending).toEqual({ status: "failed", reason: "cancelled" });
		await instance.shutdown();
		expect(phases).toEqual(["waiting-lock", "verifying", "missing", "failed"]);
		await assertNoOwnedArtifacts(root, allowedDecision().recipe.revision);
	});

	it("aborts during staging verification before promotion", async () => {
		const root = await temporaryDirectory();
		const verification = deferred<
			| {
					path: string;
					version: string;
			  }
			| undefined
		>();
		let stagingVerificationEntered = false;
		const recipe = allowedDecision().recipe;
		const controller = new AbortController();
		const phases: string[] = [];
		const manager = new CountingPackageManager();
		const instance = coordinator(manager, {
			verifier: async (path, activeRecipe) => {
				if (path.includes(".partial-")) {
					stagingVerificationEntered = true;
					return verification.promise;
				}
				return defaultVerifier(path, activeRecipe);
			},
		});
		const pending = instance.install({
			decision: allowedDecision(),
			managedStatePath: root,
			signal: controller.signal,
			onPhase: (phase) => phases.push(phase),
		});
		await waitFor(() => stagingVerificationEntered);
		controller.abort();
		verification.resolve({
			path: "staging-executable",
			version: recipe.expectedVersion,
		});
		expect(await pending).toEqual({ status: "failed", reason: "cancelled" });
		await instance.shutdown();
		expect(manager.starts).toBe(1);
		expect(phases).toEqual([
			"waiting-lock",
			"verifying",
			"missing",
			"installing",
			"verifying",
			"failed",
		]);
		await assertNoOwnedArtifacts(root, recipe.revision);
	});

	it("aborts immediately before promotion and does not leave a promoted target", async () => {
		const root = await temporaryDirectory();
		const recipe = allowedDecision().recipe;
		const controller = new AbortController();
		let promotionStarted = false;
		const phases: string[] = [];
		const realFileSystem = { mkdir, rename, rm };
		const instance = coordinator(new CountingPackageManager(), {
			fileSystem: {
				mkdir,
				rm,
				rename: async (from, to) => {
					if (to.endsWith(recipe.revision) && !promotionStarted) {
						promotionStarted = true;
						controller.abort();
					}
					await realFileSystem.rename(from, to);
				},
			},
		});
		const result = await instance.install({
			decision: allowedDecision(),
			managedStatePath: root,
			signal: controller.signal,
			onPhase: (phase) => phases.push(phase),
		});
		expect(result).toEqual({ status: "failed", reason: "cancelled" });
		await instance.shutdown();
		expect(promotionStarted).toBe(true);
		expect(phases.at(-1)).toBe("failed");
		await assertNoOwnedArtifacts(root, recipe.revision);
	});

	it("waits for delayed termination when shutdown interrupts a never-completing manager", async () => {
		const root = await temporaryDirectory();
		const termination = deferred<void>();
		const managerStarted = deferred<void>();
		const terminationStarted = deferred<void>();
		const manager: PackageManager = {
			start: async () => {
				managerStarted.resolve();
				return {
					completed: new Promise(() => undefined),
					terminate: async () => {
						terminationStarted.resolve();
						await termination.promise;
					},
				};
			},
		};
		const instance = coordinator(manager, { installTimeoutMs: 10_000 });
		const pending = instance.install({
			decision: allowedDecision(),
			managedStatePath: root,
		});
		await managerStarted.promise;
		let shutdownFinished = false;
		const shutdown = instance.shutdown().then(() => {
			shutdownFinished = true;
		});
		await terminationStarted.promise;
		expect(shutdownFinished).toBe(false);
		termination.resolve();
		await shutdown;
		expect(shutdownFinished).toBe(true);
		expect(await pending).toEqual({ status: "failed", reason: "cancelled" });
		await assertNoOwnedArtifacts(root, allowedDecision().recipe.revision);
	});
});

describe("installation policy matrix", () => {
	function policyInput(
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

	it("permits trusted tool and post-edit policy but denies untrusted automatic origins", () => {
		expect(evaluateInstallPolicy(policyInput()).allowed).toBe(true);
		expect(
			evaluateInstallPolicy(policyInput({ origin: "post-edit" })).allowed,
		).toBe(true);
		const untrustedPostEdit = evaluateInstallPolicy(
			policyInput({ origin: "post-edit", projectTrusted: false }),
		);
		if (untrustedPostEdit.allowed) throw new Error("Expected policy denial.");
		expect(untrustedPostEdit.reason).toBe("untrusted_project");
	});

	it("denies automatic installation when the server autoInstall flag is false", () => {
		const config = createDefaultConfig();
		const server = config.servers.typescript;
		if (!server) throw new Error("TypeScript catalog entry is required.");
		const disabled = evaluateInstallPolicy(
			policyInput({
				globalConfig: {
					...config,
					servers: { typescript: { ...server, autoInstall: false } },
				},
			}),
		);
		if (disabled.allowed) throw new Error("Expected policy denial.");
		expect(disabled.reason).toBe("auto_install_disabled");
	});

	it("keeps every denied policy decision side-effect free", async () => {
		const base = createDefaultConfig();
		const server = base.servers.typescript;
		if (!server) throw new Error("TypeScript catalog entry is required.");
		const customConfig: EffectiveConfig = {
			...base,
			servers: {
				...base.servers,
				custom: { ...server, id: "custom", admission: "detected" },
			},
		};
		const denied: Array<[string, InstallPolicyInput, string]> = [
			["missing", policyInput({ serverId: "missing" }), "server_missing"],
			[
				"disabled",
				policyInput({
					globalConfig: {
						...base,
						servers: { typescript: { ...server, enabled: false } },
					},
				}),
				"server_disabled",
			],
			[
				"offline",
				policyInput({ globalConfig: { ...base, network: "offline" } }),
				"offline",
			],
			[
				"untrusted",
				policyInput({ projectTrusted: false }),
				"untrusted_project",
			],
			[
				"global autoInstall false",
				policyInput({ globalConfig: { ...base, autoInstall: false } }),
				"auto_install_disabled",
			],
			[
				"server autoInstall false",
				policyInput({
					globalConfig: {
						...base,
						servers: { typescript: { ...server, autoInstall: false } },
					},
				}),
				"auto_install_disabled",
			],
			[
				"unsupported platform",
				policyInput({ platform: "freebsd" }),
				"unsupported_platform",
			],
			[
				"missing recipe",
				policyInput({ serverId: "custom", globalConfig: customConfig }),
				"recipe_missing",
			],
		];
		const packageManager = new CountingPackageManager();
		let managedCalls = 0;
		let lockCalls = 0;
		let auditCalls = 0;
		const fileSystem: ManagedFileSystem = {
			mkdir: async () => {
				managedCalls += 1;
			},
			rename: async () => {
				managedCalls += 1;
			},
			rm: async () => {
				managedCalls += 1;
			},
		};
		const lockFileSystem = {
			open: async () => {
				lockCalls += 1;
				throw new Error("must not open lock");
			},
			readFile: async () => {
				lockCalls += 1;
				throw new Error("must not read lock");
			},
			rename: async () => {
				lockCalls += 1;
			},
			link: async () => {
				lockCalls += 1;
			},
			rm: async () => {
				lockCalls += 1;
			},
		};
		const instance = coordinator(packageManager, {
			fileSystem,
			lockFileSystem,
			audit: async () => {
				auditCalls += 1;
			},
		});
		for (const [name, input, reason] of denied) {
			const decision = evaluateInstallPolicy(input);
			expect(decision, name).toMatchObject({ allowed: false, reason });
			const phases: string[] = [];
			const result = await instance.install({
				decision,
				managedStatePath: await temporaryDirectory(),
				onPhase: (phase) => phases.push(phase),
			});
			expect(result, name).toEqual({ status: "blocked", reason });
			expect(phases, name).toEqual(["blocked"]);
		}
		expect(managedCalls).toBe(0);
		expect(lockCalls).toBe(0);
		expect(auditCalls).toBe(0);
		expect(packageManager.starts).toBe(0);
	});
});
