import { createHash } from "node:crypto";
import type { LspConnection } from "./connection.js";

export interface DocumentState {
	uri: string;
	languageId: string;
	version: number;
	hash: string;
	text: string;
}

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function utf16Offset(
	text: string,
	line: number,
	character: number,
): number | undefined {
	if (line < 0 || character < 0) return undefined;
	let offset = 0;
	for (let currentLine = 0; currentLine < line; currentLine += 1) {
		const newline = text.indexOf("\n", offset);
		if (newline < 0) return undefined;
		offset = newline + 1;
	}
	let units = 0;
	let end = offset;
	for (; end < text.length && text[end] !== "\n" && text[end] !== "\r"; ) {
		if (units === character) return end;
		const codePoint = text.codePointAt(end);
		if (codePoint === undefined) return undefined;
		const width = codePoint > 0xffff ? 2 : 1;
		units += width;
		end += width;
	}
	// LSP positions are UTF-16 boundaries: do not accept the middle of a pair,
	// nor the CR in a CRLF terminator as document content.
	return units === character ? end : undefined;
}

export class DocumentStore {
	private readonly documents = new Map<string, DocumentState>();

	public get(uri: string): DocumentState | undefined {
		return this.documents.get(uri);
	}

	public async open(
		connection: LspConnection,
		uri: string,
		languageId: string,
		text: string,
	): Promise<DocumentState> {
		const current = this.documents.get(uri);
		if (current) return this.change(connection, uri, text);
		const state: DocumentState = {
			uri,
			languageId,
			version: 1,
			hash: hash(text),
			text,
		};
		await connection.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: state.version, text },
		});
		this.documents.set(uri, state);
		return state;
	}

	public async change(
		connection: LspConnection,
		uri: string,
		text: string,
	): Promise<DocumentState> {
		const current = this.documents.get(uri);
		if (!current)
			throw new Error("Document must be opened before changing it.");
		const state = {
			...current,
			version: current.version + 1,
			hash: hash(text),
			text,
		};
		await connection.notify("textDocument/didChange", {
			textDocument: { uri, version: state.version },
			contentChanges: [{ text }],
		});
		this.documents.set(uri, state);
		return state;
	}

	public async close(connection: LspConnection, uri: string): Promise<void> {
		if (!this.documents.has(uri)) return;
		await connection.notify("textDocument/didClose", { textDocument: { uri } });
		this.documents.delete(uri);
	}
}
