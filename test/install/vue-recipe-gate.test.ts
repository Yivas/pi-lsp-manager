import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import type { AuditRecord } from "../../src/install/audit.js";
import {
	getRecipe,
	getRecipeRevision,
	type InstallRecipe,
	VUE_RECIPE,
} from "../../src/install/catalog.js";
import {
	type CoordinatorDependencies,
	InstallCoordinator,
	type ManagedFileSystem,
	type PackageManager,
	type RunningPackageManager,
} from "../../src/install/coordinator.js";
import type { PackageManagerLaunch } from "../../src/install/launch.js";
import { evaluateInstallPolicy } from "../../src/install/policy.js";
import type {
	InstallationVerifier,
	InstalledExecutable,
} from "../../src/install/verify.js";

// The frozen Vue recipe is injected through the request decision because RECIPES
// does not expose it. That keeps the real policy denial in place while the whole
// staging, lock, install, verification, rollback, and cancellation path runs.

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		// Bounded retry: Windows can hold transient handles on managed directories.
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 50,
		});
	}
});

const VUE_INSTALL_DECISION = { allowed: true, recipe: VUE_RECIPE } as const;

type Outcome = { exitCode: number; stdout: string; stderr: string };

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class FakePackageManager implements PackageManager {
	public starts = 0;
	public terminateCalls = 0;
	public holdStart = false;
	public readonly launches: PackageManagerLaunch[] = [];
	public readonly started = deferred();

	public start(
		launch: PackageManagerLaunch,
		signal: AbortSignal,
	): Promise<RunningPackageManager> {
		this.starts += 1;
		this.launches.push(launch);
		this.started.resolve();
		return new Promise<RunningPackageManager>((resolve, reject) => {
			let settle: ((outcome: Outcome) => void) | undefined;
			const completed = new Promise<Outcome>((done) => {
				settle = done;
			});
			const handle: RunningPackageManager = {
				completed,
				terminate: async () => {
					this.terminateCalls += 1;
					settle?.({ exitCode: 143, stdout: "", stderr: "terminated" });
				},
			};
			if (!this.holdStart) {
				settle?.({ exitCode: 0, stdout: "", stderr: "" });
				resolve(handle);
				return;
			}
			// Stay pending until the caller aborts, so cancellation lands inside start.
			const abort = () => reject(new Error("start_aborted"));
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		});
	}
}

/** Exits successfully only when the test releases it, so a cancellation can land
 * in the window right after the package manager finished. */
class DelayedExitPackageManager implements PackageManager {
	public starts = 0;
	public readonly started = deferred();
	private releaseExit!: (outcome: Outcome) => void;
	private readonly completed = new Promise<Outcome>((done) => {
		this.releaseExit = done;
	});

	public start(): Promise<RunningPackageManager> {
		this.starts += 1;
		this.started.resolve();
		return Promise.resolve({
			completed: this.completed,
			terminate: async () => {
				this.releaseExit({
					exitCode: 143,
					stdout: "",
					stderr: "terminated",
				});
			},
		});
	}

	/** Completes the installation successfully, as a finished `npm ci` does. */
	public exitSuccessfully(): void {
		this.releaseExit({ exitCode: 0, stdout: "", stderr: "" });
	}
}

/** Accepts only a directory that already carries the controlled recipe files. */
async function verifiedInstallation(
	path: string,
	recipe: InstallRecipe,
): Promise<InstalledExecutable | undefined> {
	const staged = await readFile(join(path, "package-lock.json"), "utf8").then(
		() => true,
		() => false,
	);
	return staged
		? {
				path: join(path, "node_modules", ".bin", recipe.executable),
				version: recipe.expectedVersion,
			}
		: undefined;
}

/** Fails only the promoted revision, so the post-commit rollback branch runs. */
function promoteFailingVerifier(): InstallationVerifier {
	return async (path, recipe) =>
		basename(path) === recipe.revision
			? undefined
			: verifiedInstallation(path, recipe);
}

