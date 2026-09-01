import {
	SERVER_ROLES,
	type DiagnosticTiming,
	type ServerDefinition,
	type ServerRole,
} from "../contracts.js";

const timing: DiagnosticTiming = {
	pushGraceMs: 5_000,
	settleMs: 50,
	pullGraceMs: 250,
};
const manualHelp = "Install and configure this server manually, then retry.";
const principal: readonly ServerRole[] = [
	"diagnostics",
	"semantic",
	"mutation",
];
const auxiliary: readonly ServerRole[] = ["diagnostics"];

function candidate(
	id: string,
	extensions: readonly string[],
	languageIds: readonly string[],
	command?: string,
	args: readonly string[] = [],
	roles: readonly ServerRole[] = principal,
	languageIdByExtension?: Readonly<Record<string, string>>,
): ServerDefinition {
	return {
		id,
		extensions,
		languageIds,
		...(languageIdByExtension ? { languageIdByExtension } : {}),
		roles,
		priority: 0,
		autoInstall: false,
		admission: "candidate",
		diagnostics: timing,
		compatibility: [],
		manualHelp,
		...(command ? { route: { command, args } } : {}),
	};
}

const typescript: ServerDefinition = {
	id: "typescript",
	roles: principal,
	extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
	languageIds: [
		"typescript",
		"typescriptreact",
		"javascript",
		"javascriptreact",
	],
	languageIdByExtension: {
		".ts": "typescript",
		".tsx": "typescriptreact",
		".js": "javascript",
		".jsx": "javascriptreact",
		".mjs": "javascript",
		".cjs": "javascript",
		".mts": "typescript",
		".cts": "typescript",
	},
	route: { command: "typescript-language-server", args: ["--stdio"] },
	priority: 100,
	autoInstall: true,
	admission: "auto-installable",
	diagnostics: timing,
	compatibility: [
		{
			platform: "win32",
			architecture: "x64",
			runner: "windows-2022",
			nodeVersion: "22.19.0",
			piVersion: "0.84.1",
			serverVersion: "5.3.0",
			languageVersion: "5.9.3",
			capabilities: [
				"diagnostics",
				"definition",
				"references",
				"document-symbols",
				"rename",
				"process-reuse",
				"shutdown",
			],
		},
		{
			platform: "darwin",
			architecture: "arm64",
			runner: "macos-14",
			nodeVersion: "22.19.0",
			piVersion: "0.84.1",
			serverVersion: "5.3.0",
			languageVersion: "5.9.3",
			capabilities: [
				"diagnostics",
				"definition",
				"references",
				"document-symbols",
				"rename",
				"process-reuse",
				"shutdown",
			],
		},
		{
			platform: "linux",
			architecture: "x64",
			runner: "ubuntu-24.04",
			nodeVersion: "22.19.0",
			piVersion: "0.84.1",
			serverVersion: "5.3.0",
			languageVersion: "5.9.3",
			capabilities: [
				"diagnostics",
				"definition",
				"references",
				"document-symbols",
				"rename",
				"process-reuse",
				"shutdown",
			],
		},
	],
	manualHelp: "Install typescript-language-server and typescript, then retry.",
};

