import type {
	GlobalConfig,
	GlobalServerConfig,
	ProjectConfig,
	ProjectServerConfig,
	ServerRole,
} from "../contracts.js";
import { SERVER_ROLES } from "../contracts.js";

export const MAX_CONFIG_TEXT_LENGTH = 256 * 1024;
export const MAX_STRING_LENGTH = 4_096;
const MAX_ARRAY_LENGTH = 128;
const MAX_PRIORITY = 10_000;
const MAX_DIAGNOSTIC_MS = 60_000;
const MIN_DIAGNOSTIC_MS = 1;

export type ConfigLayer = "global" | "project";
export type ConfigParseResult =
	| { ok: true; value: GlobalConfig | ProjectConfig }
	| { ok: false; reason: "invalid_json" | "invalid_schema" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isSafeString(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_STRING_LENGTH &&
		!value.includes("\u0000")
	);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_ARRAY_LENGTH &&
		value.every((item) => isSafeString(item))
	);
}

function isRoleArray(value: unknown): value is ServerRole[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= MAX_ARRAY_LENGTH &&
		value.every((item) => SERVER_ROLES.includes(item as ServerRole))
	);
}

function isTiming(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= MIN_DIAGNOSTIC_MS &&
		value <= MAX_DIAGNOSTIC_MS
	);
}

function isDiagnosticConfig(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			"pushGraceMs",
			"settleMs",
			"pullGraceMs",
			"requestTimeoutMs",
			"excludeDirectories",
		]) &&
		(value.pushGraceMs === undefined || isTiming(value.pushGraceMs)) &&
		(value.settleMs === undefined || isTiming(value.settleMs)) &&
		(value.pullGraceMs === undefined || isTiming(value.pullGraceMs)) &&
		(value.requestTimeoutMs === undefined ||
			isTiming(value.requestTimeoutMs)) &&
		(value.excludeDirectories === undefined ||
			(isStringArray(value.excludeDirectories) &&
				value.excludeDirectories.every(
					(item) => !item.includes("/") && !item.includes("\\"),
				)))
	);
}

function isExtensionArray(value: unknown): value is string[] {
	return (
		isStringArray(value) &&
		value.length > 0 &&
		value.every((extension) => /^\.[a-z0-9][a-z0-9.-]*$/.test(extension))
	);
}

function isLanguageIdByExtension(
	value: unknown,
): value is Record<string, string> {
	return (
		isStringRecord(value) &&
		Object.keys(value).every((extension) =>
			/^\.[a-z0-9][a-z0-9.-]*$/.test(extension),
		)
	);
}

function isPriority(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= -MAX_PRIORITY &&
		value <= MAX_PRIORITY
	);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		isRecord(value) &&
		Object.keys(value).length <= MAX_ARRAY_LENGTH &&
		Object.entries(value).every(
			([key, item]) => isSafeString(key) && isSafeString(item),
		)
	);
}

function isJsonValue(value: unknown, depth = 0): boolean {
	if (depth > 8 || value === null) {
		return value === null;
	}
	if (typeof value === "string") {
		return value.length <= MAX_STRING_LENGTH && !value.includes("\u0000");
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (typeof value === "boolean") {
		return true;
	}
	if (Array.isArray(value)) {
		return (
			value.length <= MAX_ARRAY_LENGTH &&
			value.every((item) => isJsonValue(item, depth + 1))
		);
	}
	if (isRecord(value)) {
		return (
			Object.keys(value).length <= MAX_ARRAY_LENGTH &&
			Object.entries(value).every(
				([key, item]) => isSafeString(key) && isJsonValue(item, depth + 1),
			)
		);
	}
	return false;
}

function parseGlobalServer(value: unknown): GlobalServerConfig | undefined {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"enabled",
			"autoInstall",
			"priority",
			"command",
			"args",
			"env",
			"extensions",
			"roles",
			"languageIds",
			"languageIdByExtension",
			"initialization",
			"diagnostics",
		])
	) {
		return undefined;
	}
	if (
		(value.enabled !== undefined && typeof value.enabled !== "boolean") ||
		(value.autoInstall !== undefined &&
			typeof value.autoInstall !== "boolean") ||
		(value.priority !== undefined && !isPriority(value.priority)) ||
		(value.command !== undefined && !isSafeString(value.command)) ||
		(value.args !== undefined && !isStringArray(value.args)) ||
		(value.env !== undefined && !isStringRecord(value.env)) ||
		(value.extensions !== undefined && !isExtensionArray(value.extensions)) ||
		(value.roles !== undefined && !isRoleArray(value.roles)) ||
		(value.languageIds !== undefined &&
			(!isStringArray(value.languageIds) || value.languageIds.length === 0)) ||
		(value.languageIdByExtension !== undefined &&
			!isLanguageIdByExtension(value.languageIdByExtension)) ||
		(value.initialization !== undefined &&
			(!isRecord(value.initialization) ||
				!isJsonValue(value.initialization))) ||
		(value.diagnostics !== undefined && !isDiagnosticConfig(value.diagnostics))
	) {
		return undefined;
	}
	return value as GlobalServerConfig;
}

