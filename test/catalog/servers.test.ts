import { describe, expect, it } from "vitest";
import { DEFAULT_SERVERS, validateCatalog } from "../../src/catalog/servers.js";
import { getRecipe } from "../../src/install/catalog.js";
import type { ServerDefinition } from "../../src/contracts.js";

const compatibility = {
	platform: "linux" as const,
	architecture: "x64" as const,
	runner: "test",
	nodeVersion: "22.19.0",
	piVersion: "0.84.1",
	serverVersion: "1.0.0",
	languageVersion: "1.0.0",
	capabilities: [] as const,
};

function candidate(
	overrides: Partial<ServerDefinition> = {},
): ServerDefinition {
	return {
		id: "candidate",
		roles: ["diagnostics"],
		extensions: [".candidate"],
		languageIds: ["candidate"],
		priority: 0,
		autoInstall: false,
		admission: "candidate",
		diagnostics: { pushGraceMs: 5_000, settleMs: 50, pullGraceMs: 250 },
		compatibility: [],
		manualHelp: "Install this server manually, then retry.",
		...overrides,
	};
}

describe("server catalog", () => {
	it("registers Vue as a manual principal route without installation claims", () => {
		const server = DEFAULT_SERVERS.find((item) => item.id === "vue");
		expect(server).toMatchObject({
			id: "vue",
			extensions: [".vue"],
			languageIds: ["vue"],
			roles: ["diagnostics", "semantic", "mutation"],
			priority: 0,
			route: { command: "vue-language-server", args: ["--stdio"] },
			autoInstall: false,
			admission: "candidate",
			compatibility: [],
			manualHelp: "Install and configure this server manually, then retry.",
		});
		expect(getRecipe("vue")).toBeUndefined();
	});

	it("pins TypeScript compatibility claims and diagnostic timing", () => {
		const server = DEFAULT_SERVERS.find((item) => item.id === "typescript");
		expect(server).toMatchObject({
			id: "typescript",
			admission: "auto-installable",
			route: { command: "typescript-language-server", args: ["--stdio"] },
			diagnostics: { pushGraceMs: 5_000, settleMs: 50, pullGraceMs: 250 },
		});
		expect(server?.compatibility).toHaveLength(3);
		expect(
			server?.compatibility.map((row) => [row.platform, row.architecture]),
		).toEqual([
			["win32", "x64"],
			["darwin", "arm64"],
			["linux", "x64"],
		]);
	});

	it("contains every planned candidate once without an accidental recipe claim", () => {
		const ids = DEFAULT_SERVERS.map((server) => server.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual(
			expect.arrayContaining([
				"typescript",
				"vue",
				"biome",
				"tailwindcss",
				"eslint",
				"ty",
				"ruff",
				"rust-analyzer",
				"gopls",
				"rubocop",
				"elixir-ls",
				"zls",
				"csharp",
				"fsharp",
				"sourcekit-lsp",
				"clangd",
				"jdtls",
				"kotlin-lsp",
				"yaml-language-server",
				"lua-language-server",
				"intelephense",
				"prisma",
				"dart",
				"ocaml-lsp",
				"bash-language-server",
				"terraform-ls",
				"texlab",
				"gleam",
				"clojure-lsp",
				"nixd",
				"tinymist",
				"haskell-language-server",
			]),
		);
		for (const server of DEFAULT_SERVERS.filter(
			(item) => item.id !== "typescript",
		)) {
			expect(server).toMatchObject({
				admission: "candidate",
				autoInstall: false,
				compatibility: [],
			});
		}
		expect(
			DEFAULT_SERVERS.find((server) => server.id === "jdtls")?.route,
		).toBeUndefined();
	});

	it.each([
		["duplicate ID", [candidate(), candidate()]],
		["extension without a dot", [candidate({ extensions: ["bad"] })]],
		["empty extension list", [candidate({ extensions: [] })]],
		["empty role list", [candidate({ roles: [] })]],
		["unexpected automatic installation", [candidate({ autoInstall: true })]],
		["tested without evidence", [candidate({ admission: "tested" })]],
		[
			"auto-installable without installation",
			[
				candidate({
					admission: "auto-installable",
					compatibility: [compatibility],
				}),
			],
		],
		[
			"candidate compatibility",
			[
				candidate({
					compatibility: [compatibility],
				}),
			],
		],
	])("rejects %s", (_label, catalog) => {
		expect(() => validateCatalog(catalog)).toThrow();
	});
});
