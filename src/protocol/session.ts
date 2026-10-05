import { pathToFileURL } from "node:url";
import { ErrorCodes, ResponseError } from "vscode-jsonrpc/node";
import type { EffectiveServerConfig } from "../contracts.js";
import { clientCapabilities, type ServerCapabilities } from "./capabilities.js";
import type { LspConnection } from "./connection.js";
import { DocumentStore } from "./documents.js";

// `unregisterations` is the misspelling the LSP specification defines.
type RegistrationField = "registrations" | "unregisterations";

// The client never advertises dynamicRegistration, so it acknowledges only an
// empty registration list and refuses every other shape without keeping state.
function acknowledgeEmptyRegistration(
	params: unknown,
	field: RegistrationField,
): null {
	const registrations = (params as Record<string, unknown> | undefined)?.[
		field
	];
	if (!Array.isArray(registrations)) {
		throw new ResponseError(
			ErrorCodes.InvalidParams,
			"registration params must contain an array",
		);
	}
	if (registrations.length > 0) {
		throw new ResponseError(
			ErrorCodes.MethodNotFound,
			"dynamic registration is not supported",
		);
	}
	return null;
}

export interface LspSessionOptions {
	rootPath: string;
	server: EffectiveServerConfig;
	processId?: number | null;
	workspaceFolders?: readonly { uri: string; name: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON copy of the effective global settings so LSP handlers never alias or mutate
 * the loaded configuration object.
 */
function configurationSnapshot(
	settings: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
	return settings ? JSON.parse(JSON.stringify(settings)) : {};
}

/**
 * Resolves one `workspace/configuration` item against the settings snapshot. An absent
 * section means the whole object, a dotted section reads own properties only, and a
 * missing section yields `{}`. JSON values, including `false`, `null` and arrays, are
 * returned unchanged. `scopeUri`, if any, is ignored because these settings are global.
 */
function resolveConfigurationSection(
	settings: Readonly<Record<string, unknown>>,
	section: string | undefined,
): unknown {
	if (section === undefined || section === "") return settings;
	let current: unknown = settings;
	for (const segment of section.split(".")) {
		if (!isRecord(current) || !Object.hasOwn(current, segment)) return {};
		current = current[segment];
	}
	return current;
}

export class LspSession {
	public readonly documents = new DocumentStore();
	public capabilities: ServerCapabilities = {};
	private initialized = false;
	private initialization: Promise<boolean> | undefined;
	private initializationAttempted = false;
	private readonly settings: Readonly<Record<string, unknown>>;

	public constructor(
		public readonly connection: LspConnection,
		private readonly options: LspSessionOptions,
	) {
		this.settings = configurationSnapshot(options.server.settings);
		connection.onRequest("workspace/configuration", (params) =>
			this.configurationItems(params),
		);
		connection.onRequest(
			"workspace/workspaceFolders",
			() =>
				options.workspaceFolders ?? [
					{ uri: pathToFileURL(options.rootPath).href, name: "workspace" },
				],
		);
		connection.onRequest("client/registerCapability", (params) =>
			acknowledgeEmptyRegistration(params, "registrations"),
		);
		connection.onRequest("client/unregisterCapability", (params) =>
			acknowledgeEmptyRegistration(params, "unregisterations"),
		);
	}

	public initialize(): Promise<boolean> {
		if (this.initialized) return Promise.resolve(true);
		if (this.initialization) return this.initialization;
		// A connection that has accepted initialize cannot safely repeat it after a
		// notification failure; callers must replace the process instead.
		if (this.initializationAttempted) return Promise.resolve(false);
		this.initializationAttempted = true;
		this.initialization = this.initializeOnce().finally(() => {
			this.initialization = undefined;
		});
		return this.initialization;
	}

	private async initializeOnce(): Promise<boolean> {
		const rootUri = pathToFileURL(this.options.rootPath).href;
		const result = await this.connection.request<{
			capabilities?: ServerCapabilities;
		}>("initialize", {
			processId: this.options.processId ?? process.pid,
			rootUri,
			workspaceFolders: this.options.workspaceFolders ?? [
				{ uri: rootUri, name: "workspace" },
			],
			capabilities: clientCapabilities(),
			initializationOptions:
				this.options.server.route?.initialization ??
				this.options.server.initialization ??
				{},
		});
		if (!result.ok) return false;
		this.capabilities = result.value.capabilities ?? {};
		try {
			await this.connection.notify("initialized", {});
			await this.connection.notify("workspace/didChangeConfiguration", {
				settings: this.settings,
			});
			this.initialized = true;
			return true;
		} catch {
			return false;
		}
	}

	private configurationItems(params: unknown): readonly unknown[] {
		const items = (params as { items?: unknown } | undefined)?.items;
		if (!Array.isArray(items)) {
			throw new ResponseError(
				ErrorCodes.InvalidParams,
				"configuration items must be an array",
			);
		}
		return items.map((item) => {
			if (!isRecord(item)) {
				throw new ResponseError(
					ErrorCodes.InvalidParams,
					"configuration item must be an object",
				);
			}
			if (item.section !== undefined && typeof item.section !== "string") {
				throw new ResponseError(
					ErrorCodes.InvalidParams,
					"configuration item section must be a string",
				);
			}
			return resolveConfigurationSection(this.settings, item.section);
		});
	}

	public async shutdown(): Promise<void> {
		if (!this.initialized) return;
		await this.connection.request<null>("shutdown", {});
		await this.connection.notify("exit", {});
		this.initialized = false;
	}
}
