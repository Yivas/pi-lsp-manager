import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EffectiveServerConfig } from "../../src/contracts.js";
import { NodeLspRuntimeSession } from "../../src/protocol/process.js";
import { RuntimePool } from "../../src/runtime/pool.js";
import { retryOnce, TransientRuntimeError } from "../../src/runtime/retry.js";

const server: EffectiveServerConfig = {
	id: "typescript",
	enabled: true,
	autoInstall: true,
	priority: 100,
	command: process.execPath,
	args: [],
	extensions: [".ts"],
	roles: ["diagnostics", "semantic", "mutation"],
	languageIds: ["typescript"],
	admission: "tested",
	manualHelp: "manual",
};
const fakeServer = join(
	dirname(fileURLToPath(import.meta.url)),
	"../fake-lsp/server.mjs",
);

function options() {
	return {
		rootPath: process.cwd(),
		server,
		launch: {
			command: process.execPath,
			args: [fakeServer],
			shell: false as const,
		},
		requestTimeoutMs: 2_000,
		cancelDrainMs: 200,
	};
}

const wait = (milliseconds = 10) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("owned stdio LSP process", () => {
	it("initializes a real child, serves workspace requests, and balances document notifications", async () => {
		const runtime = await NodeLspRuntimeSession.start(options());
		const uri = "file:///workspace/example.ts";
		await runtime.session.documents.open(
			runtime.connection,
			uri,
			"typescript",
			"let x = 1;\n",
		);
		await runtime.session.documents.change(
			runtime.connection,
			uri,
			"let x = 2;\n",
		);
		await runtime.session.documents.close(runtime.connection, uri);
		await wait();
		const state = await runtime.connection.request<Record<string, number>>(
			"state",
			{},
		);
		expect(state.ok).toBe(true);
		if (!state.ok) throw new Error("Expected fake server state.");
		expect(state.value.initialized).toBe(1);
		expect(state.value.configuration).toBeGreaterThanOrEqual(1);
		expect(state.value.folders).toBe(1);
		expect(state.value.open).toBe(1);
		expect(state.value.change).toBe(1);
		expect(state.value.close).toBe(1);
		await runtime.shutdown();
	}, 15_000);

	it("aborts and fully closes an owned child while initialization is pending", async () => {
		const abort = new AbortController();
		let exited = false;
		const starting = NodeLspRuntimeSession.start({
			...options(),
			server: { ...server, initialization: { delayInitialize: true } },
			signal: abort.signal,
			onExit: () => {
				exited = true;
			},
		});
		await wait(30);
		abort.abort();
		await expect(starting).rejects.toThrow("start_aborted");
		expect(exited).toBe(true);
	}, 15_000);

	it("sends a real cancellation notification and drains its late response", async () => {
		const runtime = await NodeLspRuntimeSession.start(options());
		const abort = new AbortController();
		const pending = runtime.connection.request("late", {}, abort.signal);
		let state = await runtime.connection.request<Record<string, number>>(
			"state",
			{},
		);
		for (
			let attempt = 0;
			attempt < 20 && (!state.ok || state.value.late === 0);
			attempt += 1
		) {
			await wait(5);
			state = await runtime.connection.request<Record<string, number>>(
				"state",
				{},
			);
		}
		expect(state.ok && state.value.late).toBe(1);
		abort.abort();
		expect(await pending).toEqual({ ok: false, code: "cancelled" });
		await wait(30);
		state = await runtime.connection.request<Record<string, number>>(
			"state",
			{},
		);
		expect(state.ok && state.value.cancelled).toBeGreaterThan(0);
		expect(runtime.connection.isTainted).toBe(false);
		await runtime.shutdown();
	}, 15_000);

	it("evicts a crashed child and retries a read operation once without retrying mutation", async () => {
		const crashed = await NodeLspRuntimeSession.start(options());
		const failed = await crashed.connection.request("crash", {});
		expect(failed.ok).toBe(false);
		await wait(20);
		let attempts = 0;
		const result = await retryOnce("definition", async () => {
			attempts += 1;
			if (attempts === 1) throw new TransientRuntimeError("crashed child");
			const replacement = await NodeLspRuntimeSession.start(options());
			const state = await replacement.connection.request<{
				initialized: number;
			}>("state", {});
			await replacement.shutdown();
			if (!state.ok) throw new Error("replacement failed");
			return state.value.initialized;
		});
		expect(result).toBe(1);
		expect(attempts).toBe(2);
		let mutationAttempts = 0;
		await expect(
			retryOnce("rename", async () => {
				mutationAttempts += 1;
				throw new Error("do not retry mutation");
			}),
		).rejects.toThrow("do not retry mutation");
		expect(mutationAttempts).toBe(1);
		await crashed.terminate();
	}, 15_000);

	it("unpublishes a crashed pooled child before a later acquire", async () => {
		const pool = new RuntimePool();
		const key = await pool.key(process.cwd(), "crash-test");
		let starts = 0;
		const acquire = () =>
			pool.acquire(process.cwd(), "crash-test", async (signal) => {
				starts += 1;
				return NodeLspRuntimeSession.start({
					...options(),
					signal,
					...pool.lifecycleCallbacks(key),
				});
			});
		const first = await acquire();
		const runtime = first.entry.session as NodeLspRuntimeSession;
		await runtime.connection.request("crash", {});
		await wait(40);
		const second = await acquire();
		expect(starts).toBe(2);
		first.lease.release();
		second.lease.release();
		await pool.shutdown();
	}, 15_000);

	it("taints, terminates, and evicts a nonresponsive child before concurrent reuse", async () => {
		const pool = new RuntimePool();
		let starts = 0;
		const key = await pool.key(process.cwd(), "typescript");
		const factory = async (signal: AbortSignal) => {
			starts += 1;
			return NodeLspRuntimeSession.start({
				...options(),
				signal,
				...pool.lifecycleCallbacks(key),
			});
		};
		const acquired = await pool.acquire(process.cwd(), "typescript", factory);
		const runtime = acquired.entry.session as NodeLspRuntimeSession;
		expect(await runtime.connection.request("silent", {})).toEqual({
			ok: false,
			code: "tainted",
		});
		const replacement = await pool.acquire(
			process.cwd(),
			"typescript",
			factory,
		);
		expect(pool.size()).toBe(1);
		acquired.lease.release();
		expect(starts).toBe(2);
		replacement.lease.release();
		await pool.shutdown();
	}, 15_000);
});
