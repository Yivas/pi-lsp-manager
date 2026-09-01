import { Type } from "typebox";
import { compareText, failure, success } from "./render.js";
import { ToolError, type TrustedOperationService } from "./shared.js";
export const statusSchema = Type.Object({}, { additionalProperties: false });
export async function status(
	service: TrustedOperationService,
	ctx: Parameters<TrustedOperationService["config"]>[0],
	signal = ctx.signal,
) {
	try {
		const trusted = ctx.isProjectTrusted();
		const snapshot = await service.statusSnapshot(ctx, !trusted, signal);
		return success({
			trusted,
			network: snapshot.loaded.config.network,
			autoInstall: snapshot.loaded.config.autoInstall,
			postEditDiagnostics: snapshot.loaded.config.postEditDiagnostics,
			servers: [...snapshot.servers].sort((left, right) =>
				compareText(left.id, right.id),
			),
			...(trusted
				? {}
				: { action: "Trust this project before using LSP tools." }),
		});
	} catch (error) {
		return failure(
			error instanceof ToolError
				? error
				: new ToolError("runtime_failed", "Restart Pi and retry."),
		);
	}
}
