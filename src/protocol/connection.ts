import {
	CancellationTokenSource,
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
} from "vscode-jsonrpc/node";

export type ConnectionFailure =
	| "cancelled"
	| "timed_out"
	| "tainted"
	| "closed"
	| "request_failed";
export type ConnectionResult<T> =
	| { ok: true; value: T }
	| { ok: false; code: ConnectionFailure };

export interface ConnectionOptions {
	requestTimeoutMs: number;
	cancelDrainMs: number;
	onTaint?: () => Promise<void> | void;
}

export class LspConnection {
	private readonly connection: MessageConnection;
	private closed = false;
	private tainted = false;

	public constructor(
		input: NodeJS.ReadableStream,
		output: NodeJS.WritableStream,
		private readonly options: ConnectionOptions,
	) {
		this.connection = createMessageConnection(
			new StreamMessageReader(input),
			new StreamMessageWriter(output),
		);
		this.connection.onClose(() => {
			this.closed = true;
		});
		this.connection.listen();
	}

	public get isTainted(): boolean {
		return this.tainted;
	}

	public onNotification(
		method: string,
		handler: (params: unknown) => void,
	): void {
		this.connection.onNotification(method, handler);
	}

	public onRequest(
		method: string,
		handler: (params: unknown) => unknown,
	): void {
		this.connection.onRequest(method, handler);
	}

	public async notify(method: string, params?: unknown): Promise<void> {
		if (this.closed) throw new Error("connection_closed");
		if (this.tainted) throw new Error("connection_tainted");
		await this.connection.sendNotification(method, params);
	}

	public async request<T>(
		method: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<ConnectionResult<T>> {
		if (this.closed) return { ok: false, code: "closed" };
		if (this.tainted) return { ok: false, code: "tainted" };
		if (signal?.aborted) return { ok: false, code: "cancelled" };
		const source = new CancellationTokenSource();
		const request = this.connection.sendRequest<T>(
			method,
			params,
			source.token,
		);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		const interruption = new Promise<ConnectionFailure>((resolve) => {
			timeout = setTimeout(
				() => resolve("timed_out"),
				this.options.requestTimeoutMs,
			);
			abortListener = () => resolve("cancelled");
			signal?.addEventListener("abort", abortListener, { once: true });
		});
		try {
			const raced = await Promise.race([
				request.then(
					(value) => ({ response: true as const, value }),
					() => ({ response: true as const, failed: true as const }),
				),
				interruption.then((code) => ({ response: false as const, code })),
			]);
			if (raced.response)
				return "failed" in raced
					? { ok: false, code: "request_failed" }
					: { ok: true, value: raced.value };
			if (this.closed) return { ok: false, code: "closed" };
			source.cancel();
			let drainTimer: ReturnType<typeof setTimeout> | undefined;
			const drained = await Promise.race([
				request.then(
					() => true,
					() => true,
				),
				new Promise<boolean>((resolve) => {
					drainTimer = setTimeout(
						() => resolve(false),
						this.options.cancelDrainMs,
					);
				}),
			]);
			if (drainTimer) clearTimeout(drainTimer);
			if (!drained) {
				this.tainted = true;
				await this.options.onTaint?.();
				return { ok: false, code: "tainted" };
			}
			return { ok: false, code: raced.code };
		} finally {
			if (timeout) clearTimeout(timeout);
			if (abortListener) signal?.removeEventListener("abort", abortListener);
			source.dispose();
		}
	}

	public close(): void {
		if (this.closed) return;
		this.closed = true;
		this.connection.dispose();
	}
}
