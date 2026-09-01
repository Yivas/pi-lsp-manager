import { pathToFileURL } from "node:url";
import type { EffectiveServerConfig } from "../contracts.js";
import { clientCapabilities, type ServerCapabilities } from "./capabilities.js";
import type { LspConnection } from "./connection.js";
import { DocumentStore } from "./documents.js";

export interface LspSessionOptions {
	rootPath: string;
	server: EffectiveServerConfig;
	processId?: number | null;
	workspaceFolders?: readonly { uri: string; name: string }[];
}

export class LspSession {
	public readonly documents = new DocumentStore();
	public capabilities: ServerCapabilities = {};
	private initialized = false;
	private initialization: Promise<boolean> | undefined;
	private initializationAttempted = false;

	public constructor(
		public readonly connection: LspConnection,
		private readonly options: LspSessionOptions,
	) {
		connection.onRequest("workspace/configuration", (params) => {
			const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
			return items.map(() => ({}));
		});
		connection.onRequest(
			"workspace/workspaceFolders",
			() =>
				options.workspaceFolders ?? [
					{ uri: pathToFileURL(options.rootPath).href, name: "workspace" },
				],
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
				settings: {},
			});
			this.initialized = true;
			return true;
		} catch {
			return false;
		}
	}

	public async shutdown(): Promise<void> {
		if (!this.initialized) return;
		await this.connection.request<null>("shutdown", {});
		await this.connection.notify("exit", {});
		this.initialized = false;
	}
}
