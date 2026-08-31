import type { ServerDefinition } from "../contracts.js";

export const DEFAULT_SERVERS: readonly ServerDefinition[] = [
	{
		id: "typescript",
		roles: ["diagnostics", "semantic", "mutation"],
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		languageIds: [
			"typescript",
			"typescriptreact",
			"javascript",
			"javascriptreact",
		],
		command: "typescript-language-server",
		args: ["--stdio"],
		priority: 100,
		autoInstall: true,
		admission: "auto-installable",
		manualHelp:
			"Install typescript-language-server and typescript, then retry.",
	},
];
