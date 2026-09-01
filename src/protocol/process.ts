import { spawn, type ChildProcess } from "node:child_process";
import type { EffectiveServerConfig } from "../contracts.js";
import type { ServerLaunch } from "../install/launch.js";
import { BoundedSanitizedOutput } from "../install/sanitize.js";
import type { RuntimeSession } from "../runtime/pool.js";
import { LspConnection } from "./connection.js";
import { DiagnosticCollector } from "./diagnostics.js";
import { LspSession } from "./session.js";

export type SpawnLspProcess = typeof spawn;

export interface NodeLspSessionOptions {
	launch: ServerLaunch;
	rootPath: string;
	server: EffectiveServerConfig;
	environment?: NodeJS.ProcessEnv;
	requestTimeoutMs?: number;
	cancelDrainMs?: number;
	spawnProcess?: SpawnLspProcess;
	signal?: AbortSignal;
	onTaint?: () => Promise<void> | void;
	onExit?: () => Promise<void> | void;
}

function buildServerEnvironment(
	environment: NodeJS.ProcessEnv,
	server: EffectiveServerConfig,
): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "SystemRoot", "ComSpec", "HOME", "TEMP", "TMP"]) {
		const value = environment[key];
		if (value) result[key] = value;
	}
	if (!result.PATH && environment.Path) result.PATH = environment.Path;
	return { ...result, ...(server.route?.env ?? server.env) };
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		child.once("close", finish);
		child.once("error", finish);
	});
}

async function terminateChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const firstClose = waitForClose(child, 2_000);
	if (process.platform === "win32" && child.pid) {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
			shell: false,
			windowsHide: true,
		});
		await waitForClose(killer, 5_000);
	} else {
		try {
			if (child.pid) process.kill(-child.pid, "SIGTERM");
		} catch {
			// The child may not own a process group on every host.
		}
		child.kill("SIGTERM");
	}
	await firstClose;
	if (child.exitCode === null && child.signalCode === null) {
		const secondClose = waitForClose(child, 2_000);
		try {
			if (child.pid) process.kill(-child.pid, "SIGKILL");
		} catch {
			// The child may not own a process group on every host.
		}
		child.kill("SIGKILL");
		await secondClose;
	}
}

/** Owns exactly one LSP child and never sends a command through a shell. */
export class NodeLspRuntimeSession implements RuntimeSession {
	public readonly connection: LspConnection;
	public readonly diagnostics: DiagnosticCollector;
	public readonly session: LspSession;
	private closed = false;
	private readonly stderr = new BoundedSanitizedOutput();

	private constructor(
		private readonly child: ChildProcess,
		options: NodeLspSessionOptions,
	) {
		if (!child.stdin || !child.stdout) {
			throw new Error("LSP process does not expose stdio.");
		}
		this.connection = new LspConnection(child.stdout, child.stdin, {
			requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
			cancelDrainMs: options.cancelDrainMs ?? 1_000,
			...(options.onExit ? { onClose: options.onExit } : {}),
			onTaint: async () => {
				// The pool removes this entry synchronously before child termination,
				// so another acquire cannot observe a tainted/stopping session.
				await options.onTaint?.();
				await this.terminate();
			},
		});
		// Subscribe before any document can open so fast publishDiagnostics
		// notifications cannot race the tool that later requests collection.
		const diagnosticTiming = options.server.diagnostics ?? {
			pushGraceMs: 5_000,
			pullGraceMs: 250,
			settleMs: 50,
		};
		this.diagnostics = new DiagnosticCollector(this.connection, {
			pushDiagnosticsGraceMs: diagnosticTiming.pushGraceMs,
			pullDiagnosticsGraceMs: diagnosticTiming.pullGraceMs,
			diagnosticsSettleMs: diagnosticTiming.settleMs,
			maxDiagnosticsPerUri: 100,
		});
		this.session = new LspSession(this.connection, {
			rootPath: options.rootPath,
			server: options.server,
			processId: process.pid,
		});
		child.stderr?.on("data", (chunk: Buffer | string) =>
			this.stderr.append(String(chunk)),
		);
		let exitObserved = false;
		const exited = () => {
			if (exitObserved) return;
			exitObserved = true;
			// Pool eviction begins synchronously, before connection/process cleanup.
			void options.onExit?.();
			this.connection.close();
		};
		child.once("error", exited);
		child.once("close", exited);
	}

	public static async start(
		options: NodeLspSessionOptions,
	): Promise<NodeLspRuntimeSession> {
		if (options.signal?.aborted) throw new Error("start_aborted");
		const spawnProcess = options.spawnProcess ?? spawn;
		const child = spawnProcess(
			options.launch.command,
			[...options.launch.args],
			{
				cwd: options.rootPath,
				env: buildServerEnvironment(
					options.environment ?? process.env,
					options.server,
				),
				shell: false,
				windowsHide: true,
				windowsVerbatimArguments: options.launch.windowsVerbatimArguments,
				detached: process.platform !== "win32",
			},
		);
		let runtime: NodeLspRuntimeSession | undefined;
		let abort: (() => void) | undefined;
		try {
			runtime = new NodeLspRuntimeSession(child, options);
			const interrupted = new Promise<never>((_, reject) => {
				abort = () => reject(new Error("start_aborted"));
				options.signal?.addEventListener("abort", abort, { once: true });
			});
			if (!(await Promise.race([runtime.session.initialize(), interrupted])))
				throw new Error("LSP initialization failed.");
			if (options.signal?.aborted) throw new Error("start_aborted");
			return runtime;
		} catch (error) {
			if (runtime) await runtime.terminate();
			else await terminateChild(child);
			throw error;
		} finally {
			if (abort) options.signal?.removeEventListener("abort", abort);
		}
	}

	public get sanitizedStderr(): string {
		return this.stderr.value();
	}

	public async shutdown(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.session.shutdown();
		} finally {
			this.connection.close();
			await terminateChild(this.child);
		}
	}

	public async terminate(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.connection.close();
		await terminateChild(this.child);
	}
}