function parseProjectServer(value: unknown): ProjectServerConfig | undefined {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["enabled", "autoInstall", "priority"])
	) {
		return undefined;
	}
	if (
		(value.enabled !== undefined && value.enabled !== false) ||
		(value.autoInstall !== undefined && value.autoInstall !== false) ||
		(value.priority !== undefined && !isPriority(value.priority))
	) {
		return undefined;
	}
	return value as ProjectServerConfig;
}

function parseServers<T>(
	value: unknown,
	parseServer: (server: unknown) => T | undefined,
): Record<string, T> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value) || Object.keys(value).length > MAX_ARRAY_LENGTH) {
		return undefined;
	}
	const parsed: Record<string, T> = {};
	for (const [id, server] of Object.entries(value)) {
		if (!/^[a-z][a-z0-9-]*$/.test(id)) {
			return undefined;
		}
		const candidate = parseServer(server);
		if (!candidate) {
			return undefined;
		}
		parsed[id] = candidate;
	}
	return parsed;
}

export function parseConfigText(
	text: string,
	layer: ConfigLayer,
): ConfigParseResult {
	if (text.length > MAX_CONFIG_TEXT_LENGTH) {
		return { ok: false, reason: "invalid_schema" };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { ok: false, reason: "invalid_json" };
	}
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"version",
			"network",
			"autoInstall",
			"postEditDiagnostics",
			"diagnostics",
			"servers",
		])
	) {
		return { ok: false, reason: "invalid_schema" };
	}
	if (value.version !== 1) {
		return { ok: false, reason: "invalid_schema" };
	}
	if (layer === "global") {
		if (
			(value.network !== undefined &&
				value.network !== "auto" &&
				value.network !== "offline") ||
			(value.autoInstall !== undefined &&
				typeof value.autoInstall !== "boolean") ||
			(value.postEditDiagnostics !== undefined &&
				typeof value.postEditDiagnostics !== "boolean") ||
			(value.diagnostics !== undefined &&
				!isDiagnosticConfig(value.diagnostics))
		) {
			return { ok: false, reason: "invalid_schema" };
		}
		const servers = parseServers(value.servers, parseGlobalServer);
		if (value.servers !== undefined && !servers) {
			return { ok: false, reason: "invalid_schema" };
		}
		return { ok: true, value: { ...value, servers } as GlobalConfig };
	}
	if (
		(value.network !== undefined && value.network !== "offline") ||
		(value.autoInstall !== undefined && value.autoInstall !== false) ||
		(value.postEditDiagnostics !== undefined &&
			value.postEditDiagnostics !== false) ||
		(value.diagnostics !== undefined && !isDiagnosticConfig(value.diagnostics))
	) {
		return { ok: false, reason: "invalid_schema" };
	}
	const servers = parseServers(value.servers, parseProjectServer);
	if (value.servers !== undefined && !servers) {
		return { ok: false, reason: "invalid_schema" };
	}
	return { ok: true, value: { ...value, servers } as ProjectConfig };
}
