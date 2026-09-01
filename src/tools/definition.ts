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

export const definitionSchema = Type.Object(
	{
		filePath: Type.String({ minLength: 1 }),
		line: Type.Integer({ minimum: 1 }),
		character: Type.Integer({ minimum: 0 }),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	},
	{ additionalProperties: false },
);
export type DefinitionInput = Static<typeof definitionSchema>;

interface Position {
	line: number;
	character: number;
}
interface Range {
	start: Position;
	end: Position;
}
function isPosition(value: unknown): value is Position {
	const position = value as Partial<Position> | null;
	return (
		position !== null &&
		Number.isInteger(position.line) &&
		Number.isInteger(position.character) &&
		(position.line ?? -1) >= 0 &&
		(position.character ?? -1) >= 0
	);
}
function isRange(value: unknown): value is Range {
	const range = value as Partial<Range> | null;
	return range !== null && isPosition(range.start) && isPosition(range.end);
}
function location(
	value: unknown,
): { uri: string; position: Position } | undefined {
	const candidate = value as {
		uri?: unknown;
		range?: unknown;
		targetUri?: unknown;
		targetRange?: unknown;
		targetSelectionRange?: unknown;
	};
	if (typeof candidate.uri === "string" && isRange(candidate.range))
		return { uri: candidate.uri, position: candidate.range.start };
	if (
		typeof candidate.targetUri === "string" &&
		isRange(candidate.targetRange)
	) {
		return {
			uri: candidate.targetUri,
			position: isRange(candidate.targetSelectionRange)
				? candidate.targetSelectionRange.start
				: candidate.targetRange.start,
		};
	}
	return undefined;
}

export async function definition(
	service: TrustedOperationService,
	ctx: Parameters<TrustedOperationService["read"]>[0],
	input: DefinitionInput,
	signal: AbortSignal | undefined,
) {
	try {
		const value = await service.read(
			ctx,
			input.filePath,
			"semantic",
			async (operation) => {
				if (
					!hasCapability(operation.runtime.session.capabilities, "definition")
				)
					throw new ToolError(
						"capability_missing",
						"Use a server that supports definitions.",
					);
				const document = operation.runtime.session.documents.get(operation.uri);
				if (
					!document ||
					utf16Offset(document.text, input.line - 1, input.character) ===
						undefined
				)
					throw new ToolError("invalid_file", "Use a valid UTF-16 position.");
				const result = await operation.runtime.connection.request<unknown>(
					"textDocument/definition",
					{
						textDocument: { uri: operation.uri },
						position: { line: input.line - 1, character: input.character },
					},
					signal,
				);
				if (!result.ok) throwConnectionFailure(result.code);
				const raw = Array.isArray(result.value)
					? result.value
					: result.value
						? [result.value]
						: [];
				const locations = raw.slice(0, 1_000).map(location).filter(Boolean) as {
					uri: string;
					position: Position;
				}[];
				const rootUri = `${pathToFileURL(operation.target.rootPath).href.replace(/\/$/, "")}/`;
				const sorted = [
					...stable(
						locations,
						(item) =>
							`${item.uri}:${item.position.line}:${item.position.character}`,
					),
				].sort((left, right) =>
					compareText(
						`${left.uri}:${left.position.line}:${left.position.character}`,
						`${right.uri}:${right.position.line}:${right.position.character}`,
					),
				);
				return bounded(sorted, input.limit).map((item) =>
					relativeLocation(item.uri, rootUri, item.position),
				);
			},
			signal,
		);
		return success({ definitions: value });
	} catch (error) {
		return failure(
			error instanceof ToolError
				? error
				: new ToolError("runtime_failed", "Retry the request."),
		);
	}
}