/** Keeps every filesystem operation real except the return of a quarantined copy. */
function quarantineRestoreFailure(): ManagedFileSystem {
	return {
		mkdir,
		rm,
		rename: async (from, to) => {
			if (from.includes(".invalid-")) throw new Error("restore_failed");
			await rename(from, to);
		},
	};
}

/** Writes a committed revision that predates the installation under test. */
async function previousInstallation(managed: string): Promise<void> {
	await mkdir(revisionTarget(managed), { recursive: true });
	await writeFile(
		join(revisionTarget(managed), "previous-install.txt"),
		"keep\n",
	);
}

function coordinator(
	packageManager: PackageManager,
	overrides: Partial<Omit<CoordinatorDependencies, "packageManager">> = {},
): InstallCoordinator {
	return new InstallCoordinator({
		packageManager,
		verifier: overrides.verifier ?? verifiedInstallation,
		resolvePackageManagerCommand:
			overrides.resolvePackageManagerCommand ?? (async () => "/safe/npm"),
		random: overrides.random ?? (() => "vue-gate-nonce"),
		...overrides,
	});
}

function serverRoot(managed: string): string {
	return join(managed, "servers", VUE_RECIPE.serverId);
}

function revisionTarget(managed: string): string {
	return join(serverRoot(managed), VUE_RECIPE.revision);
}

function lockPath(managed: string): string {
	return join(
		managed,
		"locks",
		`${VUE_RECIPE.serverId}-${VUE_RECIPE.revision}.lock`,
	);
}

async function auditRecords(managed: string): Promise<AuditRecord[]> {
	const text = await readFile(
		join(managed, "audit", "install.audit.jsonl"),
		"utf8",
	);
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as AuditRecord);
}

async function expectNoOwnedArtifacts(managed: string): Promise<void> {
	await expect(access(revisionTarget(managed))).rejects.toThrow();
	await expect(access(lockPath(managed))).rejects.toThrow();
	// Neither the promoted revision nor a leftover .partial-<nonce> directory.
	expect(await readdir(serverRoot(managed))).toEqual([]);
}