export const DEFAULT_SERVERS: readonly ServerDefinition[] = [
	typescript,
	candidate(
		"biome",
		[".js", ".jsx", ".ts", ".tsx", ".json", ".jsonc", ".css", ".graphql"],
		[
			"javascript",
			"javascriptreact",
			"typescript",
			"typescriptreact",
			"json",
			"jsonc",
			"css",
			"graphql",
		],
		"biome",
		["lsp-proxy"],
		auxiliary,
		{
			".js": "javascript",
			".jsx": "javascriptreact",
			".ts": "typescript",
			".tsx": "typescriptreact",
			".json": "json",
			".jsonc": "jsonc",
			".css": "css",
			".graphql": "graphql",
		},
	),
	candidate(
		"tailwindcss",
		[
			".html",
			".css",
			".js",
			".jsx",
			".ts",
			".tsx",
			".vue",
			".svelte",
			".astro",
			".mdx",
		],
		[
			"html",
			"css",
			"javascript",
			"javascriptreact",
			"typescript",
			"typescriptreact",
			"vue",
			"svelte",
			"astro",
			"mdx",
		],
		"tailwindcss-language-server",
		["--stdio"],
		auxiliary,
		{
			".html": "html",
			".css": "css",
			".js": "javascript",
			".jsx": "javascriptreact",
			".ts": "typescript",
			".tsx": "typescriptreact",
			".vue": "vue",
			".svelte": "svelte",
			".astro": "astro",
			".mdx": "mdx",
		},
	),
	candidate(
		"eslint",
		[
			".js",
			".jsx",
			".ts",
			".tsx",
			".astro",
			".html",
			".mdx",
			".vue",
			".md",
			".json",
			".jsonc",
		],
		[
			"javascript",
			"javascriptreact",
			"typescript",
			"typescriptreact",
			"astro",
			"html",
			"mdx",
			"vue",
			"markdown",
			"json",
			"jsonc",
		],
		"vscode-eslint-language-server",
		["--stdio"],
		auxiliary,
		{
			".js": "javascript",
			".jsx": "javascriptreact",
			".ts": "typescript",
			".tsx": "typescriptreact",
			".astro": "astro",
			".html": "html",
			".mdx": "mdx",
			".vue": "vue",
			".md": "markdown",
			".json": "json",
			".jsonc": "jsonc",
		},
	),
	candidate("ty", [".py", ".pyi"], ["python"], "ty", ["server"]),
	candidate("ruff", [".py", ".pyi"], ["python"], "ruff", ["server"], auxiliary),
	candidate("rust-analyzer", [".rs"], ["rust"], "rust-analyzer"),
	candidate("gopls", [".go"], ["go"], "gopls"),
	candidate(
		"rubocop",
		[".rb", ".rake"],
		["ruby"],
		"rubocop",
		["--lsp"],
		auxiliary,
	),
	candidate("elixir-ls", [".ex", ".exs"], ["elixir"], "language_server.sh"),
	candidate("zls", [".zig", ".zon"], ["zig"], "zls"),
	candidate("csharp", [".cs", ".csx"], ["csharp"], "csharp-ls"),
	candidate(
		"fsharp",
		[".fs", ".fsi", ".fsx", ".fsscript"],
		["fsharp"],
		"fsautocomplete",
	),
	candidate("sourcekit-lsp", [".swift"], ["swift"], "sourcekit-lsp"),
	candidate(
		"clangd",
		[".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".m", ".mm"],
		["c", "cpp", "objective-c", "objective-cpp"],
		"clangd",
		[],
		principal,
		{
			".c": "c",
			".h": "c",
			".cc": "cpp",
			".cpp": "cpp",
			".cxx": "cpp",
			".hpp": "cpp",
			".m": "objective-c",
			".mm": "objective-cpp",
		},
	),
	candidate("jdtls", [".java"], ["java"]),
	candidate("kotlin-lsp", [".kt", ".kts"], ["kotlin"], "kotlin-lsp.sh"),
	candidate(
		"yaml-language-server",
		[".yaml", ".yml"],
		["yaml"],
		"yaml-language-server",
		["--stdio"],
	),
	candidate("lua-language-server", [".lua"], ["lua"], "lua-language-server"),
	candidate(
		"intelephense",
		[".php", ".phtml", ".php3", ".php4", ".php5", ".phps"],
		["php"],
		"intelephense",
		["--stdio"],
	),
	candidate("prisma", [".prisma"], ["prisma"], "prisma-language-server", [
		"--stdio",
	]),
	candidate("dart", [".dart"], ["dart"], "dart", [
		"language-server",
		"--protocol=lsp",
	]),
	candidate("ocaml-lsp", [".ml", ".mli"], ["ocaml"], "ocamllsp"),
	candidate(
		"bash-language-server",
		[".sh", ".bash"],
		["shellscript"],
		"bash-language-server",
		["start"],
	),
	candidate("terraform-ls", [".tf", ".tfvars"], ["terraform"], "terraform-ls", [
		"serve",
	]),
	candidate(
		"texlab",
		[".tex", ".bib"],
		["latex", "bibtex"],
		"texlab",
		[],
		principal,
		{ ".tex": "latex", ".bib": "bibtex" },
	),
	candidate("gleam", [".gleam"], ["gleam"], "gleam", ["lsp"]),
	candidate(
		"clojure-lsp",
		[".clj", ".cljs", ".cljc", ".edn"],
		["clojure", "clojurescript"],
		"clojure-lsp",
		[],
		principal,
		{
			".clj": "clojure",
			".cljs": "clojurescript",
			".cljc": "clojure",
			".edn": "clojure",
		},
	),
	candidate("nixd", [".nix"], ["nix"], "nixd"),
	candidate("tinymist", [".typ", ".typc"], ["typst"], "tinymist"),
	candidate(
		"haskell-language-server",
		[".hs", ".lhs", ".hs-boot"],
		["haskell", "lhaskell"],
		"haskell-language-server-wrapper",
		["--lsp"],
		principal,
		{ ".hs": "haskell", ".lhs": "lhaskell", ".hs-boot": "haskell" },
	),
];

export function validateCatalog(catalog: readonly ServerDefinition[]): void {
	const ids = new Set<string>();
	for (const server of catalog) {
		if (
			!/^[a-z][a-z0-9-]*$/.test(server.id) ||
			ids.has(server.id) ||
			Object.hasOwn(server as object, "recipe")
		)
			throw new Error("Invalid catalog ID.");
		ids.add(server.id);
		if (
			!server.extensions.length ||
			!server.extensions.every((extension) =>
				/^\.[a-z0-9][a-z0-9.-]*$/.test(extension),
			)
		)
			throw new Error("Invalid catalog extension.");
		if (
			!server.languageIds.length ||
			!server.roles.length ||
			!server.roles.every((role) => SERVER_ROLES.includes(role)) ||
			!Object.entries(server.languageIdByExtension ?? {}).every(
				([extension, languageId]) =>
					server.extensions.includes(extension) &&
					server.languageIds.includes(languageId),
			)
		)
			throw new Error("Invalid catalog routing.");
		if (
			server.admission === "candidate" &&
			(server.autoInstall || server.compatibility.length)
		)
			throw new Error("Candidate claims installation or compatibility.");
		if (
			(server.admission === "tested" ||
				server.admission === "auto-installable") &&
			server.compatibility.length === 0
		)
			throw new Error("Tested admission requires compatibility evidence.");
		if (server.admission === "auto-installable" && !server.autoInstall)
			throw new Error("Auto-installable admission requires installation.");
		if (server.autoInstall && server.admission !== "auto-installable")
			throw new Error("Automatic installation requires admission.");
		if (server.route) {
			if (
				!server.route.command.trim() ||
				!Array.isArray(server.route.args) ||
				!server.route.args.every(
					(argument) =>
						typeof argument === "string" &&
						argument.length <= 4_096 &&
						!argument.includes("\\u0000"),
				)
			)
				throw new Error("Invalid catalog route.");
		}
	}
}
validateCatalog(DEFAULT_SERVERS);
