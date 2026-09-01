import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { hasCapability } from "../protocol/capabilities.js";
import type { Diagnostic } from "../protocol/diagnostics.js";
import { compareText, failure, stable, success } from "./render.js";
import type { InstallOrigin } from "../install/policy.js";
import {
	throwConnectionFailure,
	ToolError,
	type ActiveOperation,
	type TrustedOperationService,
} from "./shared.js";

export const diagnosticsSchema = Type.Object(
	{
		filePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
		paths: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
				minItems: 1,
				maxItems: 32,
			}),
		),
		servers: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
				minItems: 1,
				maxItems: 32,
			}),
		),
		fileLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		severity: Type.Optional(
			StringEnum(["error", "warning", "information", "hint"] as const),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	},
	{ additionalProperties: false },
);
export type DiagnosticsInput = Static<typeof diagnosticsSchema>;
const severity = { error: 1, warning: 2, information: 3, hint: 4 } as const;
type DiagnosticSeverity = keyof typeof severity;

function validBatchInput(input: DiagnosticsInput): boolean {
	return (
		(input.filePath === undefined ||
			(typeof input.filePath === "string" &&
				input.filePath.length > 0 &&
				input.filePath.length <= 4_096)) &&
		(input.paths === undefined ||
			(Array.isArray(input.paths) &&
				input.paths.length > 0 &&
				input.paths.length <= 32 &&
				input.paths.every(
					(path) =>
						typeof path === "string" && path.length > 0 && path.length <= 4_096,
				))) &&
		(input.servers === undefined ||
			(Array.isArray(input.servers) &&
				input.servers.length > 0 &&
				input.servers.length <= 32 &&
				input.servers.every(
					(server) => typeof server === "string" && server.length <= 256,
				))) &&
		(input.fileLimit === undefined ||
			(Number.isInteger(input.fileLimit) &&
				input.fileLimit >= 1 &&
				input.fileLimit <= 100)) &&
		(input.limit === undefined ||
			(Number.isInteger(input.limit) &&
				input.limit >= 1 &&
				input.limit <= 100)) &&
		(input.severity === undefined ||
			(typeof input.severity === "string" &&
				Object.hasOwn(severity, input.severity))) &&
		!(input.filePath !== undefined && input.paths !== undefined)
	);
}
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

async function collectDiagnostics(
	operation: ActiveOperation,
	requestedSeverity: DiagnosticsInput["severity"],
	signal: AbortSignal | undefined,
) {
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
		if (result.code === "diagnostics_timed_out")
			throw new ToolError(
				"diagnostics_timed_out",
				"Retry after the language server finishes analyzing the file.",
			);
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
		result.diagnostics.filter(isDiagnostic),
		(item) =>
			`${item.range.start.line}:${item.range.start.character}:${item.range.end.line}:${item.range.end.character}:${item.severity ?? 0}:${item.code ?? ""}:${item.message}`,
	)
		.filter(
			(item) =>
				!requestedSeverity ||
				item.severity === severity[requestedSeverity as DiagnosticSeverity],
		)
		.sort(
			(left, right) =>
				left.range.start.line - right.range.start.line ||
				left.range.start.character - right.range.start.character ||
				left.range.end.line - right.range.end.line ||
				left.range.end.character - right.range.end.character ||
				(left.message < right.message
					? -1
					: left.message > right.message
						? 1
						: 0),
		)
		.slice(0, 100);
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
}

export async function diagnostics(
	service: TrustedOperationService,
	ctx: Parameters<TrustedOperationService["read"]>[0],
	input: DiagnosticsInput,
	signal: AbortSignal | undefined,
	origin: Extract<InstallOrigin, "tool" | "post-edit"> = "tool",
) {
	try {
		if (!validBatchInput(input))
			throw new ToolError(
				"invalid_input",
				"Use one filePath or a list of paths.",
			);
		const isLegacyRequest =
			input.filePath !== undefined &&
			input.paths === undefined &&
			input.servers === undefined &&
			input.fileLimit === undefined;
		if (!isLegacyRequest) {
			const batch = await service.readDiagnosticsBatch(
				ctx,
				input.filePath ? [input.filePath] : input.paths,
				input.servers,
				(operation) => collectDiagnostics(operation, input.severity, signal),
				input.fileLimit ?? 100,
				signal,
			);
			const limit = input.limit ?? 100;
			let remaining = limit;
			let outputTruncated = false;
			const files = batch.files.map((file) => ({
				path: file.path,
				servers: file.servers.map(({ serverId, value }) => {
					const diagnostics = value.slice(0, remaining);
					if (value.length > diagnostics.length) outputTruncated = true;
					remaining -= diagnostics.length;
					return { serverId, diagnostics };
				}),
			}));
			return success({
				filesScanned: batch.filesScanned,
				filesChecked: new Set(batch.files.map((file) => file.path)).size,
				serversUsed: batch.serversUsed,
				truncated: batch.truncated || outputTruncated,
				omissions: batch.omissions,
				failures: batch.failures,
				files,
			});
		}
		const values = await service.readDiagnostics(
			ctx,
			input.filePath as string,
			(operation) => collectDiagnostics(operation, input.severity, signal),
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
