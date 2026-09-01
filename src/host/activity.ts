import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const LSP_ACTIVITY_STATUS_KEY = "pi-lsp-manager";
const LSP_ACTIVITY_STATUS = "LSP working";

/** Tracks LSP work without retaining tool arguments or other request details. */
export class LspActivity {
	private readonly operations = new Set<string>();
	private statusContext: ExtensionContext | undefined;

	public start(operationId: string, ctx: ExtensionContext): void {
		if (this.operations.has(operationId)) return;
		this.operations.add(operationId);
		if (ctx.hasUI && !this.statusContext) {
			this.statusContext = ctx;
			ctx.ui.setStatus(LSP_ACTIVITY_STATUS_KEY, LSP_ACTIVITY_STATUS);
		}
	}

	public end(operationId: string, ctx?: ExtensionContext): void {
		if (!this.operations.delete(operationId)) return;
		if (this.operations.size !== 0) return;
		const statusContext = this.statusContext ?? ctx;
		this.statusContext = undefined;
		if (statusContext?.hasUI)
			statusContext.ui.setStatus(LSP_ACTIVITY_STATUS_KEY, undefined);
	}

	public clear(ctx?: ExtensionContext): void {
		this.operations.clear();
		const statusContext = this.statusContext ?? ctx;
		this.statusContext = undefined;
		if (statusContext?.hasUI)
			statusContext.ui.setStatus(LSP_ACTIVITY_STATUS_KEY, undefined);
	}

	public get activeCount(): number {
		return this.operations.size;
	}
}

export function isLspTool(toolName: string): boolean {
	return toolName.startsWith("lsp_");
}
