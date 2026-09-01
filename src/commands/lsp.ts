import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { LspActivity } from "../host/activity.js";
import { ToolError, type TrustedOperationService } from "../tools/shared.js";

function notify(
	ctx: ExtensionCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc"))
		ctx.ui.notify(message, type);
}

export interface CommandActivity {
	controllers: Set<AbortController>;
	pending: Set<Promise<void>>;
	indicator?: LspActivity;
}

function formatStatus(
	snapshot: Awaited<ReturnType<TrustedOperationService["statusSnapshot"]>>,
): string {
	const servers = snapshot.servers.map((server) => {
		const extensions = server.extensions.join(",") || "none";
		const roles = server.roles.join(",") || "none";
		return `${server.id} enabled=${server.enabled} priority=${server.priority} available=${server.available} admission=${server.admission} roles=${roles} extensions=${extensions} route=${server.routeConfigured} recipe=${server.recipePresent} installable=${server.installable} runtime=${server.runtime}`;
	});
	return `LSP status: network ${snapshot.loaded.config.network}; ${servers.join("; ") || "no servers configured"}.`;
}

let nextCommandOperation = 0;

/** Slash command is intentionally closed over the approved catalogue/configuration only. */
export function registerLspCommand(
	pi: ExtensionAPI,
	service: TrustedOperationService,
	activity: CommandActivity,
): void {
	pi.registerCommand("lsp", {
		description:
			"Show LSP status, policy, installation state, or warm a server.",
		handler: async (raw, ctx) => {
			if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
			const args = raw.trim() ? raw.trim().split(/\s+/) : [];
			const [mode = "status", id, ...extra] = args;
			if (
				!["status", "policy", "install", "warmup", "audit"].includes(mode) ||
				extra.length > 0 ||
				((mode === "install" || mode === "warmup") && !id) ||
				((mode === "status" || mode === "policy" || mode === "audit") && id)
			) {
				notify(
					ctx,
					"Usage: /lsp status|policy|install <id>|warmup <id>|audit",
					"warning",
				);
				return;
			}
			if (mode === "warmup" && !ctx.isProjectTrusted()) {
				notify(
					ctx,
					"Trust this project before warming an LSP server.",
					"warning",
				);
				return;
			}
			const serverId = id ?? "";
			const controller = new AbortController();
			const operationId = `command-${++nextCommandOperation}`;
			activity.indicator?.start(operationId, ctx);
			activity.controllers.add(controller);
			const operation = (async () => {
				try {
					if (mode === "status" || mode === "policy") {
						const snapshot = await service.statusSnapshot(
							ctx,
							!ctx.isProjectTrusted(),
							controller.signal,
						);
						if (mode === "status") {
							notify(ctx, formatStatus(snapshot));
						} else {
							notify(
								ctx,
								`LSP policy: network ${snapshot.loaded.config.network}; auto-install ${snapshot.loaded.config.autoInstall ? "on" : "off"}; post-edit diagnostics ${snapshot.loaded.config.postEditDiagnostics ? "on" : "off"}.`,
							);
						}
						return;
					}
					if (mode === "audit") {
						const audit = await service.auditSnapshot(ctx, controller.signal);
						notify(
							ctx,
							`LSP audit: ${audit.records} recent records${audit.lastResult ? `; last result ${audit.lastResult}` : ""}.`,
						);
						return;
					}
					if (mode === "warmup") {
						await service.warmup(ctx, serverId, controller.signal);
						notify(ctx, "LSP server is warm.");
						return;
					}
					await service.explicitInstall(ctx, serverId, controller.signal);
					notify(ctx, "LSP server is ready.");
				} catch (error) {
					const message =
						error instanceof ToolError ? error.action : "LSP request failed.";
					notify(ctx, message, "warning");
				} finally {
					activity.controllers.delete(controller);
					activity.indicator?.end(operationId, ctx);
				}
			})();
			activity.pending.add(operation);
			try {
				await operation;
			} finally {
				activity.pending.delete(operation);
			}
		},
	});
}
