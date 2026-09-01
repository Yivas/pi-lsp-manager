import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { hasCapability } from "../protocol/capabilities.js";
import { bounded, compareText, failure, success } from "./render.js";
import {
	throwConnectionFailure,
	ToolError,
	type TrustedOperationService,
} from "./shared.js";

export const symbolsSchema = Type.Object(
	{
		filePath: Type.String({ minLength: 1 }),
		scope: StringEnum(["document", "workspace"] as const),
		query: Type.Optional(Type.String({ maxLength: 256 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	},
	{ additionalProperties: false },
);
export type SymbolsInput = Static<typeof symbolsSchema>;

export async function symbols(
	service: TrustedOperationService,
	ctx: Parameters<TrustedOperationService["read"]>[0],
	input: SymbolsInput,
	signal: AbortSignal | undefined,
) {
	try {
		const value = await service.read(
			ctx,
			input.filePath,
			"semantic",
			async (operation) => {
				const capability =
					input.scope === "document" ? "documentSymbols" : "workspaceSymbols";
				if (!hasCapability(operation.runtime.session.capabilities, capability))
					throw new ToolError(
						"capability_missing",
						`Use a server that supports ${input.scope} symbols.`,
					);
				const method =
					input.scope === "document"
						? "textDocument/documentSymbol"
						: "workspace/symbol";
				const params =
					input.scope === "document"
						? { textDocument: { uri: operation.uri } }
						: { query: input.query ?? "" };
				const result = await operation.runtime.connection.request<unknown>(
					method,
					params,
					signal,
				);
				if (!result.ok) throwConnectionFailure(result.code);
				const values = Array.isArray(result.value)
					? result.value.slice(0, 1_000)
					: [];
				return bounded(
					values
						.filter(
							(symbol): symbol is Record<string, unknown> =>
								typeof symbol === "object" &&
								symbol !== null &&
								typeof (symbol as { name?: unknown }).name === "string",
						)
						.map((symbol) => ({
							name: symbol.name as string,
							kind: Number.isInteger(symbol.kind) ? (symbol.kind as number) : 0,
							detail: typeof symbol.detail === "string" ? symbol.detail : "",
						}))
						.sort((a, b) => compareText(a.name, b.name)),
					input.limit,
				);
			},
			signal,
		);
		return success({ symbols: value });
	} catch (error) {
		return failure(
			error instanceof ToolError
				? error
				: new ToolError("runtime_failed", "Retry the request."),
		);
	}
}
