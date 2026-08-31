import { PassThrough } from "node:stream";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { describe, expect, it } from "vitest";
import { LspConnection } from "../../src/protocol/connection.js";
import { DiagnosticCollector } from "../../src/protocol/diagnostics.js";

function pair() {
	const fromServer = new PassThrough();
	const fromClient = new PassThrough();
	const server = createMessageConnection(
		new StreamMessageReader(fromClient),
		new StreamMessageWriter(fromServer),
	);
	server.listen();
	return {
		server,
		client: new LspConnection(fromServer, fromClient, {
			requestTimeoutMs: 50,
			cancelDrainMs: 10,
		}),
	};
}
const diagnostic = {
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	message: "error",
	source: "fake",
};

describe("diagnostic reconciliation", () => {
	it("waits through an initial empty push publication for a delayed diagnostic", async () => {
		const { client, server } = pair();
		const collector = new DiagnosticCollector(client, {
			pushDiagnosticsGraceMs: 50,
			diagnosticsSettleMs: 1,
			pullDiagnosticsGraceMs: 20,
		});
		await server.sendNotification("textDocument/publishDiagnostics", {
			uri: "file:///a.ts",
			version: 1,
			diagnostics: [],
		});
		setTimeout(
			() =>
				void server.sendNotification("textDocument/publishDiagnostics", {
					uri: "file:///a.ts",
					version: 1,
					diagnostics: [diagnostic],
				}),
			5,
		);
		expect(await collector.collect("file:///a.ts", 1, false)).toEqual({
			ok: true,
			diagnostics: [diagnostic],
		});
		client.close();
		server.dispose();
	});
	it("waits for a delayed unversioned push when pull responds empty", async () => {
		const { client, server } = pair();
		const collector = new DiagnosticCollector(client, {
			pushDiagnosticsGraceMs: 50,
			diagnosticsSettleMs: 1,
			pullDiagnosticsGraceMs: 30,
		});
		server.onRequest("textDocument/diagnostic", () => ({ items: [] }));
		setTimeout(
			() =>
				void server.sendNotification("textDocument/publishDiagnostics", {
					uri: "file:///pull.ts",
					diagnostics: [diagnostic, diagnostic],
				}),
			5,
		);
		expect(await collector.collect("file:///pull.ts", 4, true)).toEqual({
			ok: true,
			diagnostics: [diagnostic],
		});
		client.close();
		server.dispose();
	});

	it("returns a nonempty pull immediately and rejects oversized published URIs", async () => {
		const { client, server } = pair();
		let sleeps = 0;
		const collector = new DiagnosticCollector(
			client,
			{
				pushDiagnosticsGraceMs: 50,
				diagnosticsSettleMs: 1,
				pullDiagnosticsGraceMs: 50,
				maxUriLength: 12,
			},
			{
				sleep: async () => {
					sleeps += 1;
				},
			},
		);
		server.onRequest("textDocument/diagnostic", () => ({
			items: [diagnostic],
		}));
		await server.sendNotification("textDocument/publishDiagnostics", {
			uri: "file:///this-uri-is-too-long.ts",
			diagnostics: [diagnostic],
		});
		expect(await collector.collect("file:///ok.ts", 1, true)).toEqual({
			ok: true,
			diagnostics: [diagnostic],
		});
		expect(sleeps).toBe(0);
		client.close();
		server.dispose();
	});

	it("uses an injected clock and sleep seam for bounded silent-server polling", async () => {
		const { client, server } = pair();
		let now = 0;
		const collector = new DiagnosticCollector(
			client,
			{
				pushDiagnosticsGraceMs: 30,
				diagnosticsSettleMs: 10,
				pullDiagnosticsGraceMs: 10,
			},
			{
				now: () => now,
				sleep: async (milliseconds) => {
					now += milliseconds;
				},
			},
		);
		expect(await collector.collect("file:///silent.ts", 1, false)).toEqual({
			ok: false,
			code: "diagnostics_timed_out",
		});
		client.close();
		server.dispose();
	});

	it("keeps newer nonempty push diagnostics when a pull is empty and reports silent servers", async () => {
		const { client, server } = pair();
		const collector = new DiagnosticCollector(client, {
			pushDiagnosticsGraceMs: 15,
			diagnosticsSettleMs: 1,
			pullDiagnosticsGraceMs: 10,
		});
		await server.sendNotification("textDocument/publishDiagnostics", {
			uri: "file:///a.ts",
			version: 2,
			diagnostics: [diagnostic],
		});
		server.onRequest("textDocument/diagnostic", () => ({ items: [] }));
		expect(await collector.collect("file:///a.ts", 2, true)).toEqual({
			ok: true,
			diagnostics: [diagnostic],
		});
		expect(await collector.collect("file:///silent.ts", 1, false)).toEqual({
			ok: false,
			code: "diagnostics_timed_out",
		});
		client.close();
		server.dispose();
	});
});
