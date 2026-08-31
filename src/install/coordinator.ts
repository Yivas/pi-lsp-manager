import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import type { InstallPolicyDecision } from "./policy.js";
import { appendAuditRecord, type AuditRecord } from "./audit.js";
import { acquireLock, type LockFileSystem, type LockIdentity } from "./lock.js";
import {
	createPackageManagerLaunch,
	prepareControlledNpmFiles,
	readControlledNpmFiles,
	validateControlledNpmFiles,
	type ControlledNpmFiles,
	type PackageManagerLaunch,
} from "./launch.js";
import { resolveExecutable } from "./executable.js";
import { sanitizeText } from "./sanitize.js";
import {
	verifyInstallation,
	type InstallationVerifier,
	type InstalledExecutable,
} from "./verify.js";

export type InstallPhase =
	| "missing"
	| "blocked"
	| "waiting-lock"
	| "installing"
	| "verifying"
	| "ready"
	| "failed";

export interface ManagedFileSystem {
	mkdir(
		path: string,
		options: { recursive: true; mode?: number },
	): Promise<unknown>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

const NODE_FILE_SYSTEM: ManagedFileSystem = { mkdir, rename, rm };

export interface RunningPackageManager {
	completed: Promise<{ exitCode: number; stdout: string; stderr: string }>;
	terminate(): Promise<void>;
}

export interface PackageManager {
	start(
		launch: PackageManagerLaunch,
		signal: AbortSignal,
	): Promise<RunningPackageManager>;
}

export interface CoordinatorDependencies {
	fileSystem?: ManagedFileSystem;
	lockFileSystem?: LockFileSystem;
	packageManager: PackageManager;
	verifier: InstallationVerifier;
	ownerIsAlive?: (owner: LockIdentity) => Promise<boolean>;
	now?: () => number;
	random?: () => string;
	sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	audit?: (path: string, record: AuditRecord) => Promise<void>;
	environment?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	npmCommand?: string;
	installTimeoutMs?: number;
	prepareStaging?: (
		path: string,
		decision: Extract<InstallPolicyDecision, { allowed: true }>["recipe"],
	) => Promise<ControlledNpmFiles>;
	resolvePackageManagerCommand?: (
		command: string,
		environment: NodeJS.ProcessEnv,
		platform: NodeJS.Platform,
	) => Promise<string | undefined>;
}

export interface InstallRequest {
	decision: InstallPolicyDecision;
	managedStatePath: string;
	signal?: AbortSignal;
	/** Only the request that starts a singleflight receives the complete phase sequence. */
	onPhase?: (phase: InstallPhase) => void;
}

export interface InstallResult {
	status: "blocked" | "ready" | "failed";
	reason?: string;
	executable?: InstalledExecutable;
	output?: { stdout: string; stderr: string };
}

interface ActiveInstallation {
	controller: AbortController;
	waiters: number;
	promise: Promise<InstallResult>;
}

class AbortError extends Error {}

function processIsAlive(owner: LockIdentity): Promise<boolean> {
	try {
		process.kill(owner.pid, 0);
		return Promise.resolve(true);
	} catch {
		return Promise.resolve(false);
	}
}

function sleepWithAbort(
	milliseconds: number,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new AbortError());
		const timer = setTimeout(resolve, milliseconds);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new AbortError());
			},
			{ once: true },
		);
	});
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new AbortError());
	return new Promise((resolve, reject) => {
		const abort = () => reject(new AbortError());
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

function raceTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	if (milliseconds <= 0) return Promise.reject(new AbortError());
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new AbortError()), milliseconds);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** Managed state is owned extension storage, not an operating-system sandbox; boundaries are rechecked before use. */
async function ensureSafeDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	if ((await lstat(path)).isSymbolicLink())
		throw new Error("Managed path is symbolic.");
}

