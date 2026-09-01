import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	EffectiveServerConfig,
	ResolvedTarget,
	SelectionRole,
} from "../contracts.js";
import { loadConfig, type LoadedConfig } from "../config/load.js";
import { createServerLaunch } from "../install/launch.js";
import {
	evaluateInstallPolicy,
	type InstallOrigin,
} from "../install/policy.js";
import { resolveExecutable } from "../install/executable.js";
import type {
	InstallCoordinator,
	InstallResult,
} from "../install/coordinator.js";
import { getRecipe } from "../install/catalog.js";
import type { ConnectionFailure } from "../protocol/connection.js";
import { NodeLspRuntimeSession } from "../protocol/process.js";
import { resolveFile } from "../resolve/file.js";
import { resolveRoot } from "../resolve/root.js";
import { selectServers } from "../resolve/server.js";
import type { PoolEntry, RuntimePool } from "../runtime/pool.js";
import { TransientRuntimeError, retryOnce } from "../runtime/retry.js";

export type ToolErrorCode =
	| "untrusted_project"
	| "invalid_file"
	| "server_unavailable"
	| "server_disabled"
	| "capability_missing"
	| "cancelled"
	| "diagnostics_timed_out"
	| "runtime_failed";

export class ToolError extends Error {
	public constructor(
		public readonly code: ToolErrorCode,
		public readonly action: string,
	) {
		super(code);
	}
}

export function throwConnectionFailure(code: ConnectionFailure): never {
	if (code === "closed" || code === "tainted")
		throw new TransientRuntimeError(`LSP transport ${code}.`);
	throw new ToolError(
		code === "cancelled" ? "cancelled" : "runtime_failed",
		"Retry the request.",
	);
}

export interface ActiveOperation {
	target: ResolvedTarget;
	server: EffectiveServerConfig;
	runtime: NodeLspRuntimeSession;
	entry: PoolEntry;
	uri: string;
	diagnosticGeneration: number;
}

export interface ToolServiceOptions {
	coordinator: () => InstallCoordinator | undefined;
	pool: () => RuntimePool | undefined;
	load?: typeof loadConfig;
	readText?: (path: string) => Promise<string>;
	resolveCommand?: typeof resolveExecutable;
	start?: typeof NodeLspRuntimeSession.start;
	platform?: NodeJS.Platform;
}

function errorForFile(code: string): ToolError {
	return new ToolError(
		"invalid_file",
		`Use a supported regular file inside the workspace (${code}).`,
	);
}

function isAbort(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message === "cancelled" || error.message === "start_aborted")
	);
}

interface FileIdentity {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
function identity(value: FileIdentity): FileIdentity {
	return {
		dev: value.dev,
		ino: value.ino,
		size: value.size,
		mtimeMs: value.mtimeMs,
	};
}
function sameFile(left: FileIdentity, right: FileIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs
	);
}

/** Trusted bridge from Pi tools to the established configuration/install/runtime layers. */
export class TrustedOperationService {
	private readonly load: typeof loadConfig;
	private readonly readText: ((path: string) => Promise<string>) | undefined;
	private readonly resolveCommand: typeof resolveExecutable;
	private readonly start: typeof NodeLspRuntimeSession.start;
	private readonly platform: NodeJS.Platform;

	public constructor(private readonly options: ToolServiceOptions) {
		this.load = options.load ?? loadConfig;
		this.readText = options.readText;
		this.resolveCommand = options.resolveCommand ?? resolveExecutable;
		this.start = options.start ?? NodeLspRuntimeSession.start;
		this.platform = options.platform ?? process.platform;
	}

