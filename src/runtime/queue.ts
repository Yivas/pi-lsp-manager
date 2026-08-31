export class SerialQueue {
	private tail = Promise.resolve();

	public run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) return Promise.reject(new Error("cancelled"));
		const next = this.tail.then(async () => {
			if (signal?.aborted) throw new Error("cancelled");
			return work();
		});
		this.tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}
