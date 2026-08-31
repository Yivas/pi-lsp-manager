import { realpath } from "node:fs/promises";
import { LeaseCounter, type Lease } from "./lease.js";
import { SerialQueue } from "./queue.js";

export interface RuntimeSession {
	shutdown(): Promise<void>;
	terminate(): Promise<void>;
}

export interface PoolEntry {
	key: string;
	state: "starting" | "ready" | "stopping";
	queue: SerialQueue;
	leases: LeaseCounter;
	waiters: number;
	lastUsedAt: number;
	session: RuntimeSession;
}

export interface PoolTimers {
	setTimeout(
		handler: () => void,
		milliseconds: number,
	): ReturnType<typeof setTimeout>;
	clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface PoolOptions {
	now?: () => number;
	startTimeoutMs?: number;
	idleMs?: number;
	timers?: PoolTimers;
	onActive?: () => void;
}

export type RuntimeSessionFactory = (
	signal: AbortSignal,
) => Promise<RuntimeSession>;

interface PendingStart {
	readonly controller: AbortController;
	readonly completion: Promise<PoolEntry>;
}

function awaitWithAbort<T>(
	value: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return value;
	if (signal.aborted) return Promise.reject(new Error("cancelled"));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new Error("cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		void value.then(
			(result) => {
				signal.removeEventListener("abort", abort);
				resolve(result);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

function abortError(): Error {
	return new Error("start_aborted");
}

/** A process pool keyed by an unambiguous canonical root/server tuple. */
export class RuntimePool {
	private readonly entries = new Map<string, PoolEntry>();
	private readonly starting = new Map<string, PendingStart>();
	private readonly cleanups = new Set<Promise<void>>();
	private readonly now: () => number;
	private readonly timers: PoolTimers;
	private shuttingDown = false;
	private activated = false;
	private readonly onActive: (() => void) | undefined;
	public readonly startTimeoutMs: number;
	public readonly idleMs: number;

	public constructor(options: PoolOptions = {}) {
		this.now = options.now ?? Date.now;
		this.timers = options.timers ?? { setTimeout, clearTimeout };
		this.onActive = options.onActive;
		this.startTimeoutMs = options.startTimeoutMs ?? 60_000;
		this.idleMs = options.idleMs ?? 300_000;
	}

	public async key(rootPath: string, serverId: string): Promise<string> {
		return JSON.stringify([await realpath(rootPath), serverId]);
	}

	public async acquire(
		rootPath: string,
		serverId: string,
		factory: RuntimeSessionFactory,
		signal?: AbortSignal,
	): Promise<{ entry: PoolEntry; lease: Lease }> {
		if (this.shuttingDown) throw new Error("pool_shutting_down");
		if (signal?.aborted) throw new Error("cancelled");
		if (!this.activated) {
			this.activated = true;
			this.onActive?.();
		}
		const key = await this.key(rootPath, serverId);
		let entry = this.entries.get(key);
		if (!entry || entry.state !== "ready") {
			let pending = this.starting.get(key);
			if (!pending) {
				const controller = new AbortController();
				pending = {
					controller,
					completion: this.start(key, factory, controller),
				};
				this.starting.set(key, pending);
			}
			entry = await awaitWithAbort(pending.completion, signal);
		}
		if (this.shuttingDown) throw new Error("pool_shutting_down");
		if (signal?.aborted) throw new Error("cancelled");
		if (entry.state !== "ready" || this.entries.get(key) !== entry)
			return this.acquire(rootPath, serverId, factory, signal);
		entry.waiters += 1;
		const lease = entry.leases.acquire(() => {
			entry.waiters -= 1;
			entry.lastUsedAt = this.now();
		});
		return { entry, lease };
	}

	private trackCleanup(cleanup: Promise<void>): void {
		this.cleanups.add(cleanup);
		void cleanup.finally(() => this.cleanups.delete(cleanup));
	}

	private async start(
		key: string,
		factory: RuntimeSessionFactory,
		controller: AbortController,
	): Promise<PoolEntry> {
		const created = Promise.resolve().then(() => factory(controller.signal));
		// Factories may be non-cooperative, but an owned session resolving after an
		// aborted start is still terminated rather than being published or orphaned.
		this.trackCleanup(
			created.then(
				async (session) => {
					if (controller.signal.aborted || this.shuttingDown)
						await session.terminate();
				},
				() => undefined,
			),
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const interrupted = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(abortError()), {
				once: true,
			});
		});
		const timeout = new Promise<never>((_, reject) => {
			timer = this.timers.setTimeout(() => {
				reject(new Error("start_timed_out"));
				controller.abort();
			}, this.startTimeoutMs);
		});
		try {
			const session = await Promise.race([created, timeout, interrupted]);
			if (controller.signal.aborted || this.shuttingDown)
				throw this.shuttingDown
					? new Error("pool_shutting_down")
					: abortError();
			const entry: PoolEntry = {
				key,
				state: "ready",
				queue: new SerialQueue(),
				leases: new LeaseCounter(),
				waiters: 0,
				lastUsedAt: this.now(),
				session,
			};
			this.entries.set(key, entry);
			return entry;
		} finally {
			if (timer) this.timers.clearTimeout(timer);
			this.starting.delete(key);
		}
	}

	/** Callbacks passed to an owned child; eviction unpublishes before termination. */
	public lifecycleCallbacks(key: string): {
		onTaint: () => Promise<void>;
		onExit: () => Promise<void>;
	} {
		return {
			onTaint: () => this.evict(key, true),
			onExit: () => this.evict(key, true),
		};
	}

	/** Removes an entry synchronously before performing any child-process I/O. */
	public async evict(key: string, tainted = false): Promise<void> {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		entry.state = "stopping";
		if (tainted) await entry.session.terminate();
		else await entry.session.shutdown();
	}

	public async reap(): Promise<void> {
		const now = this.now();
		await Promise.all(
			[...this.entries.values()]
				.filter(
					(entry) =>
						entry.leases.active === 0 &&
						entry.waiters === 0 &&
						now - entry.lastUsedAt >= this.idleMs,
				)
				.map((entry) => this.evict(entry.key)),
		);
	}

	public async shutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		const starts = [...this.starting.values()];
		for (const start of starts) start.controller.abort();
		await Promise.allSettled([
			...[...this.entries.keys()].map((key) => this.evict(key)),
			...starts.map((start) => start.completion),
		]);
		// Never wait for a non-cooperative factory forever. Late resolutions are
		// tracked above and terminate their owned session before release.
	}

	public size(): number {
		return this.entries.size;
	}
}
