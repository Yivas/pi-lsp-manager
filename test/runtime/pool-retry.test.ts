import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimePool } from "../../src/runtime/pool.js";
import { SerialQueue } from "../../src/runtime/queue.js";
import { RuntimeReaper } from "../../src/runtime/reaper.js";
import {
	mayRetry,
	retryOnce,
	TransientRuntimeError,
} from "../../src/runtime/retry.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50 && !check(); attempt += 1)
		await new Promise((resolve) => setTimeout(resolve, 1));
	if (!check()) throw new Error("Timed out waiting for test barrier.");
}

const paths: string[] = [];
async function root() {
	const path = await mkdtemp(join(tmpdir(), "pi-lsp-runtime-"));
	paths.push(path);
	return path;
}
afterEach(async () =>
	Promise.all(
		paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	),
);

describe("runtime pool and retries", () => {
	it("rejects queue work cancelled before enqueue or while it waits", async () => {
		const queue = new SerialQueue();
		const blocked = deferred<void>();
		const first = queue.run(async () => blocked.promise);
		const before = new AbortController();
		before.abort();
		await expect(
			queue.run(async () => undefined, before.signal),
		).rejects.toThrow("cancelled");
		const waiting = new AbortController();
		const queued = queue.run(async () => "unreachable", waiting.signal);
		waiting.abort();
		blocked.resolve();
		await first;
		await expect(queued).rejects.toThrow("cancelled");
	});

	it("shares one start, serializes one root, and permits parallel roots", async () => {
		const pool = new RuntimePool();
		const firstRoot = await root();
		const secondRoot = await root();
		let starts = 0;
		let stopped = 0;
		const start = async () => {
			starts += 1;
			return {
				shutdown: async () => {
					stopped += 1;
				},
				terminate: async () => {
					stopped += 1;
				},
			};
		};
		const [first, second] = await Promise.all([
			pool.acquire(firstRoot, "typescript", start),
			pool.acquire(firstRoot, "typescript", start),
		]);
		expect(starts).toBe(1);
		let active = 0;
		let maximum = 0;
		await Promise.all([
			first.entry.queue.run(async () => {
				active += 1;
				maximum = Math.max(maximum, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active -= 1;
			}),
			second.entry.queue.run(async () => {
				active += 1;
				maximum = Math.max(maximum, active);
				active -= 1;
			}),
		]);
		expect(maximum).toBe(1);
		const third = await pool.acquire(secondRoot, "typescript", start);
		expect(starts).toBe(2);
		first.lease.release();
		second.lease.release();
		third.lease.release();
		await pool.shutdown();
		expect(stopped).toBe(2);
	});
	it("reaps idle entries and never retries mutation", async () => {
		let now = 0;
		const pool = new RuntimePool({ now: () => now, idleMs: 5 });
		const workspace = await root();
		let stopped = 0;
		const resource = await pool.acquire(workspace, "typescript", async () => ({
			shutdown: async () => {
				stopped += 1;
			},
			terminate: async () => {
				stopped += 1;
			},
		}));
		resource.lease.release();
		now = 10;
		await pool.reap();
		expect(pool.size()).toBe(0);
		expect(stopped).toBe(1);
		let attempts = 0;
		expect(
			await retryOnce("definition", async () => {
				attempts += 1;
				if (attempts === 1) throw new TransientRuntimeError("crash");
				return "ok";
			}),
		).toBe("ok");
		expect(attempts).toBe(2);
		expect(mayRetry("rename")).toBe(false);
	});

	it("cancels an acquire waiting on a shared start without cancelling it", async () => {
		const workspace = await root();
		const start = deferred<{
			shutdown(): Promise<void>;
			terminate(): Promise<void>;
		}>();
		const pool = new RuntimePool();
		const first = pool.acquire(workspace, "typescript", () => start.promise);
		const aborter = new AbortController();
		const cancelled = pool.acquire(
			workspace,
			"typescript",
			() => start.promise,
			aborter.signal,
		);
		aborter.abort();
		await expect(cancelled).rejects.toThrow("cancelled");
		start.resolve({
			shutdown: async () => undefined,
			terminate: async () => undefined,
		});
		const acquired = await first;
		acquired.lease.release();
		await pool.shutdown();
	});

	it("aborts factories and terminates sessions which resolve after timeout or host shutdown", async () => {
		const workspace = await root();
		const late = deferred<{
			shutdown(): Promise<void>;
			terminate(): Promise<void>;
		}>();
		let timer: (() => void) | undefined;
		let terminated = 0;
		let activated = 0;
		const pool = new RuntimePool({
			onActive: () => {
				activated += 1;
			},
			timers: {
				setTimeout(handler) {
					timer = handler;
					return 1 as never;
				},
				clearTimeout() {},
			},
		});
		let timeoutSignal: AbortSignal | undefined;
		const pending = pool.acquire(workspace, "typescript", (signal) => {
			timeoutSignal = signal;
			return late.promise;
		});
		await waitFor(() => timer !== undefined);
		if (!timer) throw new Error("Expected startup timer.");
		timer();
		await expect(pending).rejects.toThrow("start_timed_out");
		expect(timeoutSignal?.aborted).toBe(true);
		late.resolve({
			shutdown: async () => undefined,
			terminate: async () => {
				terminated += 1;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(terminated).toBe(1);
		expect(activated).toBe(1);

		const later = deferred<{
			shutdown(): Promise<void>;
			terminate(): Promise<void>;
		}>();
		const shutdownPool = new RuntimePool();
		let shutdownSignal: AbortSignal | undefined;
		const shutdownStart = shutdownPool.acquire(
			workspace,
			"javascript",
			(signal) => {
				shutdownSignal = signal;
				return later.promise;
			},
		);
		await waitFor(() => shutdownSignal !== undefined);
		await shutdownPool.shutdown();
		await expect(shutdownStart).rejects.toThrow("start_aborted");
		expect(shutdownSignal?.aborted).toBe(true);
		later.resolve({
			shutdown: async () => undefined,
			terminate: async () => {
				terminated += 1;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(terminated).toBe(2);
	});

	it("keeps shutdown bounded when an aborted factory never resolves", async () => {
		const workspace = await root();
		const pool = new RuntimePool();
		let signal: AbortSignal | undefined;
		void pool
			.acquire(workspace, "typescript", (value) => {
				signal = value;
				return new Promise(() => undefined);
			})
			.catch(() => undefined);
		await waitFor(() => signal !== undefined);
		await Promise.race([
			pool.shutdown(),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("shutdown hung")), 100),
			),
		]);
		expect(signal?.aborted).toBe(true);
	});

	it("uses injected timers for the sixty-second start timeout and five-minute idle reaper", async () => {
		let now = 0;
		let startTimer: (() => void) | undefined;
		const timers = {
			setTimeout(handler: () => void) {
				startTimer = handler;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimeout: () => undefined,
		};
		const workspace = await root();
		const pool = new RuntimePool({ now: () => now, timers });
		const pending = pool.acquire(
			workspace,
			"typescript",
			async () => new Promise(() => undefined),
		);
		await waitFor(() => startTimer !== undefined);
		expect(startTimer).toBeDefined();
		startTimer?.();
		await expect(pending).rejects.toThrow("start_timed_out");

		let stopped = 0;
		const entry = await pool.acquire(workspace, "typescript", async () => ({
			shutdown: async () => {
				stopped += 1;
			},
			terminate: async () => {
				stopped += 1;
			},
		}));
		const intervalHandlers: Array<() => void> = [];
		const reaper = new RuntimeReaper(pool, 60_000, {
			setInterval(handler) {
				intervalHandlers.push(handler);
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: () => undefined,
		});
		reaper.start();
		reaper.start();
		expect(intervalHandlers).toHaveLength(1);
		now = 300_000;
		intervalHandlers[0]?.();
		await Promise.resolve();
		expect(pool.size()).toBe(1);
		entry.lease.release();
		entry.entry.waiters = 1;
		intervalHandlers[0]?.();
		await Promise.resolve();
		expect(pool.size()).toBe(1);
		entry.entry.waiters = 0;
		now = 600_000;
		intervalHandlers[0]?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pool.size()).toBe(0);
		expect(stopped).toBe(1);
		await reaper.stop();
		await reaper.stop();
	});
});
