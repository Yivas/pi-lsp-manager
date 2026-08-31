import { PassThrough } from "node:stream";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { describe, expect, it } from "vitest";
import { hasCapability } from "../../src/protocol/capabilities.js";
import { LspConnection } from "../../src/protocol/connection.js";
import { DocumentStore, utf16Offset } from "../../src/protocol/documents.js";

function pair() {
	const clientInput = new PassThrough();
	const serverInput = new PassThrough();
	const server = createMessageConnection(
		new StreamMessageReader(serverInput),
		new StreamMessageWriter(clientInput),
	);
	server.listen();
	const client = new LspConnection(clientInput, serverInput, {
		requestTimeoutMs: 100,
		cancelDrainMs: 20,
	});
	return { client, server };
}

describe("documents and capabilities", () => {
	it("balances didOpen/change/close and tracks versions, hashes, CRLF, and UTF-16 offsets", async () => {
		const { client, server } = pair();
		const notifications: string[] = [];
		server.onNotification((method) => {
			notifications.push(method);
		});
		const documents = new DocumentStore();
		const opened = await documents.open(
			client,
			"file:///a.ts",
			"typescript",
			"const x = '😀';\r\n",
		);
		const changed = await documents.change(
			client,
			"file:///a.ts",
			"const y = '😀';\r\n",
		);
		await documents.close(client, "file:///a.ts");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(opened.version).toBe(1);
		expect(changed.version).toBe(2);
		expect(opened.hash).not.toBe(changed.hash);
		expect(utf16Offset(changed.text, 0, 13)).toBe(13);
		expect(utf16Offset("a😀\r\n", 0, 3)).toBe(3);
		expect(utf16Offset("a😀\r\n", 0, 2)).toBeUndefined();
		expect(utf16Offset("a😀\r\n", 0, 4)).toBeUndefined();
		expect(utf16Offset("a\r\n", 2, 0)).toBeUndefined();
		expect(notifications).toEqual([
			"textDocument/didOpen",
			"textDocument/didChange",
			"textDocument/didClose",
		]);
		client.close();
		server.dispose();
	});
	it("preserves document state when lifecycle notifications fail", async () => {
		const documents = new DocumentStore();
		const failing = {
			notify: async () => {
				throw new Error("notification failed");
			},
		} as unknown as LspConnection;
		await expect(
			documents.open(failing, "file:///failed.ts", "typescript", "x"),
		).rejects.toThrow("notification failed");
		expect(documents.get("file:///failed.ts")).toBeUndefined();
		const { client, server } = pair();
		await documents.open(client, "file:///failed.ts", "typescript", "x");
		await expect(
			documents.change(failing, "file:///failed.ts", "y"),
		).rejects.toThrow("notification failed");
		expect(documents.get("file:///failed.ts")?.text).toBe("x");
		await expect(documents.close(failing, "file:///failed.ts")).rejects.toThrow(
			"notification failed",
		);
		expect(documents.get("file:///failed.ts")?.version).toBe(1);
		client.close();
		server.dispose();
	});

	it("uses explicit capability gates for every supported shape", () => {
		const objectCapabilities = {
			diagnosticProvider: {},
			definitionProvider: true,
			referencesProvider: true,
			documentSymbolProvider: true,
			workspaceSymbolProvider: true,
			renameProvider: { prepareProvider: true },
			codeActionProvider: { resolveProvider: true },
		};
		for (const capability of [
			"diagnostics",
			"definition",
			"references",
			"documentSymbols",
			"workspaceSymbols",
			"prepareRename",
			"rename",
			"codeActions",
			"codeActionResolve",
		] as const)
			expect(hasCapability(objectCapabilities, capability)).toBe(true);
		expect(hasCapability({ renameProvider: true }, "prepareRename")).toBe(
			false,
		);
		expect(hasCapability({ renameProvider: true }, "rename")).toBe(true);
		expect(
			hasCapability({ codeActionProvider: true }, "codeActionResolve"),
		).toBe(false);
		expect(hasCapability({ codeActionProvider: true }, "codeActions")).toBe(
			true,
		);
		expect(hasCapability({}, "definition")).toBe(false);
	});
});
