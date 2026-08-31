import { PassThrough } from "node:stream";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { describe, expect, it } from "vitest";
import { LspConnection } from "../../src/protocol/connection.js";
import { LspSession } from "../../src/protocol/session.js";

function channels() {
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
			requestTimeoutMs: 40,
			cancelDrainMs: 100,
		}),
	};
}
const server = {
	id: "typescript",
	enabled: true,
	autoInstall: true,
	priority: 1,
	command: "fake",
	args: [],
	extensions: [".ts"],
	roles: ["semantic"] as const,
	languageIds: ["typescript"],
	admission: "tested" as const,
	manualHelp: "manual",
};

describe("JSON-RPC LSP session", () => {
	it("initializes, answers workspace requests, and configures the server", async () => {
		const { client, server: fake } = channels();
		let initialized = false;
		fake.onRequest("initialize", async () => {
			const configuration = await fake.sendRequest<unknown[]>(
				"workspace/configuration",
				{ items: [{}] },
			);
			expect(configuration).toEqual([{}]);
			return { capabilities: { definitionProvider: true } };
		});
		fake.onNotification("initialized", () => {
			initialized = true;
		});
		const session = new LspSession(client, { rootPath: process.cwd(), server });
		expect(
			await Promise.all([session.initialize(), session.initialize()]),
		).toEqual([true, true]);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(initialized).toBe(true);
		expect(session.capabilities.definitionProvider).toBe(true);
		client.close();
		fake.dispose();
	});
	it("returns terminal connection states before sending requests", async () => {
		const { client, server: fake } = channels();
		const aborted = new AbortController();
		aborted.abort();
		expect(await client.request("anything", {}, aborted.signal)).toEqual({
			ok: false,
			code: "cancelled",
		});
		client.close();
		expect(await client.request("anything", {})).toEqual({
			ok: false,
			code: "closed",
		});
		await expect(client.notify("ignored", {})).rejects.toThrow(
			"connection_closed",
		);
		fake.dispose();
	});

	it("reports immediate request failures and drains timed-out responses", async () => {
		const { client, server: fake } = channels();
		fake.onRequest("fails", () => {
			throw new Error("expected");
		});
		expect(await client.request("fails", {})).toEqual({
			ok: false,
			code: "request_failed",
		});
		fake.onRequest("timeout", async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return "late";
		});
		expect(await client.request("timeout", {})).toEqual({
			ok: false,
			code: "timed_out",
		});
		expect(client.isTainted).toBe(false);
		client.close();
		fake.dispose();
	});

	it("drains a late cancelled response but taints a non-draining request", async () => {
		const { client, server: fake } = channels();
		fake.onRequest("late", async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return "late";
		});
		const abort = new AbortController();
		const pending = client.request<string>("late", {}, abort.signal);
		abort.abort();
		expect(await pending).toEqual({ ok: false, code: "cancelled" });
		expect(client.isTainted).toBe(false);
		fake.onRequest("silent", () => new Promise(() => undefined));
		expect(await client.request("silent", {})).toEqual({
			ok: false,
			code: "tainted",
		});
		expect(client.isTainted).toBe(true);
		client.close();
		fake.dispose();
	});
});
