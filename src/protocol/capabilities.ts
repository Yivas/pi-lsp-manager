export interface ServerCapabilities {
	textDocumentSync?: number | { openClose?: boolean; change?: number };
	diagnosticProvider?: unknown;
	definitionProvider?: boolean;
	referencesProvider?: boolean;
	documentSymbolProvider?: boolean;
	workspaceSymbolProvider?: boolean;
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

export function hasCapability(
	capabilities: ServerCapabilities,
	capability: LspCapability,
): boolean {
	switch (capability) {
		case "diagnostics":
			return Boolean(capabilities.diagnosticProvider);
		case "definition":
			return capabilities.definitionProvider === true;
		case "references":
			return capabilities.referencesProvider === true;
		case "documentSymbols":
			return capabilities.documentSymbolProvider === true;
		case "workspaceSymbols":
			return capabilities.workspaceSymbolProvider === true;
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
