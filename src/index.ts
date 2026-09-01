import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InstallCoordinator } from "./install/coordinator.js";
import { NodePackageManager } from "./install/npm.js";
import { createNodeInstallationVerifier } from "./install/verify.js";
import { RuntimePool } from "./runtime/pool.js";
import { RuntimeReaper } from "./runtime/reaper.js";
import { type CommandActivity, registerLspCommand } from "./commands/lsp.js";
import {
	codeActions,
	CodeActionPreviews,
	codeActionsSchema,
} from "./tools/code-actions-preview.js";
import { definition, definitionSchema } from "./tools/definition.js";
import { diagnostics, diagnosticsSchema } from "./tools/diagnostics.js";
import { createPostEditHandler } from "./tools/post-edit.js";
import { prepareRename, prepareRenameSchema } from "./tools/prepare-rename.js";
import { references, referencesSchema } from "./tools/references.js";
import { TrustedOperationService } from "./tools/shared.js";
import { status, statusSchema } from "./tools/status.js";
import { symbols, symbolsSchema } from "./tools/symbols.js";

let coordinator: InstallCoordinator | undefined;
let runtimePool: RuntimePool | undefined;
let runtimeReaper: RuntimeReaper | undefined;

export function getInstallCoordinator(): InstallCoordinator | undefined {
	return coordinator;
}
export function registerInstallCoordinator(
	value: InstallCoordinator | undefined,
): void {
	coordinator = value;
}
export function getRuntimePool(): RuntimePool | undefined {
	return runtimePool;
}
export function registerRuntimePool(value: RuntimePool | undefined): void {
	runtimePool = value;
}

export function createShutdownHandler(
	activity: CommandActivity = {
		controllers: new Set<AbortController>(),
		pending: new Set<Promise<void>>(),
	},
	cleanup?: () => void,
): (_event?: unknown) => Promise<void> {
	let shutdown: Promise<void> | undefined;
	return () => {
		shutdown ??= (async () => {
			for (const controller of activity.controllers) controller.abort();
			cleanup?.();
			const active = coordinator;
			const pool = runtimePool;
			const reaper = runtimeReaper;
			coordinator = undefined;
			runtimePool = undefined;
			runtimeReaper = undefined;
			await Promise.all([
				active?.shutdown(),
				reaper?.stop(),
				pool?.shutdown(),
				Promise.allSettled([...activity.pending]),
			]);
		})();
		return shutdown;
	};
}

export default function registerExtension(pi: ExtensionAPI): void {
	coordinator = new InstallCoordinator({
		packageManager: new NodePackageManager(),
		verifier: createNodeInstallationVerifier(),
	});
	runtimePool = new RuntimePool({ onActive: () => runtimeReaper?.start() });
	runtimeReaper = new RuntimeReaper(runtimePool);
	const service = new TrustedOperationService({
		coordinator: getInstallCoordinator,
		pool: getRuntimePool,
	});
	const previews = new CodeActionPreviews();
	const activity: CommandActivity = {
		controllers: new Set<AbortController>(),
		pending: new Set<Promise<void>>(),
	};
	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP diagnostics",
		description: "Read diagnostics for one supported file.",
		parameters: diagnosticsSchema,
		execute: (_id, input, signal, _update, ctx) =>
			diagnostics(service, ctx, input, signal),
	});
	pi.registerTool({
		name: "lsp_definition",
		label: "LSP definition",
		description: "Find definitions at a file position.",
		parameters: definitionSchema,
		execute: (_id, input, signal, _update, ctx) =>
			definition(service, ctx, input, signal),
	});
	pi.registerTool({
		name: "lsp_references",
		label: "LSP references",
		description: "Find references at a file position.",
		parameters: referencesSchema,
		execute: (_id, input, signal, _update, ctx) =>
			references(service, ctx, input, signal),
	});
	pi.registerTool({
		name: "lsp_symbols",
		label: "LSP symbols",
		description: "Read document or workspace symbols.",
		parameters: symbolsSchema,
		execute: (_id, input, signal, _update, ctx) =>
			symbols(service, ctx, input, signal),
	});
	pi.registerTool({
		name: "lsp_prepare_rename",
		label: "LSP prepare rename",
		description: "Preview whether a symbol can be renamed.",
		parameters: prepareRenameSchema,
		execute: (_id, input, signal, _update, ctx) =>
			prepareRename(service, ctx, input, signal),
	});
	pi.registerTool({
		name: "lsp_code_actions",
		label: "LSP code actions",
		description: "Preview code actions without applying edits.",
		parameters: codeActionsSchema,
		execute: (_id, input, signal, _update, ctx) =>
			codeActions(service, previews, ctx, input, signal),
	});
	pi.registerTool({
		name: "lsp_status",
		label: "LSP status",
		description: "Read structured LSP policy and status.",
		parameters: statusSchema,
		execute: (_id, _input, signal, _update, ctx) =>
			status(service, ctx, signal),
	});
	pi.on("tool_result", createPostEditHandler(service));
	registerLspCommand(pi, service, activity);
	pi.on(
		"session_shutdown",
		createShutdownHandler(activity, () => previews.clear()),
	);
}
