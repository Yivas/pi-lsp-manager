import { pathToFileURL } from "node:url";
import { Type, type Static } from "typebox";
import { hasCapability } from "../protocol/capabilities.js";
import { utf16Offset } from "../protocol/documents.js";
import {
	bounded,
	compareText,
	failure,
	relativeLocation,
	stable,
	success,
} from "./render.js";
import {
	throwConnectionFailure,
	ToolError,
	type TrustedOperationService,
} from "./shared.js";

export const referencesSchema = Type.Object(
	{
		filePath: Type.String({ minLength: 1 }),
		line: Type.Integer({ minimum: 1 }),
		character: Type.Integer({ minimum: 0 }),
		includeDeclaration: Type.Optional(Type.Boolean()),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	},
	{ additionalProperties: false },
);
export type ReferencesInput = Static<typeof referencesSchema>;

interface ReferenceLocation {
	uri: string;
	range: { start: { line: number; character: number } };
}
function isReferenceLocation(value: unknown): value is ReferenceLocation {
	const location = value as {
		uri?: unknown;
		range?: { start?: { line?: unknown; character?: unknown } };
	};
	return (
		typeof location.uri === "string" &&
		Number.isInteger(location.range?.start?.line) &&
		Number.isInteger(location.range?.start?.character) &&
		(location.range?.start?.line as number) >= 0 &&
		(location.range?.start?.character as number) >= 0
	);
}

export async function references(
	service: TrustedOperationService,
	ctx: Parameters<TrustedOperationService["read"]>[0],
	input: ReferencesInput,
	signal: AbortSignal | undefined,
) {
	try {
		const value = await service.read(
			ctx,
			input.filePath,
			"semantic",
			async (operation) => {
				if (
					!hasCapability(operation.runtime.session.capabilities, "references")
				)
					throw new ToolError(
						"capability_missing",
						"Use a server that supports references.",
					);
				const document = operation.runtime.session.documents.get(operation.uri);
				if (
					!document ||
					utf16Offset(document.text, input.line - 1, input.character) ===
						undefined
				)
					throw new ToolError("invalid_file", "Use a valid UTF-16 position.");
				const result = await operation.runtime.connection.request<unknown>(
					"textDocument/references",
					{
						textDocument: { uri: operation.uri },
						position: { line: input.line - 1, character: input.character },
						context: { includeDeclaration: input.includeDeclaration ?? false },
					},
					signal,
				);
				if (!result.ok) throwConnectionFailure(result.code);
				const rootUri = `${pathToFileURL(operation.target.rootPath).href.replace(/\/$/, "")}/`;
				const values = Array.isArray(result.value)
					? result.value.slice(0, 1_000).filter(isReferenceLocation)
					: [];
				const unique = stable(
					values,
					(item) =>
						`${item.uri}:${item.range.start.line}:${item.range.start.character}`,
				);
				const sorted = [...unique].sort((a, b) =>
					compareText(
						`${a.uri}:${a.range.start.line}:${a.range.start.character}`,
						`${b.uri}:${b.range.start.line}:${b.range.start.character}`,
					),
				);
				return bounded(sorted, input.limit).map((item) =>
					relativeLocation(item.uri, rootUri, item.range.start),
				);
			},
			signal,
		);
		return success({ references: value });
	} catch (error) {
		return failure(
			error instanceof ToolError
				? error
				: new ToolError("runtime_failed", "Retry the request."),
		);
	}
}
