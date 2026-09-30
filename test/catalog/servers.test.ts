import { describe, expect, it } from "vitest";
import { DEFAULT_SERVERS, validateCatalog } from "../../src/catalog/servers.js";
import {
	getRecipe,
	getRecipeRevision,
	VUE_RECIPE,
} from "../../src/install/catalog.js";
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
	it("registers Vue as an auto-installable principal route with verified rows", () => {
		const server = DEFAULT_SERVERS.find((item) => item.id === "vue");
		expect(server).toMatchObject({
			id: "vue",
			extensions: [".vue"],
			languageIds: ["vue"],
			roles: ["diagnostics", "semantic", "mutation"],
			priority: 100,
			route: { command: "vue-language-server", args: ["--stdio"] },
			autoInstall: true,
			admission: "auto-installable",
			manualHelp: expect.stringContaining("TypeScript plugin 3.3.11"),
			diagnostics: { pushGraceMs: 15_000, settleMs: 50, pullGraceMs: 250 },
		});
		expect(server?.manualHelp).toContain("vue-language-server.js");
		expect(server?.manualHelp).toContain("--stdio");
		expect(
			server?.compatibility.map((row) => [
				row.platform,
				row.architecture,
				row.runner,
			]),
		).toEqual([
			["win32", "x64", "windows-2022"],
			["darwin", "arm64", "macos-14"],
			["linux", "x64", "ubuntu-24.04"],
		]);
		for (const row of server?.compatibility ?? []) {
			expect(row).toMatchObject({
				nodeVersion: "22.19.0",
				piVersion: "0.87.1",
				serverVersion: "3.3.11",
				languageVersion: "5.9.3",
			});
			expect(row.capabilities).toEqual(
				expect.arrayContaining([
					"diagnostics",
					"definition",
					"references",
					"document-symbols",
					"rename",
					"shutdown",
				]),
			);
		}
		expect(getRecipe("vue")).toBe(VUE_RECIPE);
	});

	it("registers the Vue recipe while the remaining web candidates stay inactive", () => {
		expect(VUE_RECIPE).toMatchObject({
			serverId: "vue",
			admission: "auto-installable",
		});
		expect(getRecipe("vue")).toBe(VUE_RECIPE);
		expect(getRecipeRevision("vue")).toBe(VUE_RECIPE.revision);
		for (const id of ["tailwindcss", "eslint"] as const) {
			const server = DEFAULT_SERVERS.find((item) => item.id === id);
			expect(server, id).toMatchObject({
				id,
				admission: "candidate",
				autoInstall: false,
				compatibility: [],
			});
			expect(getRecipe(id), id).toBeUndefined();
			expect(getRecipeRevision(id), id).toBeUndefined();
		}
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
			(item) => item.id !== "typescript" && item.id !== "vue",
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
