import {
	mkdtemp,
	mkdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EffectiveConfig } from "../../src/contracts.js";
import { LspConnection } from "../../src/protocol/connection.js";
import { NodeLspRuntimeSession } from "../../src/protocol/process.js";
import { RuntimePool } from "../../src/runtime/pool.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import { TrustedOperationService } from "../../src/tools/shared.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const runReal = process.env.RUN_REAL_TAILWIND === "1";
const cli = process.env.TAILWIND_CLI;

// The fixture never ships tailwindcss in the checkout, so the offline gate under
// test/real-servers/gates/tailwindcss owns the pinned server and engine closure.
const HTML_CONFLICT = '<div class="p-2 p-4"></div>\n';
const VUE_CONFLICT = '<template>\n  <div class="p-2 p-4"></div>\n</template>\n';
const HTML_CLEAN = '<div class="p-4"></div>\n';
// npm install reads both files with the same controlled values that the internal
// recipes write, so a project .npmrc cannot add registries or run scripts.
const CONTROLLED_NPMRC = "audit=false\nfund=false\nignore-scripts=true\n";

function effectiveConfig(serverCli: string): EffectiveConfig {
	return {
		version: 1,
		network: "offline",
		autoInstall: false,
		postEditDiagnostics: false,
		servers: {
			tailwindcss: {
				id: "tailwindcss",
				enabled: true,
				autoInstall: false,
				priority: 100,
				command: process.execPath,
				args: [serverCli, "--stdio"],
				route: { command: process.execPath, args: [serverCli, "--stdio"] },
				extensions: [".html", ".vue"],
				roles: ["diagnostics"],
				languageIds: ["html", "vue"],
				admission: "candidate",
				diagnostics: { pushGraceMs: 20_000, settleMs: 50, pullGraceMs: 250 },
				manualHelp: "Install @tailwindcss/language-server 0.16.0.",
			},
		},
	};
}

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

interface ReportedDiagnostic {
	line: number;
	character: number;
	endLine: number;
	endCharacter: number;
	severity: number;
	code?: string | number;
	source?: string;
	message: string;
}

/** The literal text a diagnostic range covers on its own source line. */
function coveredText(source: string, diagnostic: ReportedDiagnostic): string {
	const line = source.split("\n")[diagnostic.line - 1] ?? "";
	return line.slice(diagnostic.character, diagnostic.endCharacter);
}

/** The engine versions and workspace-path matches the LSP server logged. */
interface FixtureLogs {
	/** Versions reported by `Loaded tailwindcss vX.Y.Z`, one per initialized project. */
	workspaceVersions: string[];
	/** Whether each loaded engine resolved to the workspace's own tailwindcss. */
	workspacePathMatches: boolean[];
	/** Versions reported by `Using bundled version of tailwindcss`. */
	bundledVersions: string[];
}

describe("Tailwind fixture gate manifest", () => {
	it("pins the exact server and engine closure", async () => {
		const gate = resolve("test/real-servers/gates/tailwindcss");
		const manifest = JSON.parse(
			await readFile(join(gate, "package.json"), "utf8"),
		) as { dependencies?: Record<string, string> };
		const lock = JSON.parse(
			await readFile(join(gate, "package-lock.json"), "utf8"),
		) as { packages?: Record<string, unknown> };
		expect(manifest.dependencies).toEqual({
			"@tailwindcss/language-server": "0.16.0",
			tailwindcss: "4.3.3",
		});
		expect(
			lock.packages?.["node_modules/@tailwindcss/language-server"],
		).toEqual(
			expect.objectContaining({
				version: "0.16.0",
				resolved:
					"https://registry.npmjs.org/@tailwindcss/language-server/-/language-server-0.16.0.tgz",
				integrity:
					"sha512-ko2xr4nlFIkqwJFnnw7hfdpjbsnK0DOk+QEEI51tvKOCF97OG0RU59iGfadoaOoY6I9xkSMbTW+AAwgnGnLH3w==",
			}),
		);
		expect(lock.packages?.["node_modules/tailwindcss"]).toEqual(
			expect.objectContaining({
				version: "4.3.3",
				resolved:
					"https://registry.npmjs.org/tailwindcss/-/tailwindcss-4.3.3.tgz",
				integrity:
					"sha512-gOhV3P7ufE62QDGg1zVaTgCR+EtPv92k2nIhVcVKcLmxT1sUBsQGhnZj175j+MqRt4zLF7ic+sCYjfhxMxj7YQ==",
			}),
		);
		expect(Object.keys(lock.packages ?? {}).sort()).toEqual([
			"",
			"node_modules/@tailwindcss/language-server",
			"node_modules/tailwindcss",
		]);
		expect(await readFile(join(gate, "npmrc"), "utf8")).toBe(CONTROLLED_NPMRC);
		expect(await readFile(join(gate, "global-npmrc"), "utf8")).toBe(
			CONTROLLED_NPMRC,
		);
	});
});

