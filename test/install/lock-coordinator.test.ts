import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { prepareControlledNpmFiles } from "../../src/install/launch.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import {
	InstallCoordinator,
	type CoordinatorDependencies,
	type PackageManager,
	type RunningPackageManager,
} from "../../src/install/coordinator.js";
import { acquireLock, type LockFileSystem } from "../../src/install/lock.js";
import { evaluateInstallPolicy } from "../../src/install/policy.js";

const temporaryDirectories: string[] = [];
async function temporaryDirectory() {
	const path = await mkdtemp(join(tmpdir(), "pi-lsp-manager-install-"));
	temporaryDirectories.push(path);
	return path;
}
afterEach(async () => {
	for (const path of temporaryDirectories.splice(0))
		await import("node:fs/promises").then(({ rm }) =>
			rm(path, { recursive: true, force: true }),
		);
});

function allowedDecision() {
	const decision = evaluateInstallPolicy({
		origin: "tool",
		serverId: "typescript",
		globalConfig: createDefaultConfig(),
		projectTrusted: true,
		platform: "linux",
	});
	if (!decision.allowed) throw new Error("expected allowed recipe");
	return decision;
}

class FakePackageManager implements PackageManager {
	public starts = 0;
	public terminateCalls = 0;
	public hold = false;
	public outcome = { exitCode: 0, stdout: "ok", stderr: "" };
	public readonly launches: unknown[] = [];
	private release?: () => void;
	public async start(launch: unknown): Promise<RunningPackageManager> {
		this.starts += 1;
		this.launches.push(launch);
		let resolve!: (outcome: {
			exitCode: number;
			stdout: string;
			stderr: string;
		}) => void;
		const completed = new Promise<{
			exitCode: number;
			stdout: string;
			stderr: string;
		}>((done) => {
			resolve = done;
		});
		this.release = () => resolve(this.outcome);
		if (!this.hold) this.release();
		return {
			completed,
			terminate: async () => {
				this.terminateCalls += 1;
				resolve({ exitCode: 143, stdout: "", stderr: "terminated" });
			},
		};
	}
	public finish() {
		this.release?.();
	}
}

function coordinator(
	manager: FakePackageManager,
	overrides: Partial<Omit<CoordinatorDependencies, "packageManager">> = {},
) {
	return new InstallCoordinator({
		packageManager: manager,
		verifier:
			overrides.verifier ??
			(async (path, recipe) => {
				const lockPath = join(path, "package-lock.json");
				const exists = await readFile(lockPath, "utf8")
					.then(() => true)
					.catch(() => false);
				return exists
					? {
							path: join(path, "node_modules", ".bin", recipe.executable),
							version: recipe.expectedVersion,
						}
					: undefined;
			}),
		resolvePackageManagerCommand:
			overrides.resolvePackageManagerCommand ?? (async () => "/safe/npm"),
		random: overrides.random ?? (() => "nonce"),
		...overrides,
	});
}

const wait = (milliseconds = 15) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await wait(10);
	if (!check()) throw new Error("Timed out waiting for test condition.");
}

describe("conservative locks", () => {
	it("never reclaims a dead lock and cleans a failed initialization", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "install.lock");
		const owner = {
			pid: 42,
			startedAt: 1,
			nonce: "owner",
			serverId: "typescript",
			revision: "r",
		};
		await writeFile(path, JSON.stringify(owner));
		expect(
			await acquireLock(path, { ...owner, nonce: "next" }, async () => false),
		).toMatchObject({ acquired: false, state: "manual-repair" });
		const broken: LockFileSystem = {
			open: async () => ({
				writeFile: async () => {
					throw new Error("write failed");
				},
				close: async () => undefined,
			}),
			readFile,
			rename: async () => undefined,
			link: async () => undefined,
			rm: async (target) => {
				await import("node:fs/promises").then(({ rm }) =>
					rm(target, { force: true }),
				);
			},
		};
		const brokenPath = join(directory, "broken.lock");
		await expect(
			acquireLock(brokenPath, owner, async () => false, broken),
		).rejects.toThrow("write failed");
		await expect(
			import("node:fs/promises").then(({ access }) => access(brokenPath)),
		).rejects.toThrow();
	});

	it("restores a foreign replacement injected between the ownership read and rename", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "owned.lock");
		const owner = {
			pid: 42,
			startedAt: 1,
			nonce: "owner",
			serverId: "typescript",
			revision: "r",
		};
		const replacement = { ...owner, nonce: "foreign" };
		let injected = false;
		const node = await import("node:fs/promises");
		const fileSystem: LockFileSystem = {
			open: node.open,
			readFile: node.readFile,
			rename: async (from, to) => {
				if (!injected && from === path) {
					injected = true;
					await node.writeFile(path, JSON.stringify(replacement));
				}
				await node.rename(from, to);
			},
			link: node.link,
			rm: node.rm,
		};
		const lock = await acquireLock(path, owner, async () => true, fileSystem);
		if (!lock.acquired) throw new Error("expected lock");
		await lock.release();
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
	});
});

