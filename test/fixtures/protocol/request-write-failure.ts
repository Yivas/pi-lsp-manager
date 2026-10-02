// Strict-process harness for a request whose accepted write fails.
//
// `vscode-jsonrpc@9.0.2` writes a request through a semaphore that defers the real stream write to a
// `setImmediate`. When that deferred write fails, `sendRequest` rejects the caller's request as
// intended and then rethrows the raw write error from an `async` executor whose promise nobody
// observes. Under `--unhandled-rejections=strict` that orphan becomes a non-zero exit even though the
// application already handled the request failure. This fixture drives the real `LspConnection` over
// a real child pipe, prints one synchronous marker per observation, and lets the exit code carry the
// orphan rejection.
//
// Usage: node --unhandled-rejections=strict <compiled fixture> <peer|dispose|unexpected|healthy>

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { LspConnection } from "../../../src/protocol/connection.js";

const REQUEST_TIMEOUT_MS = 5_000;
const CANCEL_DRAIN_MS = 200;
/** A peer outlives a pipe the fixture closes, so the fixture decides when the transport ends. */
const PEER_EXIT_GRACE_MS = 2_000;
const OBSERVATION_TIMEOUT_MS = 5_000;

/** One line per observation, written synchronously so a strict-mode abort cannot drop it. */
function mark(line: string): void {
	writeSync(1, `MARK ${line}\n`);
}

/**
 * Owns the pipe handed to the connection, so a write the platform rejects is observed through the
 * stream's own error event instead of a process-wide rejection handler.
 */
function ownedTransport(pipe: NodeJS.WritableStream) {
	const failures: string[] = [];
	const output = new Writable({
		write(chunk, _encoding, callback) {
			pipe.write(chunk, callback);
		},
	});
	output.on("error", (error: NodeJS.ErrnoException) => {
		const code = error.code ?? error.message;
		failures.push(code);
		if (failures.length === 1) mark(`write-failure=${code}`);
	});
	return { output, failures };
}

/** Version of the package this subprocess actually resolved, root copy or nested copy alike. */
function resolvedJsonrpcVersion(): string {
	const entry = createRequire(import.meta.url).resolve("vscode-jsonrpc");
	const manifest = JSON.parse(
		readFileSync(join(dirname(entry), "..", "..", "package.json"), "utf8"),
	) as { version: string };
	return manifest.version;
}

function startPeer(): ChildProcess {
	return spawn(process.execPath, [process.argv[1] ?? "", "peer"], {
		stdio: ["pipe", "pipe", "inherit"],
	});
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** A subprocess that exits before the deferred write dispatches is not evidence, so wait for it. */
async function observeWriteFailure(failures: string[]): Promise<void> {
	const deadline = Date.now() + OBSERVATION_TIMEOUT_MS;
	while (failures.length === 0) {
		if (Date.now() > deadline)
			throw new Error("the accepted request write never failed");
		await wait(5);
	}
}

/** Bounded wait that resolves `false` at the deadline, so a timeout cannot pass as an event. */
async function settledWithin(
	register: (done: () => void) => void,
): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), OBSERVATION_TIMEOUT_MS);
		register(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/** Stops the peer and fails the scenario unless its exit is observed. */
async function stopPeer(peer: ChildProcess): Promise<void> {
	if (peer.exitCode !== null || peer.signalCode !== null) return;
	const exited = await settledWithin((done) => {
		peer.once("close", done);
		peer.kill("SIGKILL");
	});
	if (!exited)
		throw new Error("the peer did not exit within the observation deadline");
}

/** Dispose before the deferred write is dispatched; the pipe disappears in the same drain. */
async function disposeBeforeDispatch(): Promise<void> {
	const peer = startPeer();
	const transport = ownedTransport(peer.stdin ?? process.stdout);
	const connection = new LspConnection(
		peer.stdout ?? process.stdin,
		transport.output,
		{ requestTimeoutMs: REQUEST_TIMEOUT_MS, cancelDrainMs: CANCEL_DRAIN_MS },
	);
	const pending = connection.request("initialize", {});
	connection.close();
	peer.stdin?.destroy();
	mark(`request=${JSON.stringify(await pending)}`);
	await observeWriteFailure(transport.failures);
	await stopPeer(peer);
	mark(`writes-failed=${transport.failures.length}`);
	mark(`resolved-jsonrpc=${resolvedJsonrpcVersion()}`);
	mark("exit=clean");
}

/** An accepted write fails with no caller abort and no caller close first. */
async function unexpectedTransportFailure(): Promise<void> {
	const peer = startPeer();
	const transport = ownedTransport(peer.stdin ?? process.stdout);
	const connection = new LspConnection(
		peer.stdout ?? process.stdin,
		transport.output,
		{ requestTimeoutMs: REQUEST_TIMEOUT_MS, cancelDrainMs: CANCEL_DRAIN_MS },
	);
	const pending = connection.request("initialize", {});
	peer.stdin?.destroy();
	mark(`request=${JSON.stringify(await pending)}`);
	await observeWriteFailure(transport.failures);
	mark(`reuse=${JSON.stringify(await connection.request("probe", {}))}`);
	await stopPeer(peer);
	// `stopPeer` returns only after an observed exit, so this marker cannot come from the SIGKILL
	// request alone. Recovery is measured separately below and must stay closed after that exit.
	mark("peer-exit=confirmed");
	mark(`after-eof=${JSON.stringify(await connection.request("probe", {}))}`);
	mark(`resolved-jsonrpc=${resolvedJsonrpcVersion()}`);
	mark("exit=clean");
}

/** Control: a healthy request, a notification, and no failed write anywhere. */
async function healthyRequest(): Promise<void> {
	const peer = startPeer();
	const transport = ownedTransport(peer.stdin ?? process.stdout);
	const connection = new LspConnection(
		peer.stdout ?? process.stdin,
		transport.output,
		{ requestTimeoutMs: REQUEST_TIMEOUT_MS, cancelDrainMs: CANCEL_DRAIN_MS },
	);
	mark(`request=${JSON.stringify(await connection.request("initialize", {}))}`);
	await connection.notify("initialized", {});
	mark("notify=resolved");
	mark(`probe=${JSON.stringify(await connection.request("probe", {}))}`);
	mark(`writes-failed=${transport.failures.length}`);
	mark(`resolved-jsonrpc=${resolvedJsonrpcVersion()}`);
	await stopPeer(peer);
	mark("exit=clean");
}

/** Minimal LSP peer over stdio: it answers requests and counts the `initialized` notification. */
function serve(): void {
	const connection = createMessageConnection(
		new StreamMessageReader(process.stdin),
		new StreamMessageWriter(process.stdout),
	);
	let initialized = 0;
	connection.onRequest("initialize", () => ({
		capabilities: { definitionProvider: true },
	}));
	connection.onRequest("probe", () => ({ value: "peer-value", initialized }));
	connection.onNotification("initialized", () => {
		initialized += 1;
	});
	connection.listen();
	process.stdin.on("end", () => {
		setTimeout(() => process.exit(0), PEER_EXIT_GRACE_MS);
	});
}

function run(scenario: () => Promise<void>): void {
	scenario().catch((error: unknown) => {
		mark(
			`fixture-error=${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	});
}

switch (process.argv[2]) {
	case "peer":
		serve();
		break;
	case "dispose":
		run(disposeBeforeDispatch);
		break;
	case "unexpected":
		run(unexpectedTransportFailure);
		break;
	case "healthy":
		run(healthyRequest);
		break;
	default:
		mark(`unknown-scenario=${process.argv[2] ?? ""}`);
		process.exitCode = 2;
}
