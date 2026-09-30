import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditRecord } from "../../src/install/audit.js";
import { INACTIVE_PYTHON_RECIPES } from "../../src/install/catalog.js";
import {
	type CoordinatorDependencies,
	InstallCoordinator,
	type PackageManager,
	type RunningPackageManager,
} from "../../src/install/coordinator.js";
import type { PackageManagerLaunch } from "../../src/install/launch.js";
import type { InstallationVerifier } from "../../src/install/verify.js";

// The frozen Python recipe is injected through the request decision so the whole staging,
// lock, install, verification, rollback and cancellation path runs deterministically. The
// real policy keeps denying `ty` with `recipe_missing`; that is asserted in the policy suite.

const RECIPE = INACTIVE_PYTHON_RECIPES.ty;
const INTERPRETER = "C:/Tools/Python312/python.exe";
const DECISION = { allowed: true, recipe: RECIPE } as const;

type Outcome = { exitCode: number; stdout: string; stderr: string };

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true, maxRetries: 10 });
	}
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Exits successfully on request; keeps `completed` pending so a cancellation lands mid-install. */
class FakePackageManager implements PackageManager {
	public starts = 0;
	public terminateCalls = 0;
	public holdStart = false;
	public terminateConfirmed = true;
	public readonly launches: PackageManagerLaunch[] = [];
	public readonly started = deferred();

	public start(
		launch: PackageManagerLaunch,
		_signal: AbortSignal,
	): Promise<RunningPackageManager> {
		this.starts += 1;
		this.launches.push(launch);
		this.started.resolve();
		let settle!: (outcome: Outcome) => void;
		const completed = new Promise<Outcome>((done) => {
			settle = done;
		});
		const handle: RunningPackageManager = {
			completed,
			terminate: async () => {
				this.terminateCalls += 1;
				settle({ exitCode: 143, stdout: "", stderr: "terminated" });
				return { confirmed: this.terminateConfirmed };
			},
		};
		if (!this.holdStart) settle({ exitCode: 0, stdout: "", stderr: "" });
		return Promise.resolve(handle);
	}
}

/** Accepts only a directory that already carries the controlled requirement file. */
const verifiedInstallation: InstallationVerifier = async (path, recipe) => {
	if (recipe.kind !== "python") return undefined;
	const staged = await readFile(join(path, "requirements.txt"), "utf8").then(
		() => true,
		() => false,
	);
	return staged
		? {
				path: join(path, "bin", recipe.executable),
				version: recipe.expectedVersion,
			}
		: undefined;
};

/** Fails only the promoted revision, so the post-commit rollback branch runs. */
function promoteFailingVerifier(): InstallationVerifier {
	return async (path, recipe) => {
		if (recipe.kind === "python" && basename(path) === recipe.revision)
			return undefined;
		return verifiedInstallation(path, recipe, new AbortController().signal);
	};
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
		platform: overrides.platform ?? "linux",
		architecture: overrides.architecture ?? "x64",
		random: overrides.random ?? (() => "py-gate-nonce"),
		terminationBudgetMs: overrides.terminationBudgetMs ?? 50,
		...overrides,
	});
}

function serverRoot(managed: string): string {
	return join(managed, "servers", RECIPE.serverId);
}

function revisionTarget(managed: string): string {
	return join(serverRoot(managed), RECIPE.revision);
}

function stagingPath(managed: string): string {
	return join(serverRoot(managed), `${RECIPE.revision}.partial-py-gate-nonce`);
}

