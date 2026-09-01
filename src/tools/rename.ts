import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { hasCapability } from "../protocol/capabilities.js";
import { utf16Offset } from "../protocol/documents.js";
import { applyValidatedEdits } from "../edits/apply.js";
import { normalizeWorkspaceEdit } from "../edits/normalize.js";
import { validateWorkspaceEdit } from "../edits/validate.js";
import { failure, success } from "./render.js";
import {
	throwConnectionFailure,
	ToolError,
	type TrustedOperationService,
} from "./shared.js";

export const renameSchema = Type.Object(
	{
		filePath: Type.String({ minLength: 1 }),
		line: Type.Integer({ minimum: 1 }),
		character: Type.Integer({ minimum: 0 }),
		newName: Type.String({ minLength: 1, maxLength: 256 }),
	},
	{ additionalProperties: false },
);
export type RenameInput = Static<typeof renameSchema>;

/** Rename is deliberately direct: a connection failure never retries a mutation request. */
export async function rename(
	service: TrustedOperationService,
	ctx: Parameters<TrustedOperationService["withFile"]>[0],
	input: RenameInput,
	signal: AbortSignal | undefined,
) {
	const newName = input.newName.trim();
	if (!newName)
		return failure(
			new ToolError("invalid_file", "Use a non-whitespace replacement name."),
		);
	try {
		const result = await service.withFile(
			ctx,
			input.filePath,
			"mutation",
			"tool",
			async (operation) => {
				if (
					!hasCapability(
						operation.runtime.session.capabilities,
						"prepareRename",
					) ||
					!hasCapability(operation.runtime.session.capabilities, "rename")
				)
					throw new ToolError(
						"capability_missing",
						"Use a server that supports rename preparation and rename.",
					);
				const document = operation.runtime.session.documents.get(operation.uri);
				if (
					!document ||
					utf16Offset(document.text, input.line - 1, input.character) ===
						undefined
				)
					throw new ToolError("invalid_file", "Use a valid UTF-16 position.");
				const position = { line: input.line - 1, character: input.character };
				const prepared = await operation.runtime.connection.request<unknown>(
					"textDocument/prepareRename",
					{ textDocument: { uri: operation.uri }, position },
					signal,
				);
				if (!prepared.ok) throwConnectionFailure(prepared.code);
				if (prepared.value === null || prepared.value === undefined)
					throw new ToolError("invalid_file", "This symbol cannot be renamed.");
				const response = await operation.runtime.connection.request<unknown>(
					"textDocument/rename",
					{
						textDocument: { uri: operation.uri },
						position,
						newName,
					},
					signal,
				);
				if (!response.ok) throwConnectionFailure(response.code);
				const normalized = normalizeWorkspaceEdit(response.value);
				if (!normalized)
					throw new ToolError(
						"runtime_failed",
						"Server returned an unsafe workspace edit.",
					);
				const validated = await validateWorkspaceEdit(normalized, {
					workspacePath: operation.target.workspacePath,
					versions: new Map([[operation.uri, document.version]]),
					expectedFileHashes: new Map([
						[
							operation.target.filePath,
							createHash("sha256").update(document.text, "utf8").digest("hex"),
						],
					]),
				});
				if (!validated)
					throw new ToolError(
						"invalid_file",
						"Workspace edit failed validation.",
					);
				return applyValidatedEdits(validated, signal ? { signal } : {});
			},
			signal,
		);
		return success({ mutation: result });
	} catch (error) {
		return failure(
			error instanceof ToolError
				? error
				: new ToolError(
						"runtime_failed",
						"Rename failed without applying a retry.",
					),
		);
	}
}
