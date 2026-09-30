import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EffectiveConfig } from "../../src/contracts.js";
import { NodeLspRuntimeSession } from "../../src/protocol/process.js";
import { RuntimePool } from "../../src/runtime/pool.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import { TrustedOperationService } from "../../src/tools/shared.js";

// Real coexistence gate: one Vue SFC diagnosed by the Vue language server and
// the Tailwind language server at the same time, both from isolated locked
// installations built outside the checkout. Vue stays the principal and
// Tailwind the auxiliary, exactly as the catalog declares them (candidates).

const runReal =
	process.env.RUN_REAL_VUE === "1" && process.env.RUN_REAL_TAILWIND === "1";
const externalVueCli = process.env.VUE_CLI;
// The CI gate sets VUE_CLI_REQUIRED so a missing handoff fails closed: the
// repository's locked development dependencies would otherwise supply the Vue
// half and hide a broken gate installation. Local runs keep the fallback.
if (runReal && process.env.VUE_CLI_REQUIRED === "1" && !externalVueCli)
	throw new Error("VUE_CLI is required when VUE_CLI_REQUIRED=1.");
const vueCli =
	externalVueCli ??
	resolve("node_modules/@vue/language-server/bin/vue-language-server.js");
const tailwindCli = process.env.TAILWIND_CLI;

// The SFC carries a TypeScript error on line 2 and a Tailwind class conflict on
// line 5, so the two servers report on different lines and the merged order is
// observable without depending on their publication timing.
const COMPONENT = `<script setup lang="ts">
const message: string = 123;
</script>
<template>
  <div class="p-2 p-4">{{ message }}</div>
</template>
`;
const TS_ERROR_LINE = 2;
const CSS_CONFLICT_LINE = 5;

interface ReportedDiagnostic {
	line: number;
	character: number;
	endLine: number;
	endCharacter: number;
	severity: number;
	code?: string | number;
	source?: string;
	message: string;
	serverId: string;
}

function effectiveConfig(
	componentCli: string,
	auxiliaryCli: string,
): EffectiveConfig {
	return {
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
				args: [componentCli, "--stdio"],
				route: { command: process.execPath, args: [componentCli, "--stdio"] },
				extensions: [".vue"],
				roles: ["diagnostics"],
				languageIds: ["vue"],
				admission: "candidate",
				diagnostics: { pushGraceMs: 30_000, settleMs: 50, pullGraceMs: 250 },
				manualHelp: "Install Vue Language Server 3.3.11.",
			},
			tailwindcss: {
				id: "tailwindcss",
				enabled: true,
				autoInstall: false,
				priority: 90,
				command: process.execPath,
				args: [auxiliaryCli, "--stdio"],
				// The auxiliary command stays a bare name: only the availability
				// resolution reads it, and the route decides what would be spawned.
				route: {
					command: "tailwindcss-language-server",
					args: [auxiliaryCli, "--stdio"],
				},
				extensions: [".vue"],
				roles: ["diagnostics"],
				languageIds: ["vue"],
				admission: "candidate",
				diagnostics: { pushGraceMs: 30_000, settleMs: 50, pullGraceMs: 250 },
				manualHelp: "Install @tailwindcss/language-server 0.16.0.",
			},
		},
	};
}

function value(result: {
	content: readonly { type: string; text?: string }[];
}): Record<string, unknown> {
	const text = result.content.find((item) => item.type === "text")?.text;
	if (!text) throw new Error("Expected a text result.");
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new Error(text);
	}
}

/** Symlinks the workspace engine beside the workspace so neither server escapes it. */
async function linkPackage(
	root: string,
	modulesRoot: string,
	name: string,
): Promise<void> {
	await symlink(
		join(modulesRoot, name),
		join(root, "node_modules", name),
		process.platform === "win32" ? "junction" : "dir",
	);
}

function moduleRoot(cli: string): string {
	// <modules>/@scope/package/bin/entry -> <modules>
	return resolve(dirname(cli), "..", "..", "..");
}

