import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { VuePackages } from "../install/vue-packages.js";
import type { LspConnection } from "./connection.js";
import type { Diagnostic } from "./diagnostics.js";

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

type Response = { request_seq: number; success: boolean; body?: unknown };
type Position = { line: number; character: number };
type Location = {
	uri: string;
	range: { start: Position; end: Position };
};
type TsSpan = {
	file?: unknown;
	start?: { line?: number; offset?: number };
	end?: { line?: number; offset?: number };
	prefixText?: unknown;
	suffixText?: unknown;
};

function location(value: unknown, rootPath: string): Location | undefined {
	if (!value || typeof value !== "object") return undefined;
	const span = value as TsSpan;
	if (
		typeof span.file !== "string" ||
		!isAbsolute(span.file) ||
		!inside(rootPath, span.file)
	)
		return undefined;
	const start = span.start;
	const end = span.end;
	if (
		!start ||
		!end ||
		typeof start.line !== "number" ||
		typeof start.offset !== "number" ||
		typeof end.line !== "number" ||
		typeof end.offset !== "number" ||
		!Number.isInteger(start.line) ||
		!Number.isInteger(start.offset) ||
		!Number.isInteger(end.line) ||
		!Number.isInteger(end.offset) ||
		start.line < 1 ||
		start.offset < 1 ||
		end.line < 1 ||
		end.offset < 1
	)
		return undefined;
	return {
		uri: pathToFileURL(span.file).href,
		range: {
			start: { line: start.line - 1, character: start.offset - 1 },
			end: { line: end.line - 1, character: end.offset - 1 },
		},
	};
}
type Pending = {
	resolve: (response: Response) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

function inside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return (
		path === "" ||
		(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	);
}

export class VueCrossFileRenameError extends Error {}

export function mapVueRenameEdits(
	rootPath: string,
	sourceFile: string,
	body: unknown,
	newName: string,
): unknown {
	if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName))
		throw new Error("Vue rename requires a TypeScript identifier.");
	const groups = (body as { locs?: unknown } | null)?.locs;
	if (!Array.isArray(groups) || groups.length === 0 || groups.length > 1_000)
		throw new Error("Vue rename locations unavailable.");
	let count = 0;
	const changes: Record<
		string,
		{ range: Location["range"]; newText: string }[]
	> = {};
	for (const entry of groups) {
		const group = entry as { file?: unknown; locs?: unknown } | null;
		if (
			!group ||
			typeof group.file !== "string" ||
			!isAbsolute(group.file) ||
			!inside(rootPath, group.file) ||
			!Array.isArray(group.locs) ||
			group.locs.length === 0
		)
			throw new Error("Vue rename returned an unsafe file.");
		if (relative(sourceFile, group.file) !== "")
			throw new VueCrossFileRenameError(
				"Vue rename across files is not supported yet.",
			);
		const uri = pathToFileURL(group.file).href;
		if (Object.hasOwn(changes, uri))
			throw new Error("Vue rename returned a duplicate file.");
		const edits: { range: Location["range"]; newText: string }[] = [];
		for (const item of group.locs) {
			if (++count > 1_000)
				throw new Error("Vue rename returned too many edits.");
			const span = item as TsSpan | null;
			const mapped = location({ ...span, file: group.file }, rootPath);
			if (
				!mapped ||
				(span?.prefixText !== undefined &&
					typeof span.prefixText !== "string") ||
				(span?.suffixText !== undefined && typeof span.suffixText !== "string")
			)
				throw new Error("Vue rename returned an invalid edit.");
			edits.push({
				range: mapped.range,
				newText: `${span?.prefixText ?? ""}${newName}${span?.suffixText ?? ""}`,
			});
		}
		changes[uri] = edits;
	}
	return { changes };
}

export class VueTsserverBridge {
	private readonly pending = new Map<number, Pending>();
	private readonly opened = new Map<string, string | undefined>();
	private queue: Promise<void> = Promise.resolve();
	private sequence = 0;
	private buffer = Buffer.alloc(0);
	private stopped = false;
	private stopping: Promise<void> | undefined;
	private configured = false;

