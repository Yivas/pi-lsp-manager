export const SERVER_ROLES = ["diagnostics", "semantic", "mutation"] as const;

export type ServerRole = (typeof SERVER_ROLES)[number];
export type NetworkPolicy = "auto" | "offline";
export type ServerAdmission =
	| "candidate"
	| "detected"
	| "tested"
	| "auto-installable";

export interface ServerDefinition {
	id: string;
	roles: readonly ServerRole[];
	extensions: readonly string[];
	languageIds: readonly string[];
	command: string;
	args: readonly string[];
	priority: number;
	autoInstall: boolean;
	admission: ServerAdmission;
	manualHelp: string;
}

export interface GlobalServerConfig {
	enabled?: boolean;
	autoInstall?: boolean;
	priority?: number;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	extensions?: string[];
	roles?: ServerRole[];
	languageIds?: string[];
	initialization?: Record<string, unknown>;
}

export interface ProjectServerConfig {
	enabled?: false;
	autoInstall?: false;
	priority?: number;
}

export interface GlobalConfig {
	version: 1;
	network?: NetworkPolicy;
	autoInstall?: boolean;
	postEditDiagnostics?: boolean;
	servers?: Record<string, GlobalServerConfig>;
}

export interface ProjectConfig {
	version: 1;
	network?: "offline";
	autoInstall?: false;
	postEditDiagnostics?: false;
	servers?: Record<string, ProjectServerConfig>;
}

export interface EffectiveServerConfig {
	id: string;
	enabled: boolean;
	autoInstall: boolean;
	priority: number;
	command: string;
	args: readonly string[];
	env?: Readonly<Record<string, string>>;
	extensions: readonly string[];
	roles: readonly ServerRole[];
	languageIds: readonly string[];
	initialization?: Readonly<Record<string, unknown>>;
	admission: ServerAdmission;
	manualHelp: string;
}

export interface EffectiveConfig {
	version: 1;
	network: NetworkPolicy;
	autoInstall: boolean;
	postEditDiagnostics: boolean;
	servers: Readonly<Record<string, EffectiveServerConfig>>;
}

export interface ResolvedFile {
	workspacePath: string;
	filePath: string;
	relativePath: string;
	extension: string;
	languageId: string;
}

export interface ResolvedTarget extends ResolvedFile {
	rootPath: string;
}

export type ResolutionErrorCode =
	| "file_not_found"
	| "file_not_regular"
	| "file_outside_workspace"
	| "unsupported_file";

export type Result<T, E extends string = ResolutionErrorCode> =
	| { ok: true; value: T }
	| { ok: false; code: E };

export type SelectionRole = "diagnostics" | "semantic" | "mutation";

export interface ServerSelectionContext {
	projectTrusted: boolean;
	availableServerIds: ReadonlySet<string>;
}

export interface ServerSelection {
	primary?: EffectiveServerConfig;
	auxiliaries: readonly EffectiveServerConfig[];
	installCandidate?: EffectiveServerConfig;
}