function lockPath(managed: string): string {
	return join(managed, "locks", `${RECIPE.serverId}-${RECIPE.revision}.lock`);
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

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

describe("Python recipe gate with admission", () => {
	it("refuses a missing trusted interpreter without creating any managed state", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-py-gate-missing-"),
			"managed",
		);
		const manager = new FakePackageManager();
		const phases: string[] = [];
		const result = await coordinator(manager).install({
			decision: DECISION,
			managedStatePath: managed,
			onPhase: (phase) => phases.push(phase),
		});
		expect(result).toEqual({
			status: "failed",
			reason: "package_manager_missing",
		});
		expect(manager.starts).toBe(0);
		expect(phases).toEqual(["failed"]);
		// No managed directory, no lock, no staging and no audit record exist at all.
		expect(await exists(managed)).toBe(false);
	});

	it("refuses a platform outside the frozen targets before any managed state", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-py-gate-platform-"),
			"managed",
		);
		const manager = new FakePackageManager();
		const result = await coordinator(manager, {
			platform: "freebsd",
		}).install({
			decision: DECISION,
			managedStatePath: managed,
			pythonInterpreter: INTERPRETER,
		});
		expect(result).toEqual({
			status: "failed",
			reason: "unsupported_platform",
		});
		expect(manager.starts).toBe(0);
		expect(await exists(managed)).toBe(false);
	});

	it("stages, promotes and audits one hashed wheel through the real filesystem", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-py-gate-ready-"),
			"managed",
		);
		const manager = new FakePackageManager();
		const instance = coordinator(manager);
		const result = await instance.install({
			decision: DECISION,
			managedStatePath: managed,
			pythonInterpreter: INTERPRETER,
		});
		expect(result).toMatchObject({
			status: "ready",
			executable: {
				path: join(revisionTarget(managed), "bin", "ty"),
				version: RECIPE.expectedVersion,
			},
		});
		expect(manager.starts).toBe(1);
		const launch = manager.launches[0];
		expect(launch?.command).toBe(INTERPRETER);
		expect(launch?.cwd).toBe(stagingPath(managed));
		expect(launch?.env.PIP_CONFIG_FILE).toBe("/dev/null");
		expect(launch?.args).toEqual(
			expect.arrayContaining([
				"-m",
				"pip",
				"install",
				"--require-hashes",
				"--no-deps",
			]),
		);
		const promoted = await readFile(
			join(revisionTarget(managed), "requirements.txt"),
			"utf8",
		);
		expect(promoted).toContain("ty-0.0.84");
		expect(await exists(stagingPath(managed))).toBe(false);
		expect(await exists(lockPath(managed))).toBe(false);
		expect(await auditRecords(managed)).toEqual([
			expect.objectContaining({
				serverId: "ty",
				revision: RECIPE.revision,
				phase: "ready",
				result: "ready",
			}),
		]);
	});

	it("rejects a tampered staging requirement before starting the manager", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-py-gate-tamper-"),
			"managed",
		);
		const manager = new FakePackageManager();
		const result = await coordinator(manager, {
			prepareStaging: async (path) => {
				await writeFile(join(path, "requirements.txt"), "tampered\n", "utf8");
				return { requirements: "tampered\n" };
			},
		}).install({
			decision: DECISION,
			managedStatePath: managed,
			pythonInterpreter: INTERPRETER,
		});
		expect(result).toEqual({ status: "failed", reason: "recipe_lock_invalid" });
		expect(manager.starts).toBe(0);
		expect(await exists(revisionTarget(managed))).toBe(false);
		expect(await readdir(serverRoot(managed))).toEqual([]);
	});

	it("fails verification without promoting a phantom installation", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-py-gate-verify-"),
			"managed",
		);
		const manager = new FakePackageManager();
		const result = await coordinator(manager, {
			verifier: async () => undefined,
		}).install({
			decision: DECISION,
			managedStatePath: managed,
			pythonInterpreter: INTERPRETER,
		});
		expect(result).toEqual({ status: "failed", reason: "verification_failed" });
		expect(manager.starts).toBe(1);
		expect(await exists(revisionTarget(managed))).toBe(false);
		expect(await exists(lockPath(managed))).toBe(false);
	});

	it("rolls a failed promotion back to the previous revision", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-py-gate-rollback-"),
			"managed",
		);
		await mkdir(revisionTarget(managed), { recursive: true });
		await writeFile(
			join(revisionTarget(managed), "previous-install.txt"),
			"keep\n",
			"utf8",
		);
		const manager = new FakePackageManager();
		const result = await coordinator(manager, {
			verifier: promoteFailingVerifier(),
		}).install({
			decision: DECISION,
			managedStatePath: managed,
			pythonInterpreter: INTERPRETER,
		});
		expect(result.status).toBe("failed");
		expect(
			await readFile(
				join(revisionTarget(managed), "previous-install.txt"),
				"utf8",
			),
		).toBe("keep\n");
		expect(
			await readFile(
				join(revisionTarget(managed), "requirements.txt"),
				"utf8",
			).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("keeps the partial staging and the lock when termination is unconfirmed", async () => {
		const managed = join(
			await temporaryDirectory("pi-lsp-py-gate-cancel-"),
			"managed",
		);
		const manager = new FakePackageManager();
		manager.holdStart = true;
		manager.terminateConfirmed = false;
		const controller = new AbortController();
		const instance = coordinator(manager);
		const pending = instance.install({
			decision: DECISION,
			managedStatePath: managed,
			pythonInterpreter: INTERPRETER,
			signal: controller.signal,
		});
		await manager.started.promise;
		controller.abort();
		expect(await pending).toEqual({ status: "failed", reason: "cancelled" });
		await instance.shutdown();
		expect(manager.starts).toBe(1);
		expect(manager.terminateCalls).toBeGreaterThan(0);
		// Conservative: no late promotion, the partial directory and the lock stay behind.
		expect(await exists(revisionTarget(managed))).toBe(false);
		expect(await exists(stagingPath(managed))).toBe(true);
		expect(await exists(lockPath(managed))).toBe(true);
		expect(await auditRecords(managed)).toEqual([
			expect.objectContaining({
				serverId: "ty",
				result: "cancelled",
				residual: "termination_unconfirmed",
			}),
		]);
	});
});