async function workspaceRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-lsp-vue-tailwind-real-"));
	await mkdir(join(root, "src"));
	await mkdir(join(root, "node_modules"));
	const vueModules = moduleRoot(await realpath(vueCli));
	await linkPackage(root, vueModules, "vue");
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({
			name: "vue-tailwind-real-fixture",
			private: true,
			dependencies: {},
		}),
	);
	await writeFile(
		join(root, "tsconfig.json"),
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
	// The Tailwind server discovers its project from this CSS entry point.
	await writeFile(join(root, "src", "app.css"), '@import "tailwindcss";\n');
	await writeFile(join(root, "src", "Component.vue"), COMPONENT);
	return root;
}

/** Retry only the explicit cold-build timeout, never a missing publication. */
async function diagnose(
	service: TrustedOperationService,
	ctx: never,
	filePath: string,
): Promise<ReportedDiagnostic[]> {
	let response = await diagnostics(service, ctx, { filePath }, undefined);
	for (
		let retry = 0;
		retry < 2 && response.details?.code === "diagnostics_timed_out";
		retry++
	) {
		response = await diagnostics(service, ctx, { filePath }, undefined);
	}
	if (response.details?.code !== "ok") {
		// Keep the failure free of stderr and absolute paths.
		const text = response.content.find((item) => item.type === "text")?.text;
		throw new Error(
			`Coexistence diagnostics failed (${response.details?.code ?? "missing code"}): ${text ?? "<no message>"}`,
		);
	}
	const output = value(response);
	const entries = output.diagnostics;
	if (!Array.isArray(entries)) throw new Error("Missing diagnostics array.");
	return entries as ReportedDiagnostic[];
}