describe.runIf(runReal)("Tailwind CSS language server 0.16.0", () => {
	let workspace: string | undefined;
	let pool: RuntimePool | undefined;
	let restoreOnRequest: (() => void) | undefined;
	let restoreLogs: (() => void) | undefined;

	afterEach(async () => {
		try {
			await pool?.shutdown();
		} finally {
			// Restore both spies and delete the exact workspace even when shutdown
			// throws, so neither leaks into the next test. Persistent cleanup
			// failures still surface here instead of being swallowed.
			restoreOnRequest?.();
			restoreLogs?.();
			pool = undefined;
			const activeWorkspace = workspace;
			workspace = undefined;
			restoreOnRequest = undefined;
			restoreLogs = undefined;
			if (activeWorkspace)
				await rm(activeWorkspace, {
					recursive: true,
					force: true,
					maxRetries: 10,
					retryDelay: 50,
				});
		}
	});

	function startFixture(
		root: string,
		serverCli: string,
		logs: FixtureLogs,
		expectedEngine: Promise<string> | undefined,
	) {
		let runtime: NodeLspRuntimeSession | undefined;
		let starts = 0;
		// The notification callback cannot await, so each module comparison it
		// starts stays here until the test drains it before asserting.
		const pendingComparisons: Promise<void>[] = [];
		const recordModuleMatch = async (modulePath: string): Promise<void> => {
			try {
				const expected = await expectedEngine;
				logs.workspacePathMatches.push(
					(await realpath(modulePath)) === expected,
				);
			} catch {
				logs.workspacePathMatches.push(false);
			}
		};
		const onLogMessage = (params: unknown): void => {
			const message = (params as { message?: unknown } | undefined)?.message;
			if (typeof message !== "string") return;
			const loaded = /Loaded tailwindcss v(\d+\.\d+\.\d+): (.+)$/.exec(message);
			if (loaded?.[1] && loaded[2]) {
				logs.workspaceVersions.push(loaded[1]);
				pendingComparisons.push(recordModuleMatch(loaded[2].trim()));
				return;
			}
			const bundled =
				/Using bundled version of `tailwindcss`: v(\d+\.\d+\.\d+)/.exec(
					message,
				);
			if (bundled?.[1]) logs.bundledVersions.push(bundled[1]);
		};
		// The engine version and module location arrive as LSP notifications,
		// never on stderr. Compare the reported module against the workspace engine
		// without retaining or printing its absolute path. The server can emit the
		// log during the initialize handshake, before NodeLspRuntimeSession.start
		// resolves, so subscribe through the connection as soon as it is
		// constructed. The first onNotification call is the DiagnosticCollector's,
		// which runs in the session constructor before initialize is sent and before
		// the event loop can deliver any server message.
		let logHandlerRegistered = false;
		const originalOnNotification = LspConnection.prototype.onNotification;
		const notificationSpy = vi
			.spyOn(LspConnection.prototype, "onNotification")
			.mockImplementation(function (
				this: LspConnection,
				method: string,
				handler: (params: unknown) => void,
			) {
				if (!logHandlerRegistered) {
					logHandlerRegistered = true;
					originalOnNotification.call(this, "window/logMessage", onLogMessage);
				}
				return originalOnNotification.call(this, method, handler);
			});
		restoreLogs = () => notificationSpy.mockRestore();

		const service = new TrustedOperationService({
			coordinator: () => undefined,
			pool: () => pool,
			load: async () => ({
				config: effectiveConfig(serverCli),
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
			runtime: () => runtime,
			starts: () => starts,
			settleLogs: async () => {
				// Await each comparison the async handler started, re-reading the list
				// after every await so one started by a log that arrived mid-drain is
				// awaited too. Stop once a pass observes no new comparison.
				let seen = -1;
				while (seen !== pendingComparisons.length) {
					seen = pendingComparisons.length;
					await Promise.all(pendingComparisons);
				}
			},
		};
	}

	/** Retry only the explicit cold-build timeout, never a missing publication. */
	async function diagnose(
		service: TrustedOperationService,
		ctx: never,
		filePath: string,
	) {
		let response = await diagnostics(service, ctx, { filePath }, undefined);
		for (
			let retry = 0;
			retry < 2 && response.details?.code === "diagnostics_timed_out";
			retry++
		) {
			response = await diagnostics(service, ctx, { filePath }, undefined);
		}
		if (response.details?.code !== "ok") {
			// Keep the failure free of stderr and absolute paths: the sanitizer does
			// not cover Linux temporary roots, so a path could reach the CI log.
			const text = response.content.find((item) => item.type === "text")?.text;
			throw new Error(
				`Tailwind diagnostics failed (${response.details?.code ?? "missing code"}): ${text ?? "<no message>"}`,
			);
		}
		return value(response);
	}

	it("loads the workspace engine and reports class conflicts in one session", async () => {
		if (!cli || !isAbsolute(cli))
			throw new Error("TAILWIND_CLI must be an absolute server path.");
		// The workspace stays outside the checkout so a missing transitive package
		// cannot fall back to the repository's own node_modules.
		workspace = await mkdtemp(join(tmpdir(), "pi-lsp-tailwind-real-"));
		const root = workspace;
		const modules = resolve(dirname(await realpath(cli)), "..", "..", "..");
		const enginePackage = join(modules, "tailwindcss");
		const engineManifest = JSON.parse(
			await readFile(join(enginePackage, "package.json"), "utf8"),
		) as { version?: string };
		expect(engineManifest.version).toBe("4.3.3");
		await mkdir(join(root, "src"));
		await mkdir(join(root, "node_modules"));
		await symlink(
			enginePackage,
			join(root, "node_modules", "tailwindcss"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({
				name: "tailwindcss-real-fixture",
				private: true,
				dependencies: { tailwindcss: "4.3.3" },
			}),
		);
		// The server discovers the Tailwind project from this CSS entry point.
		await writeFile(join(root, "src", "app.css"), '@import "tailwindcss";\n');
		const htmlConflict = join(root, "src", "index.html");
		const vueConflict = join(root, "src", "App.vue");
		const htmlClean = join(root, "src", "Clean.html");
		await writeFile(htmlConflict, HTML_CONFLICT);
		await writeFile(vueConflict, VUE_CONFLICT);
		await writeFile(htmlClean, HTML_CLEAN);

		// Record the dynamic registrations the server requests. The client answers
		// null to an empty list and rejects anything else, so a non-empty request
		// here means the connection would break: fail instead of pretending the
		// client supports dynamic registration.
		const registrationLists: unknown[] = [];
		const originalOnRequest = LspConnection.prototype.onRequest;
		const spy = vi
			.spyOn(LspConnection.prototype, "onRequest")
			.mockImplementation(function (
				this: LspConnection,
				method: string,
				handler: (params: unknown) => unknown,
			) {
				if (method !== "client/registerCapability")
					return originalOnRequest.call(this, method, handler);
				return originalOnRequest.call(this, method, (params: unknown) => {
					registrationLists.push(
						(params as { registrations?: unknown } | undefined)?.registrations,
					);
					return handler(params);
				});
			});
		restoreOnRequest = () => spy.mockRestore();

		pool = new RuntimePool();
		const logs: FixtureLogs = {
			workspaceVersions: [],
			workspacePathMatches: [],
			bundledVersions: [],
		};
		const expectedEngine = realpath(join(root, "node_modules", "tailwindcss"));
		const fixture = startFixture(root, cli, logs, expectedEngine);
		const service = fixture.service;
		const ctx = {
			cwd: root,
			signal: undefined,
			isProjectTrusted: () => true,
		} as never;
		const run = (filePath: string) => diagnose(service, ctx, filePath);

		// An untrusted project must never spawn or install anything.
		const untrusted = {
			cwd: root,
			signal: undefined,
			isProjectTrusted: () => false,
		} as never;
		const denied = await diagnostics(
			service,
			untrusted,
			{ filePath: htmlConflict },
			undefined,
		);
		expect(denied.content.find((item) => item.type === "text")?.text).toContain(
			"untrusted_project",
		);
		expect(fixture.starts()).toBe(0);

		const html = (await run(htmlConflict)).diagnostics as
			| ReportedDiagnostic[]
			| undefined;
		if (!html) throw new Error("Missing HTML diagnostics.");
		expect(html).toHaveLength(2);
		for (const diagnostic of html) {
			expect(diagnostic.code).toBe("cssConflict");
			expect(diagnostic.source).toBe("tailwindcss");
			expect(diagnostic.severity).toBe(2);
			expect(diagnostic.line).toBe(1);
		}
		// Each range stays inside its own class token.
		expect(html.map((item) => coveredText(HTML_CONFLICT, item)).sort()).toEqual(
			["p-2", "p-4"],
		);

		const vue = (await run(vueConflict)).diagnostics as
			| ReportedDiagnostic[]
			| undefined;
		if (!vue) throw new Error("Missing Vue diagnostics.");
		expect(vue).toHaveLength(2);
		for (const diagnostic of vue) {
			expect(diagnostic.code).toBe("cssConflict");
			expect(diagnostic.source).toBe("tailwindcss");
			expect(diagnostic.severity).toBe(2);
			expect(diagnostic.line).toBe(2);
		}
		expect(vue.map((item) => coveredText(VUE_CONFLICT, item)).sort()).toEqual([
			"p-2",
			"p-4",
		]);

		// An `ok` empty result means the collector observed an empty publication
		// after this document opened; a missing publication would time out instead.
		expect((await run(htmlClean)).diagnostics).toEqual([]);

		// Three documents, one reused process: the no-op registration keeps didOpen
		// and didChange listeners alive for every document in the session.
		expect(fixture.starts()).toBe(1);
		expect(pool.size()).toBe(1);

		expect(
			fixture.runtime()?.session.capabilities.diagnosticProvider,
		).toBeUndefined();
		await vi.waitFor(
			() => expect(logs.workspaceVersions.length).toBeGreaterThan(0),
			{ timeout: 10_000 },
		);
		expect(logs.workspaceVersions).toContain("4.3.3");
		// The loaded engine must be the workspace's own package, resolved through
		// the symlink, not a version string alone. The version wait above and the
		// diagnose responses pin the ordering: the server loads the engine, and
		// logs it, before it can report the cssConflict diagnostics already awaited,
		// and the client dispatches notifications in stream order. Drain the
		// comparisons the async log handler started, then require one verdict per
		// reported version, so no comparison is left pending here.
		await fixture.settleLogs();
		await vi.waitFor(
			() =>
				expect(logs.workspacePathMatches.length).toBe(
					logs.workspaceVersions.length,
				),
			{ timeout: 10_000 },
		);
		expect(logs.workspacePathMatches).toContain(true);
		expect(logs.workspacePathMatches.every(Boolean)).toBe(true);
		expect(logs.bundledVersions).toEqual([]);
		expect(fixture.runtime()?.sanitizedStderr ?? "").not.toContain(
			"tailwindcss v4",
		);
		await vi.waitFor(
			() => expect(registrationLists.length).toBeGreaterThan(0),
			{ timeout: 10_000 },
		);
		for (const registrations of registrationLists)
			expect(registrations).toEqual([]);

		const cancelled = new AbortController();
		const pending = diagnostics(
			service,
			ctx,
			{ filePath: htmlConflict },
			cancelled.signal,
		);
		cancelled.abort();
		const aborted = await pending;
		expect(aborted.details?.code).toBe("cancelled");

		// No managed state appeared: the run never installed anything.
		await expect(stat(join(root, "managed"))).rejects.toThrow();

		await pool.shutdown();
		expect(pool.activeServerIds()).toEqual([]);
		expect(pool.size()).toBe(0);
	}, 180_000);

	it("falls back to the bundled engine when the workspace has no tailwindcss", async () => {
		if (!cli || !isAbsolute(cli))
			throw new Error("TAILWIND_CLI must be an absolute server path.");
		// A separate synthetic workspace without node_modules/tailwindcss: the
		// server must load its bundled engine instead of a project engine.
		workspace = await mkdtemp(join(tmpdir(), "pi-lsp-tailwind-real-"));
		const root = workspace;
		await mkdir(join(root, "src"));
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({
				name: "tailwindcss-real-fallback",
				private: true,
				dependencies: {},
			}),
		);
		await writeFile(join(root, "src", "app.css"), '@import "tailwindcss";\n');
		const htmlConflict = join(root, "src", "index.html");
		await writeFile(htmlConflict, HTML_CONFLICT);

		pool = new RuntimePool();
		const logs: FixtureLogs = {
			workspaceVersions: [],
			workspacePathMatches: [],
			bundledVersions: [],
		};
		const fixture = startFixture(root, cli, logs, undefined);
		const service = fixture.service;
		const ctx = {
			cwd: root,
			signal: undefined,
			isProjectTrusted: () => true,
		} as never;

		const html = (await diagnose(service, ctx, htmlConflict)).diagnostics as
			| ReportedDiagnostic[]
			| undefined;
		if (!html) throw new Error("Missing HTML diagnostics.");

		// The bundled engine still reports the conflict, but the workspace engine
		// is absent: the fixture claims no project support and promotes no candidate.
		expect(html).toHaveLength(2);
		for (const diagnostic of html) {
			expect(diagnostic.code).toBe("cssConflict");
			expect(diagnostic.source).toBe("tailwindcss");
		}

		await vi.waitFor(
			() => expect(logs.bundledVersions.length).toBeGreaterThan(0),
			{ timeout: 10_000 },
		);
		expect(logs.bundledVersions).toContain("4.1.18");
		await fixture.settleLogs();
		expect(logs.workspaceVersions).toEqual([]);
		expect(logs.workspacePathMatches).toEqual([]);
		// With no workspace engine the server must not create a package tree of
		// its own: no node_modules and no lockfile appear in the workspace.
		await expect(stat(join(root, "node_modules"))).rejects.toThrow();
		await expect(stat(join(root, "package-lock.json"))).rejects.toThrow();

		expect(fixture.starts()).toBe(1);
		expect(pool.size()).toBe(1);
		await pool.shutdown();
		expect(pool.activeServerIds()).toEqual([]);
		expect(pool.size()).toBe(0);
	}, 180_000);
});
