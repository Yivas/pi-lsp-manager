import {
	mkdtemp,
	mkdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { EffectiveConfig } from "../../src/contracts.js";
import { NodeLspRuntimeSession } from "../../src/protocol/process.js";
import { RuntimePool } from "../../src/runtime/pool.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import { definition } from "../../src/tools/definition.js";
import { references } from "../../src/tools/references.js";
import { prepareRename } from "../../src/tools/prepare-rename.js";
import { rename } from "../../src/tools/rename.js";
import { symbols } from "../../src/tools/symbols.js";
import { TrustedOperationService } from "../../src/tools/shared.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const runReal = process.env.RUN_REAL_VUE === "1";
const cli =
	process.env.VUE_CLI ??
	resolve("node_modules/@vue/language-server/bin/vue-language-server.js");
const config: EffectiveConfig = {
	version: 1,
	network: "offline",
	autoInstall: false,
	postEditDiagnostics: false,
	servers: {
		vue: {
			id: "vue",
			enabled: true,
			autoInstall: false,
			priority: 100,
			command: process.execPath,
			args: [cli, "--stdio"],
			route: { command: process.execPath, args: [cli, "--stdio"] },
			extensions: [".vue"],
			roles: ["diagnostics", "semantic", "mutation"],
			languageIds: ["vue"],
			admission: "candidate",
			diagnostics: { pushGraceMs: 15_000, settleMs: 50, pullGraceMs: 250 },
			manualHelp: "Install Vue Language Server 3.3.11.",
		},
	},
};

function value(result: {
	content: readonly { type: string; text?: string }[];
}) {
	const text = result.content.find((item) => item.type === "text")?.text;
	if (!text) throw new Error("Expected a text result.");
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new Error(text);
	}
}

