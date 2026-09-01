import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { hasCapability } from "../protocol/capabilities.js";
import type { Diagnostic } from "../protocol/diagnostics.js";
import { compareText, failure, stable, success } from "./render.js";
import type { InstallOrigin } from "../install/policy.js";
import {
	throwConnectionFailure,
	ToolError,
	type TrustedOperationService,
} from "./shared.js";

export const diagnosticsSchema = Type.Object(
	{
		filePath: Type.String({ minLength: 1 }),
		severity: Type.Optional(
			StringEnum(["error", "warning", "information", "hint"] as const),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	},
	{ additionalProperties: false },
);
export type DiagnosticsInput = Static<typeof diagnosticsSchema>;
const severity = { error: 1, warning: 2, information: 3, hint: 4 } as const;
function isDiagnostic(value: unknown): value is Diagnostic {
	const diagnostic = value as Partial<Diagnostic> | null;
	const start = diagnostic?.range?.start;
	const end = diagnostic?.range?.end;
	return (
		diagnostic !== null &&
		typeof diagnostic?.message === "string" &&
		(diagnostic.severity === undefined ||
			(Number.isInteger(diagnostic.severity) &&
				diagnostic.severity >= 1 &&
				diagnostic.severity <= 4)) &&
		(diagnostic.source === undefined ||
			typeof diagnostic.source === "string") &&
		(diagnostic.code === undefined ||
			typeof diagnostic.code === "string" ||
			(typeof diagnostic.code === "number" &&
				Number.isFinite(diagnostic.code))) &&
		Number.isInteger(start?.line) &&
		Number.isInteger(start?.character) &&
		Number.isInteger(end?.line) &&
		Number.isInteger(end?.character) &&
		(start?.line ?? -1) >= 0 &&
		(start?.character ?? -1) >= 0 &&
		(end?.line ?? -1) >= 0 &&
		(end?.character ?? -1) >= 0
	);
}

export async function diagnostics(
	service: TrustedOperationService,
	ctx: Parameters<TrustedOperationService["read"]>[0],
	input: DiagnosticsInput,
	signal: AbortSignal | undefined,
	origin: Extract<InstallOrigin, "tool" | "post-edit"> = "tool",
) {
	try {
		const values = await service.readDiagnostics(
			ctx,
			input.filePath,
			async (operation) => {
				const document = operation.runtime.session.documents.get(operation.uri);
				if (!document)
					throw new ToolError("invalid_file", "Use a supported regular file.");
				const result = await operation.runtime.diagnostics.collect(
					operation.uri,
					document.version,
					hasCapability(operation.runtime.session.capabilities, "diagnostics"),
					signal,
					operation.diagnosticGeneration,
				);
				if (!result.ok) {
					if (
						[
							"cancelled",
							"timed_out",
							"tainted",
							"closed",
							"request_failed",
						].includes(result.code)
					)
						throwConnectionFailure(
							result.code as Parameters<typeof throwConnectionFailure>[0],
						);
					throw new ToolError("runtime_failed", "Retry the request.");
				}
				const normalized = stable(
					result.diagnostics.slice(0, 100).filter(isDiagnostic),
					(item) =>
						`${item.range.start.line}:${item.range.start.character}:${item.range.end.line}:${item.range.end.character}:${item.severity ?? 0}:${item.code ?? ""}:${item.message}`,
				).filter(
					(item) =>
						!input.severity ||
						item.severity === severity[input.severity as keyof typeof severity],
				);
				return normalized.map((item: Diagnostic) => ({
					line: item.range.start.line + 1,
					character: item.range.start.character,
					endLine: item.range.end.line + 1,
					endCharacter: item.range.end.character,
					severity: item.severity ?? 3,
					code: item.code,
					message: item.message,
					source: item.source,
				}));
			},
			signal,
			origin,
		);
		const seen = new Set<string>();
		const value = values
			.flatMap(({ serverId, value: diagnostics }) =>
				diagnostics.map((diagnostic) => ({ ...diagnostic, serverId })),
			)
			.filter((diagnostic) => {
				const key = `${diagnostic.line}:${diagnostic.character}:${diagnostic.endLine}:${diagnostic.endCharacter}:${diagnostic.severity}:${diagnostic.code ?? ""}:${diagnostic.message}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.sort(
				(left, right) =>
					left.line - right.line ||
					left.character - right.character ||
					compareText(left.serverId, right.serverId),
			)
			.slice(0, input.limit ?? 100);
		return success({ diagnostics: value });
	} catch (error) {
		return failure(
			error instanceof ToolError
				? error
				: new ToolError("runtime_failed", "Retry the request."),
		);
	}
}
