import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SERVERS } from "../catalog/servers.js";
import type {
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
	return {
		id: definition.id,
		enabled: true,
		autoInstall: definition.autoInstall,
		priority: definition.priority,
		command: definition.command,
		args: [...definition.args],
		extensions: [...definition.extensions],
		roles: [...definition.roles],
		languageIds: [...definition.languageIds],
		admission: definition.admission,
		manualHelp: definition.manualHelp,
	};
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
			override.languageIds === undefined
		) {
			return undefined;
		}
		const server: EffectiveServerConfig = {
			id,
			enabled: override.enabled ?? true,
			autoInstall: false,
			priority: override.priority ?? 0,
			command: override.command,
			args: [...override.args],
			extensions: [...override.extensions],
			roles: [...override.roles],
			languageIds: [...override.languageIds],
			admission: "detected",
			manualHelp: "Install this server manually, then retry.",
		};
		if (override.env) {
			server.env = { ...override.env };
		}
		if (override.initialization) {
			server.initialization = { ...override.initialization };
		}
		return server;
	}
	const server: EffectiveServerConfig = {
		...base,
		enabled: base.enabled && (override.enabled ?? true),
		autoInstall: base.autoInstall && (override.autoInstall ?? true),
		priority: override.priority ?? base.priority,
		command: override.command ?? base.command,
		args: override.args ? [...override.args] : base.args,
		extensions: override.extensions
			? [...override.extensions]
			: base.extensions,
		roles: override.roles ? [...override.roles] : base.roles,
		languageIds: override.languageIds
			? [...override.languageIds]
			: base.languageIds,
	};
	if (override.env) {
		server.env = { ...override.env };
	}
	if (override.initialization) {
		server.initialization = { ...override.initialization };
	}
	return server;
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
	return {
		version: 1,
		network: global.network === "offline" ? "offline" : defaults.network,
		autoInstall: defaults.autoInstall && (global.autoInstall ?? true),
		postEditDiagnostics:
			defaults.postEditDiagnostics && (global.postEditDiagnostics ?? true),
		servers,
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
	return {
		...base,
		network: project.network === "offline" ? "offline" : base.network,
		autoInstall: base.autoInstall && (project.autoInstall ?? true),
		postEditDiagnostics:
			base.postEditDiagnostics && (project.postEditDiagnostics ?? true),
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
