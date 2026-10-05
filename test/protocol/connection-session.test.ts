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
	it("serves effective global settings for workspace/configuration items", async () => {
		const { client, server: fake } = channels();
		const settings = {
			yaml: {
				schemaStore: { enable: false },
				schemas: {
					"https://example.com/schemas/example.json": ["example.yaml"],
				},
			},
			nested: { flag: true, blank: null, empty: "" },
		};
		new LspSession(client, {
			rootPath: process.cwd(),
			server: { ...server, settings },
		});
		await expect(
			fake.sendRequest("workspace/configuration", {
				items: [
					{},
					{ section: "" },
					{ section: "yaml.schemaStore" },
					{ section: "yaml.schemaStore.enable" },
					{ section: "yaml.schemas" },
					{ section: "nested.flag" },
					{ section: "nested.blank" },
					{ section: "missing" },
					{ section: "nested.flag.child" },
					// Own properties only: inherited names resolve to an empty object.
					{ section: "constructor" },
					{ section: "toString" },
					{ scopeUri: "file:///ignored", section: "nested.flag" },
				],
			}),
		).resolves.toEqual([
			settings,
			settings,
			{ enable: false },
			false,
			{ "https://example.com/schemas/example.json": ["example.yaml"] },
			true,
			null,
			{},
			{},
			{},
			{},
			true,
		]);
		expect(
			await fake.sendRequest("workspace/configuration", { items: [] }),
		).toEqual([]);
		client.close();
		fake.dispose();
	});
	it("rejects malformed workspace/configuration requests with InvalidParams", async () => {
		const { client, server: fake } = channels();
		new LspSession(client, {
			rootPath: process.cwd(),
			server: { ...server, settings: { value: 1 } },
		});
		for (const params of [
			null,
			undefined,
			"items",
			{},
			{ items: "all" },
			{ items: [null] },
			{ items: [1] },
			{ items: [{ section: 1 }] },
			{ items: [{ section: null }] },
		]) {
			await expect(
				fake.sendRequest("workspace/configuration", params),
			).rejects.toMatchObject({
				code: -32602,
				message: expect.stringMatching(/^configuration /),
			});
		}
		client.close();
		fake.dispose();
	});
	it("keeps initializationOptions separate from the served settings", async () => {
		const { client, server: fake } = channels();
		let initializationOptions: unknown;
		let changed: unknown;
		fake.onRequest("initialize", async (params) => {
			initializationOptions = (params as { initializationOptions?: unknown })
				.initializationOptions;
			return { capabilities: {} };
		});
		fake.onNotification("workspace/didChangeConfiguration", (params) => {
			changed = (params as { settings?: unknown }).settings;
		});
		const settings = { yaml: { schemaStore: { enable: false } } };
		const session = new LspSession(client, {
			rootPath: process.cwd(),
			server: { ...server, initialization: { locale: "en" }, settings },
		});
		expect(await session.initialize()).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(initializationOptions).toEqual({ locale: "en" });
		expect(changed).toEqual(settings);
		client.close();
		fake.dispose();
	});
	it("acknowledges an empty capability registration during initialize", async () => {
		const { client, server: fake } = channels();
		let registration: unknown = "unanswered";
		fake.onRequest("initialize", async () => {
			registration = await fake.sendRequest("client/registerCapability", {
				registrations: [],
			});
			return { capabilities: {} };
		});
		const session = new LspSession(client, {
			rootPath: process.cwd(),
			server,
		});
		expect(await session.initialize()).toBe(true);
		expect(registration).toBeNull();
		client.close();
		fake.dispose();
	});
	it("delivers a window/logMessage registered before initialize", async () => {
		// @tailwindcss/language-server 0.16.0 can log during the initialize
		// handshake, so the real fixture subscribes before initialization. This
		// pins that ordering: a handler registered on the connection before
		// initialize is called still receives a notification the server sends
		// before it answers initialize.
		const { client, server: fake } = channels();
		const observed: string[] = [];
		client.onNotification("window/logMessage", (params) => {
			observed.push(
				(params as { message?: string } | undefined)?.message ?? "",
			);
		});
		fake.onRequest("initialize", async () => {
			await fake.sendNotification("window/logMessage", {
				type: 3,
				message: "engine loaded",
			});
			return { capabilities: {} };
		});
		const session = new LspSession(client, {
			rootPath: process.cwd(),
			server,
		});
		const initialized = session.initialize().then((value) => {
			observed.push("initialized");
			return value;
		});
		expect(await initialized).toBe(true);
		expect(observed).toEqual(["engine loaded", "initialized"]);
		client.close();
		fake.dispose();
	});
	it("acknowledges an empty capability unregistration", async () => {
		const { client, server: fake } = channels();
		new LspSession(client, { rootPath: process.cwd(), server });
		await expect(
			fake.sendRequest("client/unregisterCapability", {
				unregisterations: [],
			}),
		).resolves.toBeNull();
		client.close();
		fake.dispose();
	});
	it("rejects malformed capability registration params", async () => {
		const { client, server: fake } = channels();
		new LspSession(client, { rootPath: process.cwd(), server });
		for (const params of [
			{},
			{ registrations: null },
			{ registrations: "all" },
			null,
			undefined,
			"all",
			42,
			true,
			[],
			[1, 2],
		]) {
			await expect(
				fake.sendRequest("client/registerCapability", params),
			).rejects.toMatchObject({
				code: -32602,
				message: "registration params must contain an array",
			});
		}
		client.close();
		fake.dispose();
	});
	it("rejects a non-empty registration and keeps server capabilities unchanged", async () => {
		const { client, server: fake } = channels();
		const session = new LspSession(client, {
			rootPath: process.cwd(),
			server,
		});
		await expect(
			fake.sendRequest("client/registerCapability", {
				registrations: [
					{
						id: "watched-files",
						method: "workspace/didChangeWatchedFiles",
						registerOptions: { watchers: [{ globPattern: "**/*.css" }] },
					},
				],
			}),
		).rejects.toMatchObject({ code: -32601 });
		await expect(
			fake.sendRequest("client/unregisterCapability", {
				unregisterations: [
					{ id: "watched-files", method: "workspace/didChangeWatchedFiles" },
				],
			}),
		).rejects.toMatchObject({ code: -32601 });
		// A rejected list changes no observable session state: the advertised
		// capabilities stay empty and the next empty list is still acknowledged.
		expect(session.capabilities).toEqual({});
		await expect(
			fake.sendRequest("client/registerCapability", { registrations: [] }),
		).resolves.toBeNull();
		client.close();
		fake.dispose();
	});
	it("answers workspace folder requests with the configured folders", async () => {
		const { client, server: fake } = channels();
		const folders = [{ uri: "file:///workspace", name: "workspace" }];
		new LspSession(client, {
			rootPath: process.cwd(),
			server,
			workspaceFolders: folders,
		});
		await expect(
			fake.sendRequest("workspace/workspaceFolders", null),
		).resolves.toEqual(folders);
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
