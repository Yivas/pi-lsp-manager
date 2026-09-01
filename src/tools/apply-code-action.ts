import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { hasCapability } from "../protocol/capabilities.js";
import { applyValidatedEdits } from "../edits/apply.js";
import { normalizeWorkspaceEdit } from "../edits/normalize.js";
import { validateWorkspaceEdit } from "../edits/validate.js";
import {
	actionEdit,
	resolveCodeAction,
	type CodeActionPreviews,
} from "./source-action.js";
import { failure, success } from "./render.js";
import {
	ToolError,
	type ActiveOperation,
	type TrustedOperationService,
} from "./shared.js";

export const applyCodeActionSchema = Type.Object(
	{
		filePath: Type.String({ minLength: 1 }),
		previewId: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);
export type ApplyCodeActionInput = Static<typeof applyCodeActionSchema>;
/** Applies one stored preview inside its already-open, server-pinned operation. */
export async function applyCodeActionInOperation(
	operation: ActiveOperation,
	previews: CodeActionPreviews,
	previewId: string,
	signal: AbortSignal | undefined,
) {
	if (!hasCapability(operation.runtime.session.capabilities, "codeActions"))
		throw new ToolError(
			"capability_missing",
			"Use a server that supports code actions.",
		);
	const document = operation.runtime.session.documents.get(operation.uri);
	if (!document)
		throw new ToolError("invalid_file", "Use a supported regular file.");
	const hash = createHash("sha256").update(document.text).digest("hex");
	let action = previews.take(previewId, {
		hash,
		filePath: operation.target.filePath,
		serverId: operation.server.id,
		session: operation.runtime,
	});
	if (!action)
		throw new ToolError(
			"invalid_file",
			"Code action preview is missing, stale, or belongs to another session.",
		);
	action = await resolveCodeAction(operation, action, signal);
	const normalized = normalizeWorkspaceEdit(actionEdit(action));
	if (!normalized)
		throw new ToolError(
			"invalid_file",
			"Code action returned an unsafe workspace edit.",
		);
	const validated = await validateWorkspaceEdit(normalized, {
		workspacePath: operation.target.workspacePath,
		versions: new Map([[operation.uri, document.version]]),
		expectedFileVersions: new Map([
			[operation.target.filePath, document.version],
		]),
		expectedFileHashes: new Map([[operation.target.filePath, hash]]),
	});
	if (!validated)
		throw new ToolError("invalid_file", "Workspace edit failed validation.");
	return applyValidatedEdits(validated, signal ? { signal } : {});
}

/** Applies exactly the stored preview (or its one allowed resolve result), never re-queries actions. */
export async function applyCodeAction(
	service: TrustedOperationService,
	previews: CodeActionPreviews,
	ctx: Parameters<TrustedOperationService["withFile"]>[0],
	input: ApplyCodeActionInput,
	signal: AbortSignal | undefined,
) {
	try {
		if (!ctx.isProjectTrusted())
			throw new ToolError(
				"untrusted_project",
				"Trust this project before using LSP tools.",
			);
		const storedServerId = previews.serverId(input.previewId);
		if (!storedServerId)
			throw new ToolError(
				"invalid_file",
				"Code action preview is missing, stale, or belongs to another session.",
			);
		const result = await service.withFile(
			ctx,
			input.filePath,
			"mutation",
			"tool",
			(operation) =>
				applyCodeActionInOperation(
					operation,
					previews,
					input.previewId,
					signal,
				),
			signal,
			undefined,
			true,
			undefined,
			storedServerId,
		);
		return success({ mutation: result });
	} catch (error) {
		return failure(
			error instanceof ToolError
				? error
				: new ToolError(
						"runtime_failed",
						"Code action failed without applying a retry.",
					),
		);
	}
}