describe("Vue recipe gate without admission", () => {
	it("keeps the real Vue policy denied while the recipe stays out of the registry", () => {
		const decision = evaluateInstallPolicy({
			origin: "tool",
			serverId: "vue",
			globalConfig: createDefaultConfig(),
			projectTrusted: true,
			platform: "linux",
			architecture: "x64",
		});
		expect(decision).toMatchObject({
			allowed: false,
			reason: "recipe_missing",
		});
		expect(getRecipe("vue")).toBeUndefined();
		expect(getRecipeRevision("vue")).toBeUndefined();
		// The frozen recipe exists and claims auto-installable; the guard is that
		// RECIPES still does not expose it.
		expect(VUE_RECIPE).toMatchObject({
			serverId: "vue",
			admission: "auto-installable",
		});
	});

	it("cancels a Vue installation during package-manager start without owned state", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-vue-gate-cancel-"),
			"managed",
		);
		const manager = new FakePackageManager();
		manager.holdStart = true;
		const controller = new AbortController();
		const phases: string[] = [];
		const instance = coordinator(manager);
		const pending = instance.install({
			decision: VUE_INSTALL_DECISION,
			managedStatePath: managed,
			signal: controller.signal,
			onPhase: (phase) => phases.push(phase),
		});
		await manager.started.promise;
		controller.abort();
		expect(await pending).toEqual({ status: "failed", reason: "cancelled" });
		await instance.shutdown();
		expect(manager.starts).toBe(1);
		expect(phases).toEqual([
			"waiting-lock",
			"verifying",
			"missing",
			"installing",
			"failed",
		]);
		await expectNoOwnedArtifacts(managed);
		expect(await auditRecords(managed)).toEqual([
			expect.objectContaining({
				serverId: "vue",
				revision: VUE_RECIPE.revision,
				result: "cancelled",
			}),
		]);
	});

	it("leaves no owned Vue state when the cancellation lands right after the package manager exits", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-vue-gate-exit-abort-"),
			"managed",
		);
		const staging = join(
			serverRoot(managed),
			`${VUE_RECIPE.revision}.partial-vue-gate-nonce`,
		);
		const manager = new DelayedExitPackageManager();
		const controller = new AbortController();
		// Hold the staging removal open so this test can read the state the caller
		// owns while the coordinator is still cleaning up.
		const removalStarted = deferred();
		const removalGate = deferred();
		const fileSystem: ManagedFileSystem = {
			mkdir,
			rename,
			rm: async (path, options) => {
				if (path === staging) {
					removalStarted.resolve();
					await removalGate.promise;
				}
				await rm(path, options);
			},
		};
		const instance = coordinator(manager, {
			fileSystem,
			// Cancelling while the staged installation of a successful package-manager
			// exit is verified reproduces "aborted right after `npm ci` finished".
			verifier: async (path, recipe) => {
				if (path === staging) {
					controller.abort();
					return undefined;
				}
				return verifiedInstallation(path, recipe);
			},
		});
		const pending = instance.install({
			decision: VUE_INSTALL_DECISION,
			managedStatePath: managed,
			signal: controller.signal,
		});
		await manager.started.promise;
		manager.exitSuccessfully();
		try {
			expect(await pending).toEqual({ status: "failed", reason: "cancelled" });
			await removalStarted.promise;
			// The caller received `cancelled` while the staging removal is still
			// pending: an aborting join resolves without waiting for the coordinator
			// to drain its cleanup, so the managed state must be read after shutdown.
			await expect(access(staging)).resolves.toBeUndefined();
		} finally {
			removalGate.resolve();
			await instance.shutdown();
		}
		await expectNoOwnedArtifacts(managed);
		expect(await auditRecords(managed)).toEqual([
			expect.objectContaining({
				serverId: "vue",
				revision: VUE_RECIPE.revision,
				result: "cancelled",
			}),
		]);
	});

	it("rolls back a failed Vue verification and releases its lock", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-vue-gate-rollback-"),
			"managed",
		);
		const manager = new FakePackageManager();
		const instance = coordinator(manager, { verifier: async () => undefined });
		const result = await instance.install({
			decision: VUE_INSTALL_DECISION,
			managedStatePath: managed,
		});
		expect(result).toEqual({
			status: "failed",
			reason: "verification_failed",
		});
		await instance.shutdown();
		expect(manager.starts).toBe(1);
		await expectNoOwnedArtifacts(managed);
		expect(await auditRecords(managed)).toEqual([
			expect.objectContaining({
				serverId: "vue",
				revision: VUE_RECIPE.revision,
				phase: "failed",
				result: "failed",
			}),
		]);
	});

	it("restores the previous Vue installation when post-commit verification fails", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-vue-gate-quarantine-"),
			"managed",
		);
		await previousInstallation(managed);
		const manager = new FakePackageManager();
		const instance = coordinator(manager, {
			verifier: promoteFailingVerifier(),
		});
		const result = await instance.install({
			decision: VUE_INSTALL_DECISION,
			managedStatePath: managed,
		});
		await instance.shutdown();
		expect(result.status).toBe("failed");
		expect(result.reason).toContain(
			"Promoted installation verification failed",
		);
		// The promotion is undone: the staged revision returns to staging and the
		// quarantined copy comes back, so the previous installation survives.
		expect(
			await readFile(
				join(revisionTarget(managed), "previous-install.txt"),
				"utf8",
			),
		).toBe("keep\n");
		expect(manager.starts).toBe(1);
		expect(await readdir(serverRoot(managed))).toEqual([VUE_RECIPE.revision]);
		await expect(access(lockPath(managed))).rejects.toThrow();
		expect(await auditRecords(managed)).toEqual([
			expect.objectContaining({
				serverId: "vue",
				revision: VUE_RECIPE.revision,
				phase: "failed",
				result: "failed",
			}),
		]);
	});

	it("preserves the quarantined Vue copy and reports an incomplete rollback", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-vue-gate-quarantine-failed-"),
			"managed",
		);
		await previousInstallation(managed);
		const manager = new FakePackageManager();
		const instance = coordinator(manager, {
			verifier: promoteFailingVerifier(),
			fileSystem: quarantineRestoreFailure(),
		});
		const result = await instance.install({
			decision: VUE_INSTALL_DECISION,
			managedStatePath: managed,
		});
		await instance.shutdown();
		expect(result).toEqual({
			status: "failed",
			reason: "rollback_incomplete",
		});
		// The copy that could not return stays under .invalid-<nonce> for manual
		// repair instead of being deleted together with the failed staging.
		const entries = await readdir(serverRoot(managed));
		expect(entries).toHaveLength(1);
		const quarantined = entries[0] ?? "";
		expect(quarantined).toContain(`${VUE_RECIPE.revision}.invalid-`);
		expect(
			await readFile(
				join(serverRoot(managed), quarantined, "previous-install.txt"),
				"utf8",
			),
		).toBe("keep\n");
		await expect(access(lockPath(managed))).rejects.toThrow();
		expect(await auditRecords(managed)).toEqual([
			expect.objectContaining({
				serverId: "vue",
				revision: VUE_RECIPE.revision,
				phase: "failed",
				result: "failed",
			}),
		]);
	});

	it("starts one package manager for concurrent Vue callers", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-vue-gate-singleflight-"),
			"managed",
		);
		const manager = new FakePackageManager();
		const instance = coordinator(manager);
		const [first, second] = await Promise.all([
			instance.install({
				decision: VUE_INSTALL_DECISION,
				managedStatePath: managed,
			}),
			instance.install({
				decision: VUE_INSTALL_DECISION,
				managedStatePath: managed,
			}),
		]);
		expect(manager.starts).toBe(1);
		expect(first.status, first.reason).toBe("ready");
		expect(second.status, second.reason).toBe("ready");
		await instance.shutdown();
		expect(await readdir(serverRoot(managed))).toEqual([VUE_RECIPE.revision]);
		await expect(access(lockPath(managed))).rejects.toThrow();
		expect(await auditRecords(managed)).toHaveLength(1);
	});

	it("promotes a verified Vue installation with the pinned dependencies", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-vue-gate-ready-"),
			"managed",
		);
		const manager = new FakePackageManager();
		const instance = coordinator(manager);
		const result = await instance.install({
			decision: VUE_INSTALL_DECISION,
			managedStatePath: managed,
		});
		await instance.shutdown();
		const target = revisionTarget(managed);
		expect(result.status, result.reason).toBe("ready");
		expect(result.executable).toEqual({
			path: join(target, "node_modules", ".bin", VUE_RECIPE.executable),
			version: "3.3.11",
		});
		const launch = manager.launches[0];
		expect(launch?.args[0]).toBe("ci");
		expect(launch?.args).toContain(VUE_RECIPE.registry);
		expect(launch?.cwd).toContain(`${VUE_RECIPE.revision}.partial-`);
		const manifest = JSON.parse(
			await readFile(join(target, "package.json"), "utf8"),
		) as { dependencies: Record<string, string> };
		expect(manifest.dependencies["@vue/language-server"]).toBe("3.3.11");
		expect(manifest.dependencies["@vue/typescript-plugin"]).toBe("3.3.11");
		await expect(access(lockPath(managed))).rejects.toThrow();
		expect(await auditRecords(managed)).toEqual([
			expect.objectContaining({ result: "ready", phase: "ready" }),
		]);
	});
});
