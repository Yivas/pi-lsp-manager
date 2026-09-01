export interface LspPosition {
	line: number;
	character: number;
}
export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}
export interface NormalizedTextEdit {
	range: LspRange;
	newText: string;
}
export interface NormalizedDocumentEdit {
	uri: string;
	/** Omitted or null means unversioned according to the LSP specification. */
	version?: number;
	edits: readonly NormalizedTextEdit[];
}
export interface NormalizedWorkspaceEdit {
	documents: readonly NormalizedDocumentEdit[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function onlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}
function position(value: unknown): LspPosition | undefined {
	const item = record(value);
	if (
		!item ||
		!onlyKeys(item, ["line", "character"]) ||
		!Number.isInteger(item.line) ||
		!Number.isInteger(item.character) ||
		(item.line as number) < 0 ||
		(item.character as number) < 0
	)
		return undefined;
	return { line: item.line as number, character: item.character as number };
}
function textEdit(value: unknown): NormalizedTextEdit | undefined {
	const item = record(value);
	if (
		!item ||
		!onlyKeys(item, ["range", "newText"]) ||
		typeof item.newText !== "string"
	)
		return undefined;
	const range = record(item.range);
	if (!range || !onlyKeys(range, ["start", "end"])) return undefined;
	const start = position(range.start);
	const end = position(range.end);
	return start && end
		? { range: { start, end }, newText: item.newText }
		: undefined;
}
function documentEdit(value: unknown): NormalizedDocumentEdit | undefined {
	const item = record(value);
	if (!item || !onlyKeys(item, ["textDocument", "edits"])) return undefined;
	const textDocument = record(item.textDocument);
	if (
		!textDocument ||
		!onlyKeys(textDocument, ["uri", "version"]) ||
		typeof textDocument.uri !== "string" ||
		(textDocument.version !== undefined &&
			textDocument.version !== null &&
			(!Number.isInteger(textDocument.version) ||
				(textDocument.version as number) < 0)) ||
		!Array.isArray(item.edits) ||
		item.edits.length === 0
	)
		return undefined;
	const edits = item.edits.map(textEdit);
	if (edits.some((edit) => !edit)) return undefined;
	return {
		uri: textDocument.uri,
		...(typeof textDocument.version === "number"
			? { version: textDocument.version }
			: {}),
		edits: edits as NormalizedTextEdit[],
	};
}

/**
 * Parses the deliberately small v1 textual WorkspaceEdit subset. Exactly one of
 * changes/documentChanges is accepted; resource operations and annotations are
 * intentionally outside the supported mutation contract.
 */
export function normalizeWorkspaceEdit(
	value: unknown,
): NormalizedWorkspaceEdit | undefined {
	const workspace = record(value);
	if (!workspace || !onlyKeys(workspace, ["changes", "documentChanges"]))
		return undefined;
	const hasChanges = workspace.changes !== undefined;
	const hasDocumentChanges = workspace.documentChanges !== undefined;
	if (hasChanges === hasDocumentChanges) return undefined;
	const documents: NormalizedDocumentEdit[] = [];
	if (hasChanges) {
		const changes = record(workspace.changes);
		if (!changes || Object.keys(changes).length === 0) return undefined;
		for (const [uri, rawEdits] of Object.entries(changes)) {
			if (!Array.isArray(rawEdits) || rawEdits.length === 0) return undefined;
			const edits = rawEdits.map(textEdit);
			if (edits.some((edit) => !edit)) return undefined;
			documents.push({ uri, edits: edits as NormalizedTextEdit[] });
		}
	} else {
		if (
			!Array.isArray(workspace.documentChanges) ||
			workspace.documentChanges.length === 0
		)
			return undefined;
		for (const item of workspace.documentChanges) {
			const parsed = documentEdit(item);
			// Resource operations (CreateFile/RenameFile/DeleteFile) cannot parse here.
			if (!parsed) return undefined;
			documents.push(parsed);
		}
	}
	const uris = new Set<string>();
	for (const document of documents) {
		if (uris.has(document.uri)) return undefined;
		uris.add(document.uri);
	}
	return { documents };
}