describe("installation coordinator", () => {
	it("uses one controlled installation for one hundred callers", async () => {
		const root = await temporaryDirectory();
		const manager = new FakePackageManager();
		const instance = coordinator(manager);
		const results = await Promise.all(
			Array.from({ length: 100 }, () =>
				instance.install({
					decision: allowedDecision(),
					managedStatePath: root,
				}),
			),
		);
		expect(manager.starts).toBe(1);
		expect(results.every((result) => result.status === "ready")).toBe(true);
	});

	it("does not share singleflight work between separate managed roots", async () => {
		const firstRoot = await temporaryDirectory();
		const secondRoot = await temporaryDirectory();
		const manager = new FakePackageManager();
		const instance = coordinator(manager);
		const [first, second] = await Promise.all([
			instance.install({
				decision: allowedDecision(),
				managedStatePath: firstRoot,
			}),
			instance.install({
				decision: allowedDecision(),
				managedStatePath: secondRoot,
			}),
		]);
		expect(first.status).toBe("ready");
		expect(second.status).toBe("ready");
		expect(manager.starts).toBe(2);
	});

	it("overlaps independent coordinators: the second waits, then reuses the first promotion", async () => {
		const root = await temporaryDirectory();
		const firstManager = new FakePackageManager();
		firstManager.hold = true;
		const secondManager = new FakePackageManager();
		const first = coordinator(firstManager);
		const second = coordinator(secondManager);
		const firstPending = first.install({
			decision: allowedDecision(),
			managedStatePath: root,
		});
		await waitFor(() => firstManager.starts === 1);
		const secondPending = second.install({
			decision: allowedDecision(),
			managedStatePath: root,
		});
		await wait();
		expect(secondManager.starts).toBe(0);
		firstManager.finish();
		expect((await firstPending).status).toBe("ready");
		expect((await secondPending).status).toBe("ready");
		expect(secondManager.starts).toBe(0);
	});

	it("rejects a tampered generated lock before spawning and preserves an invalid target through failed postverification", async () => {
		const root = await temporaryDirectory();
		const manager = new FakePackageManager();
		const tampered = coordinator(manager, {
			prepareStaging: async (path, recipe) => {
				const files = await prepareControlledNpmFiles(path, recipe);
				return { ...files, packageLock: "tampered" };
			},
		});
		const blocked = await tampered.install({
			decision: allowedDecision(),
			managedStatePath: root,
		});
		expect(blocked).toMatchObject({
			status: "failed",
			reason: "recipe_lock_invalid",
		});
		expect(manager.starts).toBe(0);
		const recipe = allowedDecision().recipe;
		const target = join(root, "servers", recipe.serverId, recipe.revision);
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "keep"), "old");
		const failing = coordinator(manager, {
			verifier: async (path, activeRecipe) =>
				path.includes(".partial-")
					? {
							path: join(path, "node_modules", ".bin", activeRecipe.executable),
							version: activeRecipe.expectedVersion,
						}
					: undefined,
		});
		expect(
			(
				await failing.install({
					decision: allowedDecision(),
					managedStatePath: root,
				})
			).status,
		).toBe("failed");
		expect(await readFile(join(target, "keep"), "utf8")).toBe("old");
	});

	it("reports package-manager failures with bounded sanitized output", async () => {
		const root = await temporaryDirectory();
		const manager = new FakePackageManager();
		manager.outcome = {
			exitCode: 1,
			stdout: "token=secret",
			stderr: "Authorization: Bearer hidden",
		};
		const phases: string[] = [];
		const result = await coordinator(manager).install({
			decision: allowedDecision(),
			managedStatePath: root,
			onPhase: (phase) => phases.push(phase),
		});
		expect(result).toMatchObject({
			status: "failed",
			reason: "package_manager_failed",
		});
		expect(result.output).not.toMatchObject({
			stdout: expect.stringContaining("secret"),
		});
		expect(result.output).not.toMatchObject({
			stderr: expect.stringContaining("hidden"),
		});
		expect(phases.at(-1)).toBe("failed");
	});

	it("reports missing through ready and returns the promoted target path", async () => {
		const root = await temporaryDirectory();
		const phases: string[] = [];
		const result = await coordinator(new FakePackageManager()).install({
			decision: allowedDecision(),
			managedStatePath: root,
			onPhase: (phase) => phases.push(phase),
		});
		expect(phases).toEqual([
			"waiting-lock",
			"verifying",
			"missing",
			"installing",
			"verifying",
			"ready",
		]);
		expect(result.executable?.path).toContain(
			allowedDecision().recipe.revision,
		);
		expect(result.executable?.path).not.toContain(".partial-");
	});

	it("cancels a waiter without cancelling another and distinguishes a total timeout", async () => {
		const root = await temporaryDirectory();
		const manager = new FakePackageManager();
		manager.hold = true;
		const instance = coordinator(manager, { installTimeoutMs: 10_000 });
		const first = instance.install({
			decision: allowedDecision(),
			managedStatePath: root,
		});
		const aborter = new AbortController();
		const cancelled = instance.install({
			decision: allowedDecision(),
			managedStatePath: root,
			signal: aborter.signal,
		});
		aborter.abort();
		expect(await cancelled).toMatchObject({ reason: "cancelled" });
		await waitFor(() => manager.starts === 1);
		manager.finish();
		expect((await first).status).toBe("ready");
		const foreignRoot = await temporaryDirectory();
		const recipe = allowedDecision().recipe;
		await mkdir(join(foreignRoot, "locks"), { recursive: true });
		await writeFile(
			join(foreignRoot, "locks", `${recipe.serverId}-${recipe.revision}.lock`),
			JSON.stringify({
				pid: 999,
				startedAt: 1,
				nonce: "foreign",
				serverId: recipe.serverId,
				revision: recipe.revision,
			}),
		);
		const timed = coordinator(new FakePackageManager(), {
			ownerIsAlive: async () => true,
			// Leave enough wall-clock room to finish safety checks under a loaded
			// parallel suite before asserting the lock-wait timeout sequence.
			installTimeoutMs: 200,
		});
		const timeoutPhases: string[] = [];
		expect(
			await timed.install({
				decision: allowedDecision(),
				managedStatePath: foreignRoot,
				onPhase: (phase) => timeoutPhases.push(phase),
			}),
		).toMatchObject({ reason: "timed_out" });
		expect(timeoutPhases.at(0)).toBe("waiting-lock");
		expect(timeoutPhases.at(-1)).toBe("failed");
		expect(
			timeoutPhases.slice(0, -1).every((phase) => phase === "waiting-lock"),
		).toBe(true);
	});

	it("does not hang shutdown when a package manager never resolves", async () => {
		const root = await temporaryDirectory();
		const manager: PackageManager = {
			start: async () => ({
				completed: new Promise(() => undefined),
				terminate: async () => undefined,
			}),
		};
		const instance = new InstallCoordinator({
			packageManager: manager,
			verifier: async (path, recipe) => {
				const exists = await readFile(join(path, "package-lock.json"), "utf8")
					.then(() => true)
					.catch(() => false);
				return exists
					? {
							path: join(path, "node_modules", ".bin", recipe.executable),
							version: recipe.expectedVersion,
						}
					: undefined;
			},
			resolvePackageManagerCommand: async () => "/safe/npm",
		});
		const pending = instance.install({
			decision: allowedDecision(),
			managedStatePath: root,
		});
		await wait();
		await instance.shutdown();
		expect(await pending).toMatchObject({ reason: "cancelled" });
	});
});
