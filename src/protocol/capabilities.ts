export interface ServerCapabilities {
	textDocumentSync?: number | { openClose?: boolean; change?: number };
	diagnosticProvider?: unknown;
	definitionProvider?: boolean | Record<string, unknown>;
	referencesProvider?: boolean | Record<string, unknown>;
	documentSymbolProvider?: boolean | Record<string, unknown>;
	workspaceSymbolProvider?: boolean | Record<string, unknown>;
	renameProvider?: boolean | { prepareProvider?: boolean };
	codeActionProvider?: boolean | { resolveProvider?: boolean };
}

export type LspCapability =
	| "diagnostics"
	| "definition"
	| "references"
	| "documentSymbols"
	| "workspaceSymbols"
	| "prepareRename"
	| "rename"
	| "codeActions"
	| "codeActionResolve";

function enabledProvider(value: unknown): boolean {
	return value === true || (typeof value === "object" && value !== null);
}

export function hasCapability(
	capabilities: ServerCapabilities,
	capability: LspCapability,
): boolean {
	switch (capability) {
		case "diagnostics":
			return Boolean(capabilities.diagnosticProvider);
		case "definition":
			return enabledProvider(capabilities.definitionProvider);
		case "references":
			return enabledProvider(capabilities.referencesProvider);
		case "documentSymbols":
			return enabledProvider(capabilities.documentSymbolProvider);
		case "workspaceSymbols":
			return enabledProvider(capabilities.workspaceSymbolProvider);
		case "prepareRename":
			return (
				typeof capabilities.renameProvider === "object" &&
				capabilities.renameProvider.prepareProvider === true
			);
		case "rename":
			return (
				capabilities.renameProvider === true ||
				typeof capabilities.renameProvider === "object"
			);
		case "codeActions":
			return (
				capabilities.codeActionProvider === true ||
				typeof capabilities.codeActionProvider === "object"
			);
		case "codeActionResolve":
			return (
				typeof capabilities.codeActionProvider === "object" &&
				capabilities.codeActionProvider.resolveProvider === true
			);
	}
}

export function clientCapabilities(): Record<string, unknown> {
	return {
		workspace: { workspaceFolders: true, configuration: true },
		textDocument: {
			publishDiagnostics: { relatedInformation: true },
			diagnostic: {},
			definition: {},
			references: {},
			documentSymbol: {},
			rename: { prepareSupport: true },
			codeAction: { resolveSupport: { properties: ["edit"] } },
		},
	};
}
