import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SERVERS } from "../catalog/servers.js";
import type {
	DiagnosticConfig,
	EffectiveConfig,
	EffectiveServerConfig,
	GlobalConfig,
	GlobalServerConfig,
	ProjectConfig,
	ServerDefinition,
} from "../contracts.js";
import { MAX_CONFIG_TEXT_LENGTH, parseConfigText } from "./schema.js";

export interface ConfigPaths {
	globalConfigPath: string;
	managedStatePath: string;
	projectConfigPath: string;
}

export interface LoadConfigOptions {
	cwd: string;
	isProjectTrusted: boolean;
	readText?: (path: string) => Promise<string | undefined>;
	agentDirectory?: string;
	projectConfigDirectory?: string;
	catalog?: readonly ServerDefinition[];
}

export interface LoadedConfig {
	config: EffectiveConfig;
	paths: ConfigPaths;
	globalLayer: "absent" | "valid" | "invalid";
	projectLayer: "not-read" | "absent" | "valid" | "invalid";
}

type ReadLayerResult =
	| { state: "absent" }
	| { state: "invalid" }
	| { state: "present"; text: string };

async function readConfigFile(path: string): Promise<string | undefined> {
	let status: Awaited<ReturnType<typeof lstat>>;
	try {
		status = await lstat(path);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	if (
		!status.isFile() ||
		status.isSymbolicLink() ||
		status.size > MAX_CONFIG_TEXT_LENGTH
	) {
		throw new Error("Configuration file is not a regular bounded file.");
	}
	const text = await readFile(path, "utf8");
	if (text.length > MAX_CONFIG_TEXT_LENGTH) {
		throw new Error("Configuration file exceeds the maximum size.");
	}
	return text;
}

async function readLayer(
	readText: (path: string) => Promise<string | undefined>,
	path: string,
): Promise<ReadLayerResult> {
	try {
		const text = await readText(path);
		return text === undefined
			? { state: "absent" }
			: { state: "present", text };
	} catch {
		return { state: "invalid" };
	}
}

export function getConfigPaths(
	cwd: string,
	agentDirectory = getAgentDir(),
	projectConfigDirectory = CONFIG_DIR_NAME,
): ConfigPaths {
	return {
		globalConfigPath: join(agentDirectory, "pi-lsp-manager.json"),
		managedStatePath: join(agentDirectory, "lsp-manager"),
		projectConfigPath: join(cwd, projectConfigDirectory, "pi-lsp-manager.json"),
	};
}

function fromDefinition(definition: ServerDefinition): EffectiveServerConfig {
	const route =
		definition.route ??
		(definition.command
			? {
					command: definition.command,
					args: [...(definition.args ?? [])],
					...(definition.env ? { env: { ...definition.env } } : {}),
					...(definition.initialization
						? { initialization: { ...definition.initialization } }
						: {}),
				}
			: undefined);
	return {
		id: definition.id,
		enabled: true,
		autoInstall: definition.autoInstall,
		priority: definition.priority,
		...(route ? { route } : {}),
		...(definition.languageIdByExtension
			? { languageIdByExtension: { ...definition.languageIdByExtension } }
			: {}),
		extensions: [...definition.extensions],
		roles: [...definition.roles],
		languageIds: [...definition.languageIds],
		diagnostics: { ...definition.diagnostics },
		admission: definition.admission,
		manualHelp: definition.manualHelp,
	};
}

function hasConsistentLanguageRouting(server: EffectiveServerConfig): boolean {
	return Object.entries(server.languageIdByExtension ?? {}).every(
		([extension, languageId]) =>
			server.extensions.includes(extension) &&
			server.languageIds.includes(languageId),
	);
}

function applyGlobalServer(
	id: string,
	base: EffectiveServerConfig | undefined,
	override: GlobalServerConfig,
): EffectiveServerConfig | undefined {
	if (!base) {
		if (
			override.command === undefined ||
			override.args === undefined ||
			override.extensions === undefined ||
			override.roles === undefined ||
			override.languageIds === undefined ||
			override.extensions.length === 0 ||
			override.roles.length === 0 ||
			override.languageIds.length === 0
		) {
			return undefined;
		}
		const server: EffectiveServerConfig = {
			id,
			enabled: override.enabled ?? true,
			autoInstall: false,
			priority: override.priority ?? 0,
			route: {
				command: override.command,
				args: [...override.args],
				...(override.env !== undefined ? { env: { ...override.env } } : {}),
				...(override.initialization !== undefined
					? { initialization: { ...override.initialization } }
					: {}),
			},
			extensions: [...override.extensions],
			roles: [...override.roles],
			languageIds: [...override.languageIds],
			...(override.languageIdByExtension !== undefined
				? { languageIdByExtension: { ...override.languageIdByExtension } }
				: {}),
			diagnostics: {
				pushGraceMs: 5_000,
				settleMs: 50,
				pullGraceMs: 250,
				...override.diagnostics,
			},
			admission: "candidate",
			manualHelp: "Install this server manually, then retry.",
		};
		return hasConsistentLanguageRouting(server) ? server : undefined;
	}
	const baseRoute =
		base.route ??
		(base.command
			? {
					command: base.command,
					args: [...(base.args ?? [])],
					...(base.env ? { env: base.env } : {}),
					...(base.initialization
						? { initialization: base.initialization }
						: {}),
				}
			: undefined);
	const hasRouteOverride =
		override.command !== undefined ||
		override.args !== undefined ||
		override.env !== undefined ||
		override.initialization !== undefined;
	if (hasRouteOverride && !baseRoute && override.command === undefined)
		return undefined;
	const server: EffectiveServerConfig = {
		...base,
		enabled: base.enabled && (override.enabled ?? true),
		autoInstall: base.autoInstall && (override.autoInstall ?? true),
		priority: override.priority ?? base.priority,
		...(hasRouteOverride
			? {
					route: {
						command: override.command ?? baseRoute?.command ?? "",
						args: [...(override.args ?? baseRoute?.args ?? [])],
						...(override.env !== undefined
							? { env: { ...override.env } }
							: baseRoute?.env
								? { env: { ...baseRoute.env } }
								: {}),
						...(override.initialization !== undefined
							? { initialization: { ...override.initialization } }
							: baseRoute?.initialization
								? { initialization: { ...baseRoute.initialization } }
								: {}),
					},
				}
			: {}),
		extensions: override.extensions
			? [...override.extensions]
			: base.extensions,
		roles: override.roles ? [...override.roles] : base.roles,
		languageIds: override.languageIds
			? [...override.languageIds]
			: base.languageIds,
		...(override.languageIdByExtension !== undefined
			? { languageIdByExtension: { ...override.languageIdByExtension } }
			: {}),
	};
	if (
		override.languageIdByExtension === undefined &&
		(override.extensions !== undefined || override.languageIds !== undefined)
	)
		delete server.languageIdByExtension;
	if (override.diagnostics) {
		server.diagnostics = {
			pushGraceMs: 5_000,
			settleMs: 50,
			pullGraceMs: 250,
			...base.diagnostics,
			...override.diagnostics,
		};
	}
	return hasConsistentLanguageRouting(server) ? server : undefined;
}

function applyGlobal(
	defaults: EffectiveConfig,
	global: GlobalConfig,
): EffectiveConfig | undefined {
	const servers: Record<string, EffectiveServerConfig> = {
		...defaults.servers,
	};
	for (const [id, override] of Object.entries(global.servers ?? {})) {
		const merged = applyGlobalServer(id, servers[id], override);
		if (!merged) {
			return undefined;
		}
		servers[id] = merged;
	}
	const diagnostics: DiagnosticConfig = {
		pushGraceMs:
			global.diagnostics?.pushGraceMs ??
			defaults.diagnostics?.pushGraceMs ??
			5_000,
		settleMs:
			global.diagnostics?.settleMs ?? defaults.diagnostics?.settleMs ?? 50,
		pullGraceMs:
			global.diagnostics?.pullGraceMs ??
			defaults.diagnostics?.pullGraceMs ??
			250,
		requestTimeoutMs:
			global.diagnostics?.requestTimeoutMs ??
			defaults.diagnostics?.requestTimeoutMs ??
			30_000,
		excludeDirectories:
			global.diagnostics?.excludeDirectories ??
			defaults.diagnostics?.excludeDirectories ??
			[],
	};
	for (const [id, server] of Object.entries(servers)) {
		const serverOverride = global.servers?.[id]?.diagnostics;
		servers[id] = {
			...server,
			diagnostics: {
				pushGraceMs:
					serverOverride?.pushGraceMs ??
					global.diagnostics?.pushGraceMs ??
					server.diagnostics?.pushGraceMs ??
					diagnostics.pushGraceMs,
				settleMs:
					serverOverride?.settleMs ??
					global.diagnostics?.settleMs ??
					server.diagnostics?.settleMs ??
					diagnostics.settleMs,
				pullGraceMs:
					serverOverride?.pullGraceMs ??
					global.diagnostics?.pullGraceMs ??
					server.diagnostics?.pullGraceMs ??
					diagnostics.pullGraceMs,
			},
		};
	}
	return {
		version: 1,
		network: global.network === "offline" ? "offline" : defaults.network,
		autoInstall: defaults.autoInstall && (global.autoInstall ?? true),
		postEditDiagnostics:
			defaults.postEditDiagnostics && (global.postEditDiagnostics ?? true),
		diagnostics,
		servers,
	};
}

function mergeProjectDiagnostics(
	base: DiagnosticConfig | undefined,
	override: Partial<DiagnosticConfig> | undefined,
): DiagnosticConfig | undefined {
	if (!override) return base;
	const effective = base ?? {
		pushGraceMs: 5_000,
		settleMs: 50,
		pullGraceMs: 250,
		requestTimeoutMs: 30_000,
		excludeDirectories: [],
	};
	for (const key of [
		"pushGraceMs",
		"settleMs",
		"pullGraceMs",
		"requestTimeoutMs",
	] as const) {
		const value = override[key];
		if (value !== undefined && value > effective[key]) return undefined;
	}
	return {
		...effective,
		...Object.fromEntries(
			(["pushGraceMs", "settleMs", "pullGraceMs", "requestTimeoutMs"] as const)
				.filter((key) => override[key] !== undefined)
				.map((key) => [key, override[key]]),
		),
		excludeDirectories: [
			...new Set([
				...effective.excludeDirectories,
				...(override.excludeDirectories ?? []),
			]),
		],
	};
}

function applyProject(
	base: EffectiveConfig,
	project: ProjectConfig,
): EffectiveConfig | undefined {
	const servers: Record<string, EffectiveServerConfig> = { ...base.servers };
	for (const [id, override] of Object.entries(project.servers ?? {})) {
		const current = servers[id];
		if (
			!current ||
			(override.priority !== undefined && override.priority > current.priority)
		) {
			return undefined;
		}
		servers[id] = {
			...current,
			enabled: current.enabled && (override.enabled ?? true),
			autoInstall: current.autoInstall && (override.autoInstall ?? true),
			priority: override.priority ?? current.priority,
		};
	}
	const diagnostics = mergeProjectDiagnostics(
		base.diagnostics,
		project.diagnostics,
	);
	if (!diagnostics) return undefined;
	for (const [id, server] of Object.entries(servers)) {
		const current = server.diagnostics;
		if (!current) continue;
		for (const key of ["pushGraceMs", "settleMs", "pullGraceMs"] as const) {
			const value = project.diagnostics?.[key];
			if (value !== undefined && value > current[key]) return undefined;
		}
		servers[id] = {
			...server,
			diagnostics: {
				pushGraceMs: project.diagnostics?.pushGraceMs ?? current.pushGraceMs,
				settleMs: project.diagnostics?.settleMs ?? current.settleMs,
				pullGraceMs: project.diagnostics?.pullGraceMs ?? current.pullGraceMs,
			},
		};
	}
	return {
		...base,
		network: project.network === "offline" ? "offline" : base.network,
		autoInstall: base.autoInstall && (project.autoInstall ?? true),
		postEditDiagnostics:
			base.postEditDiagnostics && (project.postEditDiagnostics ?? true),
		diagnostics,
		servers,
	};
}

export function createDefaultConfig(
	catalog: readonly ServerDefinition[] = DEFAULT_SERVERS,
): EffectiveConfig {
	const servers: Record<string, EffectiveServerConfig> = {};
	for (const definition of catalog) {
		servers[definition.id] = fromDefinition(definition);
	}
	return {
		version: 1,
		network: "auto",
		autoInstall: true,
		postEditDiagnostics: true,
		diagnostics: {
			pushGraceMs: 5_000,
			settleMs: 50,
			pullGraceMs: 250,
			requestTimeoutMs: 30_000,
			excludeDirectories: [],
		},
		servers,
	};
}

export async function loadConfig(
	options: LoadConfigOptions,
): Promise<LoadedConfig> {
	const paths = getConfigPaths(
		options.cwd,
		options.agentDirectory,
		options.projectConfigDirectory,
	);
	const readText = options.readText ?? readConfigFile;
	let config = createDefaultConfig(options.catalog);
	const globalRead = await readLayer(readText, paths.globalConfigPath);
	let globalLayer: LoadedConfig["globalLayer"] =
		globalRead.state === "absent" ? "absent" : "invalid";
	if (globalRead.state === "present") {
		const parsed = parseConfigText(globalRead.text, "global");
		if (parsed.ok) {
			const merged = applyGlobal(config, parsed.value as GlobalConfig);
			if (merged) {
				config = merged;
				globalLayer = "valid";
			}
		}
	}
	if (!options.isProjectTrusted) {
		return { config, paths, globalLayer, projectLayer: "not-read" };
	}
	const projectRead = await readLayer(readText, paths.projectConfigPath);
	let projectLayer: LoadedConfig["projectLayer"] =
		projectRead.state === "absent" ? "absent" : "invalid";
	if (projectRead.state === "present") {
		const parsed = parseConfigText(projectRead.text, "project");
		if (parsed.ok) {
			const merged = applyProject(config, parsed.value as ProjectConfig);
			if (merged) {
				config = merged;
				projectLayer = "valid";
			}
		}
	}
	return { config, paths, globalLayer, projectLayer };
}
