import { Type, type Static } from "typebox";
import { hasCapability } from "../protocol/capabilities.js";
import { utf16Offset } from "../protocol/documents.js";
import { failure, success } from "./render.js";
import {
	throwConnectionFailure,
	ToolError,
	type TrustedOperationService,
} from "./shared.js";

export const prepareRenameSchema = Type.Object(
	{
		filePath: Type.String({ minLength: 1 }),
		line: Type.Integer({ minimum: 1 }),
		character: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type PrepareRenameInput = Static<typeof prepareRenameSchema>;

interface LspPosition {
	line: number;
	character: number;
}
interface LspRange {
	start: LspPosition;
	end: LspPosition;
}
function isPosition(value: unknown): value is LspPosition {
	const position = value as Partial<LspPosition> | null;
	return (
		position !== null &&
		Number.isInteger(position.line) &&
		Number.isInteger(position.character) &&
		(position.line ?? -1) >= 0 &&
		(position.character ?? -1) >= 0
	);
}
function isRange(value: unknown): value is LspRange {
	const range = value as Partial<LspRange> | null;
	return range !== null && isPosition(range.start) && isPosition(range.end);
}
function publicRange(range: LspRange) {
	return {
		start: { line: range.start.line + 1, character: range.start.character },
		end: { line: range.end.line + 1, character: range.end.character },
	};
}

export async function prepareRename(
	service: TrustedOperationService,
	ctx: Parameters<TrustedOperationService["read"]>[0],
	input: PrepareRenameInput,
	signal: AbortSignal | undefined,
) {
	try {
		const value = await service.read(
			ctx,
			input.filePath,
			"semantic",
			async (operation) => {
				if (
					!hasCapability(
						operation.runtime.session.capabilities,
						"prepareRename",
					)
				)
					throw new ToolError(
						"capability_missing",
						"Use a server that supports prepare rename.",
					);
				const document = operation.runtime.session.documents.get(operation.uri);
				if (
					!document ||
					utf16Offset(document.text, input.line - 1, input.character) ===
						undefined
				)
					throw new ToolError("invalid_file", "Use a valid UTF-16 position.");
				const result = await operation.runtime.connection.request<unknown>(
					"textDocument/prepareRename",
					{
						textDocument: { uri: operation.uri },
						position: { line: input.line - 1, character: input.character },
					},
					signal,
				);
				if (!result.ok) throwConnectionFailure(result.code);
				if (result.value === null || result.value === undefined) return null;
				if (isRange(result.value)) return publicRange(result.value);
				const wrapped = result.value as {
					range?: unknown;
					placeholder?: unknown;
				};
				if (!isRange(wrapped.range))
					throw new ToolError("runtime_failed", "Retry the request.");
				return {
					range: publicRange(wrapped.range),
					...(typeof wrapped.placeholder === "string"
						? { placeholder: wrapped.placeholder }
						: {}),
				};
			},
			signal,
		);
		return success({ prepareRename: value });
	} catch (error) {
		return failure(
			error instanceof ToolError
				? error
				: new ToolError("runtime_failed", "Retry the request."),
		);
	}
}
