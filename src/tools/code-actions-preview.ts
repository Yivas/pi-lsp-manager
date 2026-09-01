import { Type, type Static } from "typebox";
import { failure, success } from "./render.js";
import { sourceActions, type CodeActionPreviews } from "./source-action.js";
import { ToolError, type TrustedOperationService } from "./shared.js";

export const codeActionsSchema = Type.Object(
	{
		filePath: Type.String({ minLength: 1 }),
		kind: Type.Optional(Type.String({ maxLength: 128 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
	},
	{ additionalProperties: false },
);
export type CodeActionsInput = Static<typeof codeActionsSchema>;
export {
	CodeActionPreviews,
	type CodeActionPreview,
	type StoredCodeActionPreview,
} from "./source-action.js";

export async function codeActions(
	service: TrustedOperationService,
	previews: CodeActionPreviews,
	ctx: Parameters<TrustedOperationService["read"]>[0],
	input: CodeActionsInput,
	signal: AbortSignal | undefined,
) {
	try {
		const value = await sourceActions(service, previews, ctx, input, signal);
		return success({ codeActions: value, previewOnly: true });
	} catch (error) {
		return failure(
			error instanceof ToolError
				? error
				: new ToolError("runtime_failed", "Retry the request."),
		);
	}
}
