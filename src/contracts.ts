export const SERVER_ROLES = ["diagnostics", "semantic", "mutation"] as const;

export type ServerRole = (typeof SERVER_ROLES)[number];
export type NetworkPolicy = "auto" | "offline";
export type ServerAdmission =
	| "candidate"
	| "detected"
	| "tested"
	| "auto-installable";

export interface DiagnosticTiming {
	pushGraceMs: number;
	settleMs: number;
	pullGraceMs: number;
}

export interface DiagnosticConfig extends DiagnosticTiming {
	requestTimeoutMs: number;
	excludeDirectories: readonly string[];
}

export interface ServerRoute {
	command: string;
	args: readonly string[];
	env?: Readonly<Record<string, string>>;
	initialization?: Readonly<Record<string, unknown>>;
}

export interface CompatibilityRow {
	platform: NodeJS.Platform;
	architecture: "x64" | "arm64";
	runner: string;
	nodeVersion: string;
	piVersion: string;
	serverVersion: string;
	languageVersion: string;
	capabilities: readonly string[];
}

export interface ServerDefinition {
	id: string;
	roles: readonly ServerRole[];
	extensions: readonly string[];
	languageIds: readonly string[];
	languageIdByExtension?: Readonly<Record<string, string>>;
	route?: ServerRoute;
	/** Legacy fields remain readable while route metadata migrates. */
	command?: string;
	args?: readonly string[];
	env?: Readonly<Record<string, string>>;
	initialization?: Readonly<Record<string, unknown>>;
	priority: number;
	autoInstall: boolean;
	admission: ServerAdmission;
	diagnostics: DiagnosticTiming;
	compatibility: readonly CompatibilityRow[];
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
	languageIdByExtension?: Record<string, string>;
	initialization?: Record<string, unknown>;
	diagnostics?: Partial<DiagnosticTiming>;
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
	diagnostics?: Partial<DiagnosticConfig>;
	servers?: Record<string, GlobalServerConfig>;
}

export interface ProjectConfig {
	version: 1;
	network?: "offline";
	autoInstall?: false;
	postEditDiagnostics?: false;
	diagnostics?: Partial<DiagnosticConfig>;
	servers?: Record<string, ProjectServerConfig>;
}

export interface EffectiveServerConfig {
	id: string;
	enabled: boolean;
	autoInstall: boolean;
	priority: number;
	route?: ServerRoute;
	/** Legacy effective fields preserve existing host integrations during migration. */
	command?: string;
	args?: readonly string[];
	env?: Readonly<Record<string, string>>;
	initialization?: Readonly<Record<string, unknown>>;
	extensions: readonly string[];
	roles: readonly ServerRole[];
	languageIds: readonly string[];
	languageIdByExtension?: Readonly<Record<string, string>>;
	diagnostics?: DiagnosticTiming;
	admission: ServerAdmission;
	manualHelp: string;
}

export interface EffectiveConfig {
	version: 1;
	network: NetworkPolicy;
	autoInstall: boolean;
	postEditDiagnostics: boolean;
	diagnostics?: DiagnosticConfig;
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
