import {
	CancellationTokenSource,
	createMessageConnection,
	ResponseError,
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
	onClose?: () => Promise<void> | void;
}

export class LspConnection {
	private readonly connection: MessageConnection;
	private readonly closedSignal: Promise<void>;
	private resolveClosed: () => void = () => undefined;
	private closed = false;
	private tainted = false;

	public constructor(
		input: NodeJS.ReadableStream,
		output: NodeJS.WritableStream,
		private readonly options: ConnectionOptions,
	) {
		this.closedSignal = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
		this.connection = createMessageConnection(
			new StreamMessageReader(input),
			new StreamMessageWriter(output),
		);
		this.connection.onClose(() => {
			this.closed = true;
			this.resolveClosed();
			void this.options.onClose?.();
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
		try {
			await this.connection.sendNotification(method, params);
		} catch {
			throw new Error(
				this.tainted ? "connection_tainted" : "connection_closed",
			);
		}
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
					(failure: unknown) => ({ response: true as const, failure }),
				),
				interruption.then((code) => ({ response: false as const, code })),
				this.closedSignal.then(() => ({
					response: false as const,
					code: "closed" as const,
				})),
			]);
			if (raced.response) {
				if (!("failure" in raced)) return { ok: true, value: raced.value };
				// JSON-RPC method errors are deterministic. Other rejections originate
				// in the transport and are safe for the single read-only retry.
				if (raced.failure instanceof ResponseError)
					return { ok: false, code: "request_failed" };
				return { ok: false, code: "closed" };
			}
			if (this.closed || raced.code === "closed")
				return { ok: false, code: "closed" };
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
		this.resolveClosed();
		this.connection.dispose();
	}
}
