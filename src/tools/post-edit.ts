import {
	isEditToolResult,
	isWriteToolResult,
	type ExtensionContext,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { resolveFile } from "../resolve/file.js";
import { diagnostics } from "./diagnostics.js";
import type { TrustedOperationService } from "./shared.js";

/** Adds best-effort diagnostics only after Pi confirms an edit/write succeeded. */
export function createPostEditHandler(service: TrustedOperationService) {
	return async (event: ToolResultEvent, ctx: ExtensionContext) => {
		if (
			event.isError ||
			(!isEditToolResult(event) && !isWriteToolResult(event))
		)
			return;
		const path = event.input.path;
		if (
			typeof path !== "string" ||
			path.length === 0 ||
			!ctx.isProjectTrusted()
		)
			return;
		try {
			const loaded = await service.config(ctx);
			if (!loaded.config.postEditDiagnostics) return;
			const resolved = await resolveFile(ctx.cwd, path, loaded.config.servers);
			if (!resolved.ok) return;
			const result = await diagnostics(
				service,
				ctx,
				{ filePath: path, limit: 20 },
				ctx.signal,
				"post-edit",
			);
			if (result.details?.code !== "ok") return;
			const text = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			return {
				content: [
					...event.content,
					{ type: "text" as const, text: `LSP diagnostics: ${text}` },
				],
				isError: false,
			};
		} catch {
			// Mutation output is authoritative: a post-edit race never changes it.
			return;
		}
	};
}