describe.runIf(runReal)("Vue and Tailwind coexistence on one Vue SFC", () => {
	let workspace: string | undefined;
	let pool: RuntimePool | undefined;

	afterEach(async () => {
		try {
			try {
				await pool?.shutdown();
			} finally {
				if (workspace)
					// Only this fixture's own directory, with the bounded retry the
					// linked Vue package needs on Windows.
					await rm(workspace, {
						recursive: true,
						force: true,
						maxRetries: 10,
						retryDelay: 50,
					});
			}
		} finally {
			pool = undefined;
			workspace = undefined;
		}
	});

	function startFixture(
		root: string,
		config: EffectiveConfig,
		auxiliaryAvailable: boolean,
	) {
		let runtime: NodeLspRuntimeSession | undefined;
		let starts = 0;
		const coordinator = vi.fn(() => undefined);
		const service = new TrustedOperationService({
			coordinator,
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
			resolveCommand: async (command) =>
				command === "tailwindcss-language-server" && !auxiliaryAvailable
					? undefined
					: process.execPath,
			start: async (options) => {
				starts += 1;
				runtime = await NodeLspRuntimeSession.start({
					...options,
					requestTimeoutMs: 30_000,
				});
				return runtime;
			},
		});
		return {
			service,
			coordinator,
			runtime: () => runtime,
			starts: () => starts,
		};
	}

	it("labels both servers on one SFC and reuses one pool across repeats", async () => {
		if (!tailwindCli || !isAbsolute(tailwindCli))
			throw new Error("TAILWIND_CLI must be an absolute server path.");
		const root = await workspaceRoot();
		workspace = root;
		await linkPackage(
			root,
			moduleRoot(await realpath(tailwindCli)),
			"tailwindcss",
		);
		pool = new RuntimePool();
		const fixture = startFixture(
			root,
			effectiveConfig(vueCli, tailwindCli),
			true,
		);
		const withFile = vi.spyOn(fixture.service, "withFile");
		const ctx = {
			cwd: root,
			signal: undefined,
			isProjectTrusted: () => true,
		} as never;
		const component = join(root, "src", "Component.vue");

		const entries = await diagnose(fixture.service, ctx, component);
		const vueEntries = entries.filter((entry) => entry.serverId === "vue");
		const tailwindEntries = entries.filter(
			(entry) => entry.serverId === "tailwindcss",
		);
		// Both servers report on the same document and each keeps its own label.
		expect(new Set(entries.map((entry) => entry.serverId))).toEqual(
			new Set(["vue", "tailwindcss"]),
		);
		expect(vueEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					line: TS_ERROR_LINE,
					message: expect.stringContaining("not assignable"),
				}),
			]),
		);
		expect(tailwindEntries).toHaveLength(2);
		for (const entry of tailwindEntries) {
			expect(entry.code).toBe("cssConflict");
			expect(entry.source).toBe("tailwindcss");
			expect(entry.line).toBe(CSS_CONFLICT_LINE);
			expect(entry.severity).toBe(2);
		}
		// The documented order is line, then column, then serverId.
		for (let index = 1; index < entries.length; index += 1) {
			const previous = entries[index - 1] as ReportedDiagnostic;
			const current = entries[index] as ReportedDiagnostic;
			const ordered =
				previous.line < current.line ||
				(previous.line === current.line &&
					(previous.character < current.character ||
						(previous.character === current.character &&
							previous.serverId <= current.serverId)));
			expect(ordered, `entry ${index}`).toBe(true);
		}
		// The merged list carries no repeated entry. This SFC has no identical
		// diagnostic from both servers, so the invariant states the dedup contract
		// of the merged output rather than proving a drop happened.
		const keys = entries.map((entry) =>
			[
				entry.line,
				entry.character,
				entry.endLine,
				entry.endCharacter,
				entry.severity,
				entry.code ?? "",
				entry.message,
			].join(":"),
		);
		expect(new Set(keys).size).toBe(keys.length);
		// The auxiliary never receives install rights; the principal does.
		expect(withFile.mock.calls[0]?.[7]).toBe(true);
		const auxiliaryCalls = withFile.mock.calls.slice(1);
		expect(auxiliaryCalls.length).toBeGreaterThan(0);
		for (const call of auxiliaryCalls) {
			expect(call[6]?.id).toBe("tailwindcss");
			expect(call[7]).toBe(false);
		}
		expect(fixture.starts()).toBe(2);
		expect(fixture.coordinator).not.toHaveBeenCalled();
		expect(pool.size()).toBe(2);

		// A repeat is deterministic and reuses both processes.
		expect(await diagnose(fixture.service, ctx, component)).toEqual(entries);
		expect(fixture.starts()).toBe(2);
		expect(pool.size()).toBe(2);
		expect([...pool.activeServerIds()].sort()).toEqual(["tailwindcss", "vue"]);

		await pool.shutdown();
		expect(pool.activeServerIds()).toEqual([]);
		expect(pool.size()).toBe(0);
	}, 240_000);

	it("runs the principal alone when the auxiliary route is missing", async () => {
		const root = await workspaceRoot();
		workspace = root;
		pool = new RuntimePool();
		const fixture = startFixture(
			root,
			effectiveConfig(vueCli, tailwindCli ?? "tailwindcss-language-server"),
			false,
		);
		const ctx = {
			cwd: root,
			signal: undefined,
			isProjectTrusted: () => true,
		} as never;

		const entries = await diagnose(
			fixture.service,
			ctx,
			join(root, "src", "Component.vue"),
		);
		// Only the principal runs, and it still produces its own diagnostics.
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((entry) => entry.serverId === "vue")).toBe(true);
		expect(entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					line: TS_ERROR_LINE,
					message: expect.stringContaining("not assignable"),
				}),
			]),
		);
		expect(fixture.starts()).toBe(1);
		expect(fixture.coordinator).not.toHaveBeenCalled();
		expect(pool.size()).toBe(1);
		expect(pool.activeServerIds()).toEqual(["vue"]);

		await pool.shutdown();
		expect(pool.activeServerIds()).toEqual([]);
		expect(pool.size()).toBe(0);
	}, 240_000);
});