	private constructor(
		private readonly child: ChildProcess,
		private readonly rootPath: string,
		private readonly connection: LspConnection,
		private readonly onFailure: () => void,
	) {
		child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk));
		child.once("error", () => this.fail());
		child.once("close", () => this.fail());
		connection.onNotification("tsserver/request", (params) => {
			void this.enqueue(() => this.handle(params)).catch(() => this.fail());
		});
	}

	public static start(
		packages: VuePackages,
		rootPath: string,
		connection: LspConnection,
		onFailure: () => void,
	): VueTsserverBridge {
		const child = spawn(
			process.execPath,
			[
				packages.typescriptServer,
				"--globalPlugins",
				"@vue/typescript-plugin",
				"--pluginProbeLocations",
				packages.pluginRoot,
			],
			{
				cwd: rootPath,
				env: {
					PATH: process.env.PATH,
					...(process.platform === "win32"
						? {
								SystemRoot: process.env.SystemRoot,
								ComSpec: process.env.ComSpec,
							}
						: {}),
					HOME: process.env.HOME,
					TEMP: process.env.TEMP,
				},
				shell: false,
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "ignore"],
			},
		);
		return new VueTsserverBridge(child, rootPath, connection, onFailure);
	}

	private receive(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const end = this.buffer.indexOf("\r\n\r\n");
			if (end < 0) break;
			if (end > 256) {
				this.fail();
				return;
			}
			const length = Number(
				this.buffer
					.subarray(0, end)
					.toString("ascii")
					.match(/Content-Length: (\d+)/i)?.[1],
			);
			if (
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length > MAX_MESSAGE_BYTES
			) {
				this.fail();
				return;
			}
			if (this.buffer.length < end + 4 + length) break;
			const frame = this.buffer.subarray(end + 4, end + 4 + length);
			this.buffer = this.buffer.subarray(end + 4 + length);
			let message: {
				type?: string;
				request_seq?: number;
				success?: boolean;
				body?: unknown;
			};
			try {
				message = JSON.parse(frame.toString("utf8"));
			} catch {
				this.fail();
				return;
			}
			if (message.type !== "response" || !Number.isInteger(message.request_seq))
				continue;
			const pending = this.pending.get(message.request_seq as number);
			if (!pending) continue;
			clearTimeout(pending.timer);
			this.pending.delete(message.request_seq as number);
			pending.resolve(message as Response);
		}
		if (this.buffer.length > MAX_MESSAGE_BYTES + 256) this.fail();
	}

	private request(command: string, args: unknown): Promise<Response> {
		if (this.stopped) return Promise.reject(new Error("Vue tsserver stopped."));
		return new Promise((resolve, reject) => {
			const seq = ++this.sequence;
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				reject(new Error("Vue tsserver timed out."));
				this.fail();
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(seq, { resolve, reject, timer });
			const message = JSON.stringify({
				seq,
				type: "request",
				command,
				arguments: args,
			});
			if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
				this.fail();
				return;
			}
			this.child.stdin?.write(`${message}\n`, (error) => {
				if (error) this.fail();
			});
		});
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const result = this.queue.then(work);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async cancellable<T>(
		signal: AbortSignal | undefined,
		work: () => Promise<T>,
	): Promise<T> {
		if (signal?.aborted) {
			this.fail();
			throw new Error("Vue tsserver request cancelled.");
		}
		const abort = () => this.fail();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			if (signal?.aborted) throw new Error("Vue tsserver request cancelled.");
			return await work();
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	private async open(file: string, text?: string): Promise<void> {
		if (!isAbsolute(file) || !inside(this.rootPath, file))
			throw new Error("Vue file is outside the workspace.");
		if (!this.configured) {
			const result = await this.request("configure", {
				extraFileExtensions: [
					{ extension: ".vue", isMixedContent: true, scriptKind: 7 },
				],
			});
			if (!result.success)
				throw new Error("Vue tsserver configuration failed.");
			this.configured = true;
		}
		const hash =
			text === undefined
				? undefined
				: createHash("sha256").update(text).digest("hex");
		if (
			this.opened.has(file) &&
			(text === undefined || this.opened.get(file) === hash)
		)
			return;
		const opened = await this.request("open", {
			file,
			...(text === undefined ? {} : { fileContent: text }),
		});
		if (!opened.success)
			throw new Error("Vue tsserver could not open document.");
		this.opened.set(file, hash);
	}

	public diagnostics(
		file: string,
		text: string,
		signal?: AbortSignal,
	): Promise<readonly Diagnostic[]> {
		return this.cancellable(signal, () =>
			this.enqueue(async () => {
				await this.open(file, text);
				const values: Diagnostic[] = [];
				for (const command of [
					"syntacticDiagnosticsSync",
					"semanticDiagnosticsSync",
				]) {
					const response = await this.request(command, { file });
					if (!response.success || !Array.isArray(response.body))
						throw new Error("Vue tsserver diagnostics unavailable.");
					for (const item of response.body) {
						const diagnostic = item as {
							start?: { line?: number; offset?: number };
							end?: { line?: number; offset?: number };
							text?: string;
							category?: string;
							code?: number;
						};
						if (
							!Number.isInteger(diagnostic.start?.line) ||
							!Number.isInteger(diagnostic.end?.line) ||
							!Number.isInteger(diagnostic.start?.offset) ||
							!Number.isInteger(diagnostic.end?.offset) ||
							!diagnostic.start?.line ||
							!diagnostic.end?.line ||
							!diagnostic.start?.offset ||
							!diagnostic.end?.offset ||
							typeof diagnostic.text !== "string"
						)
							continue;
						values.push({
							range: {
								start: {
									line: diagnostic.start.line - 1,
									character: diagnostic.start.offset - 1,
								},
								end: {
									line: diagnostic.end.line - 1,
									character: diagnostic.end.offset - 1,
								},
							},
							message: diagnostic.text.slice(0, 4_096),
							severity: diagnostic.category === "error" ? 1 : 2,
							...(Number.isInteger(diagnostic.code)
								? { code: diagnostic.code }
								: {}),
							source: "typescript",
						});
					}
				}
				return values.slice(0, 100);
			}),
		);
	}

	private query(
		file: string,
		text: string,
		command: string,
		position: Position,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.cancellable(signal, () =>
			this.enqueue(async () => {
				await this.open(file, text);
				const result = await this.request(command, {
					file,
					line: position.line + 1,
					offset: position.character + 1,
					...(command === "rename"
						? { findInStrings: false, findInComments: false }
						: {}),
				});
				if (!result.success)
					throw new Error("Vue tsserver semantic request failed.");
				return result.body;
			}),
		);
	}

	public async definition(
		file: string,
		text: string,
		position: Position,
		signal?: AbortSignal,
	): Promise<readonly Location[]> {
		const body = await this.query(file, text, "definition", position, signal);
		if (!Array.isArray(body))
			throw new Error("Vue tsserver definition unavailable.");
		return body
			.slice(0, 1_000)
			.map((item) => location(item, this.rootPath))
			.filter((item): item is Location => Boolean(item));
	}

	public async references(
		file: string,
		text: string,
		position: Position,
		includeDeclaration: boolean,
		signal?: AbortSignal,
	): Promise<readonly Location[]> {
		const body = (await this.query(
			file,
			text,
			"references",
			position,
			signal,
		)) as { refs?: unknown } | undefined;
		if (!body || !Array.isArray(body.refs))
			throw new Error("Vue tsserver references unavailable.");
		let found = body.refs
			.slice(0, 1_000)
			.map((item) => location(item, this.rootPath))
			.filter((item): item is Location => Boolean(item));
		if (!includeDeclaration && found.length > 0) {
			const definitions = await this.definition(file, text, position, signal);
			const keys = new Set(
				definitions.map(
					(item) =>
						`${item.uri}:${item.range.start.line}:${item.range.start.character}`,
				),
			);
			found = found.filter(
				(item) =>
					!keys.has(
						`${item.uri}:${item.range.start.line}:${item.range.start.character}`,
					),
			);
		}
		return found;
	}

	public async rename(
		file: string,
		text: string,
		position: Position,
		newName: string,
		signal?: AbortSignal,
	): Promise<{
		range: Location["range"];
		edit?: unknown;
	} | null> {
		const body = (await this.query(file, text, "rename", position, signal)) as
			| {
					info?: { canRename?: unknown; triggerSpan?: TsSpan };
					locs?: unknown;
			  }
			| undefined;
		if (body?.info?.canRename !== true) return null;
		const trigger = location({ ...body.info.triggerSpan, file }, this.rootPath);
		if (!trigger) throw new Error("Vue rename preparation is invalid.");
		return {
			range: trigger.range,
			...(newName
				? { edit: mapVueRenameEdits(this.rootPath, file, body, newName) }
				: {}),
		};
	}

	private async handle(params: unknown): Promise<void> {
		if (!Array.isArray(params) || params.length !== 3)
			throw new Error("Invalid Vue request.");
		const [id, command, args] = params;
		if (
			!Number.isSafeInteger(id) ||
			typeof command !== "string" ||
			!/^_vue:[A-Za-z]+(?:-full)?$/.test(command)
		)
			throw new Error("Invalid Vue command.");
		const file =
			typeof args === "object" && args !== null && "file" in args
				? (args as { file?: unknown }).file
				: Array.isArray(args)
					? args[0]
					: undefined;
		if (typeof file === "string") await this.open(file);
		const response = await this.request(command, args);
		if (!response.success) throw new Error("Vue tsserver rejected request.");
		await this.connection.notify("tsserver/response", [
			id,
			response.body ?? null,
		]);
	}

	private fail(): void {
		if (this.stopped) return;
		this.stopped = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Vue tsserver stopped."));
		}
		this.pending.clear();
		void this.stop();
		this.onFailure();
	}

	public stop(): Promise<void> {
		this.stopping ??= this.stopOnce();
		return this.stopping;
	}

	private async stopOnce(): Promise<void> {
		this.stopped = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Vue tsserver stopped."));
		}
		this.pending.clear();
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		const closed = new Promise<void>((resolve) => {
			this.child.once("close", () => resolve());
			this.child.once("error", () => resolve());
		});
		if (process.platform === "win32" && this.child.pid) {
			const killer = spawn(
				"taskkill",
				["/pid", String(this.child.pid), "/t", "/f"],
				{
					shell: false,
					windowsHide: true,
				},
			);
			await Promise.race([
				closed,
				new Promise<void>((resolve) => {
					killer.once("close", () => resolve());
					killer.once("error", () => resolve());
				}),
			]);
		} else {
			try {
				if (this.child.pid) process.kill(-this.child.pid, "SIGTERM");
			} catch {
				this.child.kill("SIGTERM");
			}
		}
		await Promise.race([
			closed,
			new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
		]);
		if (this.child.exitCode === null && this.child.signalCode === null) {
			this.child.kill("SIGKILL");
			await Promise.race([
				closed,
				new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
			]);
		}
	}
}