async function ensureSafeFilePath(path: string): Promise<void> {
	try {
		if ((await lstat(path)).isSymbolicLink())
			throw new Error("Managed file is symbolic.");
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

export class InstallCoordinator {
	private readonly active = new Map<string, ActiveInstallation>();
	private readonly dependencies: Required<
		Omit<CoordinatorDependencies, "lockFileSystem">
	> &
		Pick<CoordinatorDependencies, "lockFileSystem">;

	public constructor(dependencies: CoordinatorDependencies) {
		this.dependencies = {
			...dependencies,
			fileSystem: dependencies.fileSystem ?? NODE_FILE_SYSTEM,
			ownerIsAlive: dependencies.ownerIsAlive ?? processIsAlive,
			now: dependencies.now ?? Date.now,
			random: dependencies.random ?? (() => crypto.randomUUID()),
			sleep: dependencies.sleep ?? sleepWithAbort,
			audit: dependencies.audit ?? appendAuditRecord,
			environment: dependencies.environment ?? process.env,
			platform: dependencies.platform ?? process.platform,
			npmCommand: dependencies.npmCommand ?? "npm",
			installTimeoutMs: dependencies.installTimeoutMs ?? 120_000,
			prepareStaging: dependencies.prepareStaging ?? prepareControlledNpmFiles,
			resolvePackageManagerCommand:
				dependencies.resolvePackageManagerCommand ?? resolveExecutable,
		};
	}

	public install(request: InstallRequest): Promise<InstallResult> {
		if (!request.decision.allowed) {
			request.onPhase?.("blocked");
			return Promise.resolve({
				status: "blocked",
				reason: request.decision.reason,
			});
		}
		if (request.signal?.aborted) {
			request.onPhase?.("failed");
			return Promise.resolve({ status: "failed", reason: "cancelled" });
		}
		const recipe = request.decision.recipe;
		const managedKey = normalize(resolve(request.managedStatePath));
		const key = `${managedKey}:${recipe.serverId}:${recipe.revision}`;
		let active = this.active.get(key);
		if (!active) {
			const controller = new AbortController();
			active = {
				controller,
				waiters: 0,
				promise: this.execute(request, controller).finally(() =>
					this.active.delete(key),
				),
			};
			this.active.set(key, active);
		}
		return this.join(active, request.signal);
	}

	public async shutdown(): Promise<void> {
		for (const installation of this.active.values())
			installation.controller.abort();
		await Promise.allSettled(
			[...this.active.values()].map((item) => item.promise),
		);
	}

	private async join(
		active: ActiveInstallation,
		signal?: AbortSignal,
	): Promise<InstallResult> {
		active.waiters += 1;
		const leave = () => {
			active.waiters -= 1;
			if (active.waiters === 0) active.controller.abort();
		};
		if (!signal) {
			try {
				return await active.promise;
			} finally {
				leave();
			}
		}
		if (signal.aborted) {
			leave();
			return { status: "failed", reason: "cancelled" };
		}
		return new Promise((resolve) => {
			let done = false;
			const finish = (result: InstallResult) => {
				if (done) return;
				done = true;
				signal.removeEventListener("abort", abort);
				leave();
				resolve(result);
			};
			const abort = () => finish({ status: "failed", reason: "cancelled" });
			signal.addEventListener("abort", abort, { once: true });
			active.promise.then(finish, () =>
				finish({ status: "failed", reason: "internal_error" }),
			);
		});
	}

	private async execute(
		request: InstallRequest,
		controller: AbortController,
	): Promise<InstallResult> {
		if (!request.decision.allowed) return { status: "blocked" };
		const recipe = request.decision.recipe;
		const startedAt = this.dependencies.now();
		const deadlineAt = startedAt + this.dependencies.installTimeoutMs;
		const signal = controller.signal;
		let abortReason: "cancelled" | "timed_out" = "cancelled";
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			abortReason = "timed_out";
			controller.abort();
		}, this.dependencies.installTimeoutMs);
		const managed = request.managedStatePath;
		const serverRoot = join(managed, "servers", recipe.serverId);
		const target = join(serverRoot, recipe.revision);
		const nonce = this.dependencies.random();
		const staging = join(serverRoot, `${recipe.revision}.partial-${nonce}`);
		const quarantine = join(serverRoot, `${recipe.revision}.invalid-${nonce}`);
		const lockPath = join(
			managed,
			"locks",
			`${recipe.serverId}-${recipe.revision}.lock`,
		);
		const auditPath = join(managed, "audit", "install.audit.jsonl");
		let release: (() => Promise<void>) | undefined;
		let processHandle: RunningPackageManager | undefined;
		let startPromise: Promise<RunningPackageManager> | undefined;
		let lateTermination: Promise<void> | undefined;
		let final: InstallResult = { status: "failed", reason: "internal_error" };
		let committing = false;
		let emittedTerminalFailure = false;
		const phase = (value: InstallPhase) => request.onPhase?.(value);
		const finish = (result: InstallResult): InstallResult => {
			final = result;
			if (result.status === "failed" && !emittedTerminalFailure) {
				emittedTerminalFailure = true;
				phase("failed");
			}
			return result;
		};
		try {
			await ensureSafeDirectory(managed);
			await ensureSafeDirectory(join(managed, "servers"));
			await ensureSafeDirectory(serverRoot);
			await ensureSafeDirectory(join(managed, "locks"));
			await ensureSafeDirectory(join(managed, "audit"));
			await ensureSafeFilePath(lockPath);
			if (signal.aborted) throw new AbortError();
			const identity: LockIdentity = {
				pid: process.pid,
				startedAt,
				nonce,
				serverId: recipe.serverId,
				revision: recipe.revision,
			};
			while (!signal.aborted) {
				phase("waiting-lock");
				const lock = await raceAbort(
					acquireLock(
						lockPath,
						identity,
						this.dependencies.ownerIsAlive,
						this.dependencies.lockFileSystem,
					),
					signal,
				);
				if (lock.acquired) {
					release = lock.release;
					break;
				}
				if (lock.state === "manual-repair")
					return finish({ status: "failed", reason: "manual_lock_repair" });
				await raceAbort(this.dependencies.sleep(20, signal), signal);
			}
			if (!release) throw new AbortError();
			phase("verifying");
			const existing = await raceAbort(
				verifyInstallation(target, recipe, signal, this.dependencies.verifier),
				signal,
			);
			if (existing) {
				phase("ready");
				return finish({ status: "ready", executable: existing });
			}
			phase("missing");
			if (signal.aborted) throw new AbortError();
			await this.dependencies.fileSystem.mkdir(staging, {
				recursive: true,
				mode: 0o700,
			});
			await ensureSafeDirectory(staging);
			const prepared = await raceAbort(
				this.dependencies.prepareStaging(staging, recipe),
				signal,
			);
			const onDisk = await raceAbort(readControlledNpmFiles(staging), signal);
			if (
				!validateControlledNpmFiles(recipe, prepared) ||
				!validateControlledNpmFiles(recipe, onDisk)
			) {
				return finish({ status: "failed", reason: "recipe_lock_invalid" });
			}
			const npmPath = await raceAbort(
				this.dependencies.resolvePackageManagerCommand(
					this.dependencies.npmCommand,
					this.dependencies.environment,
					this.dependencies.platform,
				),
				signal,
			);
			if (!npmPath)
				return finish({ status: "failed", reason: "package_manager_missing" });
			phase("installing");
			startPromise = this.dependencies.packageManager.start(
				createPackageManagerLaunch(
					recipe,
					staging,
					npmPath,
					this.dependencies.environment,
					this.dependencies.platform,
				),
				signal,
			);
			startPromise
				.then(async (handle) => {
					if (signal.aborted) lateTermination = handle.terminate();
				})
				.catch(() => undefined);
			processHandle = await raceAbort(startPromise, signal);
			const stop = () => {
				lateTermination ??= processHandle?.terminate();
			};
			signal.addEventListener("abort", stop, { once: true });
			const outcome = await raceAbort(processHandle.completed, signal);
			signal.removeEventListener("abort", stop);
			if (outcome.exitCode !== 0) {
				return finish({
					status: "failed",
					reason: "package_manager_failed",
					output: {
						stdout: sanitizeText(outcome.stdout),
						stderr: sanitizeText(outcome.stderr),
					},
				});
			}
			phase("verifying");
			const staged = await raceAbort(
				verifyInstallation(staging, recipe, signal, this.dependencies.verifier),
				signal,
			);
			if (!staged)
				return finish({ status: "failed", reason: "verification_failed" });
			if (signal.aborted) throw new AbortError();
			committing = true;
			let quarantined = false;
			try {
				if (signal.aborted) throw new AbortError();
				if (await pathExists(target)) {
					await this.dependencies.fileSystem.rename(target, quarantine);
					quarantined = true;
				}
				if (signal.aborted) throw new AbortError();
				await this.dependencies.fileSystem.rename(staging, target);
				if (signal.aborted) throw new AbortError();
				const promoted = await raceTimeout(
					verifyInstallation(
						target,
						recipe,
						new AbortController().signal,
						this.dependencies.verifier,
					),
					deadlineAt - this.dependencies.now(),
				);
				if (!promoted)
					throw new Error("Promoted installation verification failed.");
				let cleanupWarning: string | undefined;
				if (quarantined) {
					try {
						await this.dependencies.fileSystem.rm(quarantine, {
							recursive: true,
							force: true,
						});
					} catch {
						cleanupWarning = "quarantine_cleanup_failed";
					}
				}
				phase("ready");
				return finish({
					status: "ready",
					executable: promoted,
					...(cleanupWarning ? { reason: cleanupWarning } : {}),
				});
			} catch (error) {
				const promotionTimedOut =
					timedOut || this.dependencies.now() >= deadlineAt;
				if (await pathExists(target))
					await this.dependencies.fileSystem
						.rename(target, staging)
						.catch(() => undefined);
				if (quarantined)
					await this.dependencies.fileSystem
						.rename(quarantine, target)
						.catch(() => undefined);
				const restored = !quarantined || (await pathExists(target));
				return finish({
					status: "failed",
					reason: !restored
						? "rollback_incomplete"
						: promotionTimedOut
							? "timed_out"
							: signal.aborted
								? abortReason
								: sanitizeText(
										error instanceof Error ? error.message : "promotion_failed",
									),
				});
			} finally {
				committing = false;
			}
		} catch (error: unknown) {
			if (error instanceof AbortError || signal.aborted) {
				return finish({ status: "failed", reason: abortReason });
			}
			return finish({
				status: "failed",
				reason: sanitizeText(
					error instanceof Error ? error.message : "internal_error",
				),
			});
		} finally {
			if (signal.aborted && processHandle && !committing)
				lateTermination ??= processHandle.terminate();
			if (signal.aborted && startPromise) {
				await raceTimeout(
					startPromise
						.then(async (handle) => {
							if (!lateTermination) lateTermination = handle.terminate();
							await lateTermination;
						})
						.catch(() => undefined),
					1_000,
				).catch(() => undefined);
			}
			await raceTimeout(lateTermination ?? Promise.resolve(), 1_000).catch(
				() => undefined,
			);
			clearTimeout(timeout);
			if (final.status !== "ready")
				await this.dependencies.fileSystem
					.rm(staging, { recursive: true, force: true })
					.catch(() => undefined);
			await release?.().catch(() => undefined);
			if (release) {
				await raceTimeout(
					this.dependencies.audit(auditPath, {
						at: new Date(this.dependencies.now()).toISOString(),
						serverId: recipe.serverId,
						revision: recipe.revision,
						phase: final.status,
						durationMs: this.dependencies.now() - startedAt,
						result:
							final.status === "ready"
								? "ready"
								: final.reason === "timed_out"
									? "timed_out"
									: final.reason === "cancelled"
										? "cancelled"
										: "failed",
					}),
					1_000,
				).catch(() => undefined);
			}
		}
	}
}
