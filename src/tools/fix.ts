import { Type, type Static } from "typebox";
import { applyCodeActionInOperation } from "./apply-code-action.js";
import { failure, success } from "./render.js";
import {
	sourceActionsForOperation,
	type CodeActionPreviews,
} from "./source-action.js";
import { ToolError, type TrustedOperationService } from "./shared.js";

const DEFAULT_KIND = "source.fixAll";
const FIX_ACTION_LIMIT = 50;

export const fixSchema = Type.Object(
	{
		filePath: Type.String({ minLength: 1 }),
		kind: Type.Optional(Type.String({ maxLength: 128, default: DEFAULT_KIND })),
		write: Type.Optional(Type.Boolean({ default: false })),
		server: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	},
	{ additionalProperties: false },
);
export type FixInput = Static<typeof fixSchema>;

/** Previews source actions, applying only an unambiguous fresh preview through lsp_apply_code_action. */
export async function fix(
	service: TrustedOperationService,
	previews: CodeActionPreviews,
	ctx: Parameters<TrustedOperationService["read"]>[0],
	input: FixInput,
	signal: AbortSignal | undefined,
) {
	try {
		const result = await service.withFile(
			ctx,
			input.filePath,
			"mutation",
			"tool",
			async (operation) => {
				const codeActions = await sourceActionsForOperation(
					operation,
					previews,
					{
						...input,
						kind: input.kind ?? DEFAULT_KIND,
						limit: FIX_ACTION_LIMIT,
					},
					signal,
				);
				if (!input.write) return { codeActions, previewOnly: true as const };
				if (codeActions.length !== 1)
					return {
						codeActions,
						previewOnly: true as const,
						instructions:
							"Select one preview with lsp_apply_code_action; write applies only one action.",
					};
				const preview = codeActions[0];
				if (!preview)
					throw new ToolError("runtime_failed", "Retry the request.");
				const mutation = await applyCodeActionInOperation(
					operation,
					previews,
					preview.id,
					signal,
				);
				return { mutation };
			},
			signal,
			undefined,
			true,
			undefined,
			input.server,
		);
		return success(result);
	} catch (error) {
		return failure(
			error instanceof ToolError
				? error
				: new ToolError("runtime_failed", "Retry the request."),
		);
	}
}
