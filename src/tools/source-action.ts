import { createHash, randomUUID } from "node:crypto";
import { hasCapability } from "../protocol/capabilities.js";
import type { ConnectionFailure } from "../protocol/connection.js";
import { bounded, compareText, stable } from "./render.js";
import {
	throwConnectionFailure,
	ToolError,
	type ActiveOperation,
	type TrustedOperationService,
} from "./shared.js";

export interface CodeActionPreview {
	id: string;
	title: string;
	kind?: string;
	hash: string;
}

export interface StoredCodeActionPreview {
	hash: string;
	filePath: string;
	serverId: string;
	session?: object;
	action: unknown;
}

/** Session-local preview store; IDs are valid only for their stored runtime snapshot. */
export class CodeActionPreviews {
	private readonly values = new Map<
		string,
		StoredCodeActionPreview & { expiresAt: number }
	>();

	public constructor(
		private readonly ttlMs = 10 * 60_000,
		private readonly maxEntries = 256,
		private readonly now: () => number = Date.now,
	) {}

	private pruneExpired(): void {
		const now = this.now();
		for (const [id, value] of this.values) {
			if (value.expiresAt <= now) this.values.delete(id);
		}
	}

	public put(preview: StoredCodeActionPreview): string {
		this.pruneExpired();
		while (this.values.size >= this.maxEntries) {
			const oldest = this.values.keys().next().value as string | undefined;
			if (!oldest) break;
			this.values.delete(oldest);
		}
		const id = randomUUID();
		this.values.set(id, {
			...preview,
			expiresAt: this.now() + this.ttlMs,
		});
		return id;
	}

	public serverId(id: string): string | undefined {
		this.pruneExpired();
		return this.values.get(id)?.serverId;
	}

	public take(
		id: string,
		expected: Omit<StoredCodeActionPreview, "action">,
	): unknown | undefined {
		this.pruneExpired();
		const value = this.values.get(id);
		if (
			value?.hash !== expected.hash ||
			value.filePath !== expected.filePath ||
			value.serverId !== expected.serverId ||
			value.session !== expected.session
		)
			return undefined;
		this.values.delete(id);
		return value.action;
	}

	public get(
		id: string,
		expected: Omit<StoredCodeActionPreview, "action">,
	): unknown | undefined {
		this.pruneExpired();
		const value = this.values.get(id);
		return value?.hash === expected.hash &&
			value.filePath === expected.filePath &&
			value.serverId === expected.serverId &&
			(expected.session === undefined || value.session === expected.session)
			? value.action
			: undefined;
	}

	public clear(): void {
		this.values.clear();
	}
}

export interface SourceActionInput {
	filePath: string;
	kind?: string;
	limit?: number;
	server?: string;
}

function actionEdit(action: unknown): unknown {
	return typeof action === "object" && action !== null
		? (action as { edit?: unknown }).edit
		: undefined;
}

export async function sourceActionsForOperation(
	operation: ActiveOperation,
	previews: CodeActionPreviews,
	input: SourceActionInput,
	signal: AbortSignal | undefined,
): Promise<CodeActionPreview[]> {
	if (!hasCapability(operation.runtime.session.capabilities, "codeActions"))
		throw new ToolError(
			"capability_missing",
			"Use a server that supports code actions.",
		);
	const document = operation.runtime.session.documents.get(operation.uri);
	if (!document)
		throw new ToolError("invalid_file", "Use a supported regular file.");
	const collected = await operation.runtime.diagnostics.collect(
		operation.uri,
		document.version,
		hasCapability(operation.runtime.session.capabilities, "diagnostics"),
		signal,
		operation.diagnosticGeneration,
	);
	if (
		!collected.ok &&
		["cancelled", "closed", "tainted"].includes(collected.code)
	)
		throwConnectionFailure(collected.code as ConnectionFailure);
	const lines = document.text.split(/\r\n|\n|\r/);
	const lastLine = lines.at(-1) ?? "";
	const result = await operation.runtime.connection.request<unknown>(
		"textDocument/codeAction",
		{
			textDocument: { uri: operation.uri },
			range: {
				start: { line: 0, character: 0 },
				end: { line: lines.length - 1, character: lastLine.length },
			},
			context: {
				diagnostics: collected.ok ? collected.diagnostics : [],
				only: input.kind ? [input.kind] : undefined,
			},
		},
		signal,
	);
	if (!result.ok) throwConnectionFailure(result.code);
	const hash = createHash("sha256").update(document.text).digest("hex");
	const rawActions = Array.isArray(result.value)
		? result.value
				.slice(0, 1_000)
				.filter(
					(action): action is Record<string, unknown> =>
						typeof action === "object" &&
						action !== null &&
						typeof (action as { title?: unknown }).title === "string",
				)
		: [];
	const actions = [
		...stable(rawActions, (action) => JSON.stringify(action)),
	].sort((left, right) =>
		compareText(
			`${left.title as string}:${typeof left.kind === "string" ? left.kind : ""}`,
			`${right.title as string}:${typeof right.kind === "string" ? right.kind : ""}`,
		),
	);
	return bounded(actions, input.limit).map((action) => ({
		id: previews.put({
			hash,
			filePath: operation.target.filePath,
			serverId: operation.server.id,
			session: operation.runtime,
			action,
		}),
		title: action.title as string,
		...(typeof action.kind === "string" ? { kind: action.kind } : {}),
		hash,
	}));
}

/** Collects ordered previews through the selected role without exposing a write path. */
export async function sourceActions(
	service: TrustedOperationService,
	previews: CodeActionPreviews,
	ctx: Parameters<TrustedOperationService["read"]>[0],
	input: SourceActionInput,
	signal: AbortSignal | undefined,
	role: "semantic" | "mutation" = "semantic",
): Promise<CodeActionPreview[]> {
	const work = (operation: ActiveOperation) =>
		sourceActionsForOperation(operation, previews, input, signal);
	return role === "mutation"
		? service.withFile(
				ctx,
				input.filePath,
				"mutation",
				"tool",
				work,
				signal,
				undefined,
				true,
				undefined,
				input.server,
			)
		: service.read(ctx, input.filePath, "semantic", work, signal);
}

/** Resolves a stored action once, before the established edit validator begins mutation. */
export async function resolveCodeAction(
	operation: ActiveOperation,
	action: unknown,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	if (actionEdit(action)) return action;
	if (
		!hasCapability(operation.runtime.session.capabilities, "codeActionResolve")
	)
		throw new ToolError(
			"capability_missing",
			"Code action does not include an edit and cannot be resolved.",
		);
	const resolved = await operation.runtime.connection.request<unknown>(
		"codeAction/resolve",
		action,
		signal,
	);
	if (!resolved.ok) throwConnectionFailure(resolved.code);
	return resolved.value;
}

export { actionEdit };