	private async readVerifiedText(
		cwd: string,
		target: ResolvedTarget,
		initial: FileIdentity,
		signal?: AbortSignal,
	): Promise<string> {
		if (signal?.aborted) throw new ToolError("cancelled", "Retry the request.");
		const current = await resolveFile(cwd, target.filePath);
		if (!current.ok || current.value.filePath !== target.filePath)
			throw errorForFile(current.ok ? "file_changed" : current.code);
		let currentIdentity: FileIdentity;
		try {
			currentIdentity = identity(await stat(target.filePath));
		} catch {
			throw errorForFile("file_changed");
		}
		if (!sameFile(initial, currentIdentity)) throw errorForFile("file_changed");
		if (this.readText) return this.readText(target.filePath);

		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(target.filePath, "r");
			const before = identity(await handle.stat());
			if (!sameFile(initial, before) || before.size > MAX_DOCUMENT_BYTES)
				throw errorForFile(
					before.size > MAX_DOCUMENT_BYTES ? "file_too_large" : "file_changed",
				);
			const text = await handle.readFile("utf8");
			const after = identity(await handle.stat());
			if (!sameFile(before, after)) throw errorForFile("file_changed");
			if (signal?.aborted)
				throw new ToolError("cancelled", "Retry the request.");
			return text;
		} catch (error) {
			if (error instanceof ToolError) throw error;
			throw errorForFile("file_changed");
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	public async config(
		ctx: ExtensionContext,
		globalOnly = false,
	): Promise<LoadedConfig> {
		if (!globalOnly && !ctx.isProjectTrusted())
			throw new ToolError(
				"untrusted_project",
				"Trust this project before using LSP tools.",
			);
		return this.load({
			cwd: ctx.cwd,
			isProjectTrusted: globalOnly ? false : ctx.isProjectTrusted(),
		});
	}

	private async executable(
		loaded: LoadedConfig,
		server: EffectiveServerConfig,
		origin: InstallOrigin,
		signal?: AbortSignal,
		installIfMissing = true,
	): Promise<string> {
		const executable = await this.resolveCommand(
			server.command,
			process.env,
			this.platform,
		);
		if (executable) return executable;
		if (!installIfMissing)
			throw new ToolError("server_unavailable", server.manualHelp);
		const decision = evaluateInstallPolicy({
			origin,
			serverId: server.id,
			globalConfig: loaded.config,
			...(origin === "explicit" ? {} : { projectConfig: loaded.config }),
			projectTrusted:
				origin === "explicit" || loaded.projectLayer !== "not-read",
			platform: this.platform,
		});
		if (!decision.allowed)
			throw new ToolError(
				decision.reason === "server_disabled"
					? "server_disabled"
					: "server_unavailable",
				decision.manualHelp,
			);
		const coordinator = this.options.coordinator();
		if (!coordinator)
			throw new ToolError("runtime_failed", "Restart Pi and retry.");
		const installed = await coordinator.install({
			decision,
			managedStatePath: loaded.paths.managedStatePath,
			...(signal ? { signal } : {}),
		});
		if (installed.status !== "ready" || !installed.executable)
			throw new ToolError(
				installed.reason === "cancelled" ? "cancelled" : "server_unavailable",
				installed.reason === "cancelled"
					? "Retry the request."
					: server.manualHelp,
			);
		return installed.executable.path;
	}

	public async withFile<T>(
		ctx: ExtensionContext,
		filePath: string,
		role: SelectionRole,
		origin: InstallOrigin,
		work: (operation: ActiveOperation) => Promise<T>,
		signal = ctx.signal,
		serverOverride?: EffectiveServerConfig,
		installIfMissing = true,
		loadedOverride?: LoadedConfig,
	): Promise<T> {
		// This check intentionally precedes configuration, path canonicalization, file reads,
		// installation, pool acquisition, and process startup.
		if (!ctx.isProjectTrusted())
			throw new ToolError(
				"untrusted_project",
				"Trust this project before using LSP tools.",
			);
		if (signal?.aborted) throw new ToolError("cancelled", "Retry the request.");
		const loaded = loadedOverride ?? (await this.config(ctx));
		const resolved = await resolveFile(ctx.cwd, filePath);
		if (!resolved.ok) throw errorForFile(resolved.code);
		const target = await resolveRoot(resolved.value);
		let initialFile: FileIdentity;
		try {
			initialFile = identity(await stat(target.filePath));
		} catch {
			throw errorForFile("file_changed");
		}
		const selection = selectServers(loaded.config, target, role, {
			projectTrusted: true,
			availableServerIds: new Set(),
		});
		const currentOverride = serverOverride
			? loaded.config.servers[serverOverride.id]
			: undefined;
		if (serverOverride && (!currentOverride || !currentOverride.enabled))
			throw new ToolError(
				"server_disabled",
				currentOverride?.manualHelp ??
					"Enable a supported LSP server and retry.",
			);
		const server = currentOverride ?? selection.primary;
		if (!server)
			throw new ToolError(
				"server_unavailable",
				"Install a supported language server and retry.",
			);
		const executable = await this.executable(
			loaded,
			server,
			origin,
			signal,
			installIfMissing,
		);
		const launch = createServerLaunch(
			executable,
			server.args,
			this.platform,
			process.env.ComSpec,
		);
		if (!launch) throw new ToolError("server_unavailable", server.manualHelp);
		const pool = this.options.pool();
		if (!pool) throw new ToolError("runtime_failed", "Restart Pi and retry.");
		const acquired = await pool.acquire(
			target.rootPath,
			server.id,
			async (startSignal) => {
				const key = await pool.key(target.rootPath, server.id);
				return this.start({
					launch,
					rootPath: target.rootPath,
					server,
					signal: startSignal,
					...pool.lifecycleCallbacks(key),
				});
			},
			signal,
		);
		const runtime = acquired.entry.session as NodeLspRuntimeSession;
		const uri = pathToFileURL(target.filePath).href;
		try {
			return await acquired.entry.queue.run(async () => {
				const text = await this.readVerifiedText(
					ctx.cwd,
					target,
					initialFile,
					signal,
				);
				const diagnosticGeneration = runtime.diagnostics.snapshot();
				const document = await runtime.session.documents.open(
					runtime.connection,
					uri,
					target.languageId,
					text,
				);
				try {
					return await work({
						target,
						server,
						runtime,
						entry: acquired.entry,
						uri,
						diagnosticGeneration,
					});
				} finally {
					await runtime.session.documents
						.close(runtime.connection, uri)
						.catch(() => undefined);
					void document;
				}
			}, signal);
		} catch (error) {
			if (error instanceof ToolError) throw error;
			if (
				error instanceof Error &&
				["connection_closed", "connection_tainted"].includes(error.message)
			)
				throw new TransientRuntimeError(error.message);
			if (isAbort(error))
				throw new ToolError("cancelled", "Retry the request.");
			throw error;
		} finally {
			acquired.lease.release();
		}
	}

	/** Runs the principal plus every eligible already-available diagnostics server. */
	public async readDiagnostics<T>(
		ctx: ExtensionContext,
		filePath: string,
		work: (operation: ActiveOperation) => Promise<T>,
		signal = ctx.signal,
		origin: Extract<InstallOrigin, "tool" | "post-edit"> = "tool",
	): Promise<readonly { serverId: string; value: T }[]> {
		if (!ctx.isProjectTrusted())
			throw new ToolError(
				"untrusted_project",
				"Trust this project before using LSP tools.",
			);
		if (signal?.aborted) throw new ToolError("cancelled", "Retry the request.");
		const loaded = await this.config(ctx);
		const resolved = await resolveFile(ctx.cwd, filePath);
		if (!resolved.ok) throw errorForFile(resolved.code);
		const target = await resolveRoot(resolved.value);
		const available = new Set<string>();
		for (const server of Object.values(loaded.config.servers)) {
			if (await this.resolveCommand(server.command, process.env, this.platform))
				available.add(server.id);
		}
		const selected = selectServers(loaded.config, target, "diagnostics", {
			projectTrusted: true,
			availableServerIds: available,
		});
		if (!selected.primary)
			throw new ToolError(
				"server_unavailable",
				"Install a supported language server and retry.",
			);
		const run = (server: EffectiveServerConfig, installIfMissing: boolean) =>
			retryOnce(
				"diagnostics",
				() =>
					this.withFile(
						ctx,
						filePath,
						"diagnostics",
						origin,
						work,
						signal,
						server,
						installIfMissing,
						loaded,
					),
				signal,
			);
		const results: { serverId: string; value: T }[] = [];
		results.push({
			serverId: selected.primary.id,
			value: await run(selected.primary, true),
		});
		for (const auxiliary of selected.auxiliaries) {
			try {
				results.push({
					serverId: auxiliary.id,
					value: await run(auxiliary, false),
				});
			} catch (error) {
				if (
					error instanceof ToolError &&
					[
						"server_unavailable",
						"server_disabled",
						"capability_missing",
						"runtime_failed",
					].includes(error.code)
				)
					continue;
				if (error instanceof TransientRuntimeError) continue;
				throw error;
			}
		}
		return results;
	}

	/** Starts an already available server for a trusted workspace; it never installs. */
	public async warmup(
		ctx: ExtensionContext,
		serverId: string,
		signal = ctx.signal,
	): Promise<void> {
		if (!ctx.isProjectTrusted())
			throw new ToolError(
				"untrusted_project",
				"Trust this project before warming an LSP server.",
			);
		const loaded = await this.config(ctx);
		const server = loaded.config.servers[serverId];
		if (!server || !server.enabled)
			throw new ToolError(
				"server_unavailable",
				"Use an enabled supported LSP server.",
			);
		const executable = await this.resolveCommand(
			server.command,
			process.env,
			this.platform,
		);
		if (!executable)
			throw new ToolError("server_unavailable", server.manualHelp);
		const launch = createServerLaunch(
			executable,
			server.args,
			this.platform,
			process.env.ComSpec,
		);
		const rootPath = await realpath(ctx.cwd).catch(() => undefined);
		if (!rootPath)
			throw new ToolError("invalid_file", "Use a valid workspace.");
		const pool = this.options.pool();
		if (!launch || !pool)
			throw new ToolError("runtime_failed", "Restart Pi and retry.");
		const acquired = await pool.acquire(
			rootPath,
			server.id,
			async (startSignal) => {
				const key = await pool.key(rootPath, server.id);
				return this.start({
					launch,
					rootPath,
					server,
					signal: startSignal,
					...pool.lifecycleCallbacks(key),
				});
			},
			signal,
		);
		acquired.lease.release();
	}

	/** Explicit install uses global policy only and never resolves project files or starts LSP. */
	public async explicitInstall(
		ctx: ExtensionContext,
		serverId: string,
		signal = ctx.signal,
	): Promise<InstallResult> {
		if (signal?.aborted) throw new ToolError("cancelled", "Retry the request.");
		const loaded = await this.config(ctx, true);
		const decision = evaluateInstallPolicy({
			origin: "explicit",
			serverId,
			globalConfig: loaded.config,
			projectTrusted: true,
			platform: this.platform,
		});
		if (!decision.allowed)
			throw new ToolError(
				decision.reason === "server_disabled"
					? "server_disabled"
					: "server_unavailable",
				decision.manualHelp,
			);
		const coordinator = this.options.coordinator();
		if (!coordinator)
			throw new ToolError("runtime_failed", "Restart Pi and retry.");
		const result = await coordinator.install({
			decision,
			managedStatePath: loaded.paths.managedStatePath,
			...(signal ? { signal } : {}),
		});
		if (result.status !== "ready")
			throw new ToolError(
				result.reason === "cancelled" ? "cancelled" : "server_unavailable",
				result.reason === "cancelled"
					? "Retry the request."
					: decision.recipe.manualHelp,
			);
		return result;
	}

	public async statusSnapshot(
		ctx: ExtensionContext,
		globalOnly = false,
		signal = ctx.signal,
	): Promise<{
		loaded: LoadedConfig;
		servers: readonly {
			id: string;
			enabled: boolean;
			available: boolean;
			roles: readonly string[];
		}[];
	}> {
		if (signal?.aborted) throw new ToolError("cancelled", "Retry the request.");
		const loaded = await this.config(ctx, globalOnly);
		const servers = await Promise.all(
			Object.values(loaded.config.servers).map(async (server) => {
				const recipe = getRecipe(server.id);
				const managedExecutable = recipe
					? join(
							loaded.paths.managedStatePath,
							"servers",
							recipe.serverId,
							recipe.revision,
							"node_modules",
							".bin",
							this.platform === "win32"
								? `${recipe.executable}.cmd`
								: recipe.executable,
						)
					: undefined;
				const managed = managedExecutable
					? await lstat(managedExecutable).then(
							(value) => value.isFile() || value.isSymbolicLink(),
							() => false,
						)
					: false;
				return {
					id: server.id,
					enabled: server.enabled,
					available:
						managed ||
						Boolean(
							await this.resolveCommand(
								server.command,
								process.env,
								this.platform,
							),
						),
					roles: server.roles,
				};
			}),
		);
		if (signal?.aborted) throw new ToolError("cancelled", "Retry the request.");
		return {
			loaded,
			servers: servers.sort((left, right) =>
				left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
			),
		};
	}

	public async auditSnapshot(
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<{ records: number; lastResult?: string }> {
		if (signal?.aborted) throw new ToolError("cancelled", "Retry the request.");
		const loaded = await this.config(ctx, true);
		const auditPath = join(
			loaded.paths.managedStatePath,
			"audit",
			"install.audit.jsonl",
		);
		let text = "";
		try {
			text = await readFile(auditPath, "utf8");
		} catch {
			return { records: 0 };
		}
		if (signal?.aborted) throw new ToolError("cancelled", "Retry the request.");
		const lines = text
			.slice(-64 * 1024)
			.trim()
			.split("\n")
			.filter(Boolean)
			.slice(-100);
		let lastResult: string | undefined;
		for (const line of lines) {
			try {
				const value = JSON.parse(line) as { result?: unknown };
				if (typeof value.result === "string") lastResult = value.result;
			} catch {
				// Ignore a partial rotated record without exposing its contents.
			}
		}
		return { records: lines.length, ...(lastResult ? { lastResult } : {}) };
	}

	public async read<T>(
		ctx: ExtensionContext,
		filePath: string,
		role: SelectionRole,
		work: (operation: ActiveOperation) => Promise<T>,
		signal = ctx.signal,
	): Promise<T> {
		return retryOnce(
			role === "diagnostics" ? "diagnostics" : "definition",
			() => this.withFile(ctx, filePath, role, "tool", work, signal),
			signal,
		).catch((error: unknown) => {
			if (error instanceof TransientRuntimeError)
				throw new ToolError("runtime_failed", "Retry the request.");
			throw error;
		});
	}

	public static label(target: ResolvedTarget): string {
		return target.relativePath || basename(target.filePath);
	}
}
