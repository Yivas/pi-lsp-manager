import type { RuntimePool } from "./pool.js";

export interface ReaperTimers {
	setInterval(
		handler: () => void,
		milliseconds: number,
	): ReturnType<typeof setInterval>;
	clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export class RuntimeReaper {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly timers: ReaperTimers;
	public constructor(
		private readonly pool: RuntimePool,
		private readonly intervalMs = 60_000,
		timers?: ReaperTimers,
	) {
		this.timers = timers ?? { setInterval, clearInterval };
	}
	public start(): void {
		if (!this.timer)
			this.timer = this.timers.setInterval(() => {
				void this.pool.reap();
			}, this.intervalMs);
	}
	public async stop(): Promise<void> {
		if (this.timer) this.timers.clearInterval(this.timer);
		this.timer = undefined;
		await this.pool.reap();
	}
}