describe.runIf(runReal)("Vue Language Server 3.3.11", () => {
	let workspace: string | undefined;
	let pool: RuntimePool | undefined;
	afterEach(async () => {
		await pool?.shutdown();
		if (workspace) await rm(workspace, { recursive: true, force: true });
		pool = undefined;
		workspace = undefined;
	});

	it("reports invalid SFC diagnostics without installing a server", async () => {
		// Keep the workspace outside the checkout. Its Vue package comes from the
		// npm root that owns VUE_CLI, not the checkout's ambient node_modules.
		workspace = await mkdtemp(join(tmpdir(), "pi-lsp-vue-real-"));
		const root = workspace;
		const modules = resolve(dirname(await realpath(cli)), "../../..");
		const vuePackage = join(modules, "vue");
		// The fixture uses the Vue version pinned by the isolated recipe.
		const vueManifest = JSON.parse(
			await readFile(join(vuePackage, "package.json"), "utf8"),
		) as { version?: string };
		expect(vueManifest.version).toBe("3.5.43");
		await mkdir(join(root, "src"));
		await mkdir(join(root, "node_modules"));
		await symlink(
			vuePackage,
			join(root, "node_modules", "vue"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await writeFile(
			join(workspace, "package.json"),
			JSON.stringify({
				name: "vue-real-fixture",
				private: true,
				dependencies: { vue: "3.5.43" },
			}),
		);
		await writeFile(
			join(workspace, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					moduleResolution: "bundler",
					module: "ESNext",
					target: "ESNext",
				},
				include: ["src/**/*"],
			}),
		);
		const invalid = join(workspace, "src", "Invalid.vue");
		await writeFile(
			invalid,
			'<script setup lang="ts">\nconst message: string = 123;\n</script>\n<template><div>{{ message }}</div></template>\n<style>.example { color: red; }</style>\n',
		);
		pool = new RuntimePool();
		let runtime: NodeLspRuntimeSession | undefined;
		const service = new TrustedOperationService({
			coordinator: () => undefined,
			pool: () => pool,
			load: async () => ({
				config,
				paths: {
					globalConfigPath: join(root, "global.json"),
					projectConfigPath: join(root, "project.json"),
					managedStatePath: join(root, "managed"),
				},
				globalLayer: "absent",
				projectLayer: "absent",
			}),
			resolveCommand: async () => process.execPath,
			start: async (options) => {
				runtime = await NodeLspRuntimeSession.start({
					...options,
					requestTimeoutMs: 30_000,
				});
				return runtime;
			},
		});
		const ctx = {
			cwd: workspace,
			signal: undefined,
			isProjectTrusted: () => true,
		} as never;
		const diagnose = async (filePath: string) => {
			// Cold Vue projects can publish after the first bounded grace period.
			// Retry only that explicit timeout; no missing publication counts as success.
			let response = await diagnostics(service, ctx, { filePath }, undefined);
			for (
				let retry = 0;
				retry < 2 && response.details?.code === "diagnostics_timed_out";
				retry++
			) {
				response = await diagnostics(service, ctx, { filePath }, undefined);
			}
			if (response.details?.code !== "ok") {
				const text = response.content.find(
					(item) => item.type === "text",
				)?.text;
				throw new Error(
					`${text ?? "Vue diagnostics failed"}; capabilities=${JSON.stringify(runtime?.session.capabilities)}; stderr=${runtime?.sanitizedStderr}`,
				);
			}
			return value(response);
		};
		const result = await diagnose(invalid);
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.stringContaining("not assignable"),
				}),
			]),
		);
		const target = value(
			await definition(
				service,
				ctx,
				{ filePath: invalid, line: 4, character: 20 },
				undefined,
			),
		);
		expect(target.definitions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "src/Invalid.vue", line: 2 }),
			]),
		);
		const refs = value(
			await references(
				service,
				ctx,
				{ filePath: invalid, line: 4, character: 20, includeDeclaration: true },
				undefined,
			),
		);
		expect(refs.references).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "src/Invalid.vue", line: 2 }),
				expect.objectContaining({ path: "src/Invalid.vue", line: 4 }),
			]),
		);
		const outline = value(
			await symbols(
				service,
				ctx,
				{ filePath: invalid, scope: "document" },
				undefined,
			),
		);
		expect(outline.symbols).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: expect.any(String) }),
			]),
		);
		const prepared = value(
			await prepareRename(
				service,
				ctx,
				{ filePath: invalid, line: 4, character: 20 },
				undefined,
			),
		);
		expect(prepared.prepareRename).toBeTruthy();
		value(
			await rename(
				service,
				ctx,
				{
					filePath: invalid,
					line: 4,
					character: 20,
					newName: "updatedMessage",
				},
				undefined,
			),
		);
		const changed = await readFile(invalid, "utf8");
		expect(changed).toContain("const updatedMessage: string");
		expect(changed).toContain("{{ updatedMessage }}");
		for (const [name, source, expected] of [
			[
				"InvalidJs.vue",
				"<script setup>\nconst count = ;\n</script>\n<template>{{ count }}</template>",
				"error",
			],
			["InvalidTemplate.vue", "<template><div>{{ broken </template>", "error"],
			[
				"InvalidStyle.vue",
				'<template><div class="red">Hi</div></template>\n<style>.red { color: red</style>',
				"no-style-diagnostics",
			],
			[
				"Clean.vue",
				'<script setup lang="ts">const count: number = 1;</script>\n<template><div class="red">{{ count }}</div></template>\n<style>.red { color: red; }</style>',
				"clean",
			],
		] as const) {
			const path = join(root, "src", name);
			await writeFile(path, source);
			const actual = await diagnose(path);
			const reports = actual.diagnostics as unknown[];
			if (expected === "clean" || expected === "no-style-diagnostics")
				expect(reports).toEqual([]);
			else expect(reports.length, name).toBeGreaterThan(0);
		}
		const untrusted = {
			cwd: root,
			signal: undefined,
			isProjectTrusted: () => false,
		} as never;
		const denied = await diagnostics(
			service,
			untrusted,
			{ filePath: invalid },
			undefined,
		);
		expect(denied.content.find((item) => item.type === "text")?.text).toContain(
			"untrusted_project",
		);
		const cancelled = new AbortController();
		const cancelFile = join(root, "src", "Cancel.vue");
		const cancelText =
			'<script setup lang="ts">const value = 1;</script><template>{{ value }}</template>';
		await writeFile(cancelFile, cancelText);
		if (!runtime) throw new Error("Vue runtime did not start.");
		const interrupted = runtime.vueDiagnostics(
			cancelFile,
			cancelText,
			cancelled.signal,
		);
		cancelled.abort();
		await expect(interrupted).rejects.toThrow();
		await vi.waitFor(
			() => expect(pool?.activeServerIds()).not.toContain("vue"),
			{ timeout: 5_000 },
		);
	}, 180_000);
});
