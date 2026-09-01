import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EffectiveConfig } from "../../src/contracts.js";
import { NodeLspRuntimeSession } from "../../src/protocol/process.js";
import { RuntimePool } from "../../src/runtime/pool.js";
import { definition } from "../../src/tools/definition.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import { references } from "../../src/tools/references.js";
import { rename } from "../../src/tools/rename.js";
import { TrustedOperationService } from "../../src/tools/shared.js";
import { symbols } from "../../src/tools/symbols.js";
import { afterEach, describe, expect, it } from "vitest";

const runReal = process.env.RUN_REAL_LSP === "1";
const cli = resolve("node_modules/typescript-language-server/lib/cli.mjs");
const config: EffectiveConfig = {
	version: 1,
	network: "offline",
	autoInstall: false,
	postEditDiagnostics: false,
	servers: {
		typescript: {
			id: "typescript",
			enabled: true,
			autoInstall: false,
			priority: 100,
			command: process.execPath,
			args: [cli, "--stdio"],
			extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
			roles: ["diagnostics", "semantic", "mutation"],
			languageIds: [
				"typescript",
				"typescriptreact",
				"javascript",
				"javascriptreact",
			],
			admission: "tested",
			manualHelp: "Install TypeScript Language Server 5.3.0.",
		},
	},
};

function value(result: {
	content: readonly { type: string; text?: string }[];
}) {
	const content = result.content.find((item) => item.type === "text");
	if (!content?.text) throw new Error("Expected a text result.");
	try {
		return JSON.parse(content.text) as Record<string, unknown>;
	} catch {
		throw new Error(content.text);
	}
}

describe.runIf(runReal)("TypeScript Language Server 5.3.0", () => {
	let directory: string | undefined;
	let pool: RuntimePool | undefined;
	afterEach(async () => {
		await pool?.shutdown();
		if (directory) await rm(directory, { recursive: true, force: true });
		pool = undefined;
		directory = undefined;
	});

	it("serves diagnostics, navigation, symbols, rename, reuse, and shutdown", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-real-typescript-"));
		const workspace = directory;
		await writeFile(
			join(workspace, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
		);
		const invalid = join(workspace, "invalid.ts");
		const clean = join(workspace, "clean.ts");
		const semantic = join(workspace, "semantic.ts");
		await writeFile(invalid, "const invalid: string = 1;\n", "utf8");
		await writeFile(clean, "const clean: string = 'ok';\n", "utf8");
		await writeFile(
			semantic,
			"export const target = 1;\nexport const use = target;\n",
			"utf8",
		);
		pool = new RuntimePool();
		let starts = 0;
		const service = new TrustedOperationService({
			coordinator: () => undefined,
			pool: () => pool,
			load: async () => ({
				config,
				paths: {
					globalConfigPath: join(workspace, "global.json"),
					projectConfigPath: join(workspace, "project.json"),
					managedStatePath: join(workspace, "managed"),
				},
				globalLayer: "absent",
				projectLayer: "absent",
			}),
			resolveCommand: async () => process.execPath,
			start: async (options) => {
				starts += 1;
				return NodeLspRuntimeSession.start({
					...options,
					requestTimeoutMs: 30_000,
				});
			},
		});
		const ctx = {
			cwd: workspace,
			signal: undefined,
			isProjectTrusted: () => true,
		} as never;

		const invalidDiagnostics = value(
			await diagnostics(service, ctx, { filePath: invalid }, undefined),
		).diagnostics as unknown[];
		expect(invalidDiagnostics.length).toBeGreaterThan(0);
		const cleanDiagnostics = value(
			await diagnostics(service, ctx, { filePath: clean }, undefined),
		).diagnostics as unknown[];
		expect(cleanDiagnostics).toEqual([]);
		expect(
			value(
				await definition(
					service,
					ctx,
					{ filePath: semantic, line: 2, character: 19 },
					undefined,
				),
			).definitions,
		).toBeTruthy();
		expect(
			value(
				await references(
					service,
					ctx,
					{
						filePath: semantic,
						line: 2,
						character: 19,
						includeDeclaration: true,
					},
					undefined,
				),
			).references,
		).toBeTruthy();
		expect(
			value(
				await symbols(
					service,
					ctx,
					{ filePath: semantic, scope: "document" },
					undefined,
				),
			).symbols,
		).toBeTruthy();
		expect(
			value(
				await rename(
					service,
					ctx,
					{
						filePath: semantic,
						line: 2,
						character: 19,
						newName: "renamedTarget",
					},
					undefined,
				),
			).mutation,
		).toMatchObject({ status: "applied" });
		expect(await readFile(semantic, "utf8")).toContain("renamedTarget");
		expect(starts).toBe(1);
		expect(pool.size()).toBe(1);
	}, 90_000);
});
