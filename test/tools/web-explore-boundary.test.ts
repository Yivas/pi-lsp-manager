import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import type { EffectiveConfig } from "../../src/contracts.js";
import { evaluateInstallPolicy } from "../../src/install/policy.js";
import { discoverFiles } from "../../src/resolve/discover.js";
import { TransientRuntimeError } from "../../src/runtime/retry.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import { status } from "../../src/tools/status.js";
import {
	type SafeServerStatus,
	TrustedOperationService,
} from "../../src/tools/shared.js";

interface WebCandidate {
	id: "vue" | "tailwindcss" | "eslint";
	command: string;
	file: string;
	content: string;
}

/** Each file resolves to the listed candidate as the diagnostics principal. */
const WEB_CANDIDATES: readonly WebCandidate[] = [
	{
		id: "vue",
		command: "vue-language-server",
		file: "Component.vue",
		content: "<template><div /></template>\n",
	},
	{
		id: "tailwindcss",
		command: "tailwindcss-language-server",
		file: "Panel.svelte",
		content: '<div class="p-2" />\n',
	},
	{
		id: "eslint",
		command: "vscode-eslint-language-server",
		file: "Notes.md",
		content: "# Notes\n",
	},
];

const WEB_FILES = WEB_CANDIDATES.map((candidate) => candidate.file);

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 50,
		});
	}
});

async function writeWebFiles(root: string): Promise<void> {
	for (const candidate of WEB_CANDIDATES)
		await writeFile(join(root, candidate.file), candidate.content, "utf8");
}

function context(cwd: string, trusted: boolean): ExtensionContext {
	return {
		cwd,
		signal: undefined,
		isProjectTrusted: () => trusted,
	} as unknown as ExtensionContext;
}

function text(result: {
	content: readonly { type: string; text?: string }[];
}): Record<string, unknown> {
	const content = result.content[0];
	if (!content || content.type !== "text") throw new Error("Expected text.");
	return JSON.parse(content.text ?? "") as Record<string, unknown>;
}

interface HarnessOptions {
	root: string;
	network: "auto" | "offline";
	autoInstall: boolean;
	resolveCommand?: (command: string) => Promise<string | undefined>;
}

interface Harness {
	service: TrustedOperationService;
	config: EffectiveConfig;
	load: ReturnType<typeof vi.fn>;
	coordinator: ReturnType<typeof vi.fn>;
	pool: ReturnType<typeof vi.fn>;
	start: ReturnType<typeof vi.fn>;
	resolveCommand: ReturnType<typeof vi.fn>;
}

function createWebHarness(options: HarnessOptions): Harness {
	const config = createDefaultConfig();
	config.network = options.network;
	config.autoInstall = options.autoInstall;
	for (const candidate of WEB_CANDIDATES) {
		const server = config.servers[candidate.id];
		if (!server)
			throw new Error(`${candidate.id} is missing from the default catalog.`);
		server.enabled = true;
		server.autoInstall = options.autoInstall;
	}
	const coordinator = vi.fn();
	const pool = vi.fn();
	const start = vi.fn();
	const resolveCommand = vi.fn(
		options.resolveCommand ?? (async () => undefined),
	);
	const load = vi.fn(async () => ({
		config,
		paths: {
			globalConfigPath: join(options.root, "global.json"),
			projectConfigPath: join(options.root, "project.json"),
			managedStatePath: join(options.root, "managed"),
		},
		globalLayer: "absent" as const,
		projectLayer: "absent" as const,
	}));
	const service = new TrustedOperationService({
		coordinator,
		pool,
		start,
		resolveCommand,
		load,
	});
	return {
		service,
		config,
		load,
		coordinator,
		pool,
		start,
		resolveCommand,
	};
}

/** Exploration may read the workspace but must never create managed state. */
async function expectUntouchedWorkspace(
	root: string,
	expected: readonly string[],
): Promise<void> {
	expect((await readdir(root)).sort()).toEqual([...expected].sort());
	await expect(access(join(root, "managed"))).rejects.toThrow();
	await expect(
		access(join(root, "managed", "audit", "install.audit.jsonl")),
	).rejects.toThrow();
}

const MATRIX = WEB_CANDIDATES.flatMap((candidate) =>
	(["auto", "offline"] as const).flatMap((network) =>
		[true, false].flatMap((autoInstall) =>
			[true, false].map((trusted) => ({
				candidate,
				network,
				autoInstall,
				trusted,
			})),
		),
	),
);

describe("web exploration matrix", () => {
	it.each(MATRIX)(
		"reads $candidate.id under $network/autoInstall=$autoInstall/trusted=$trusted closed and side-effect free",
		async ({ candidate, network, autoInstall, trusted }) => {
			const root = await temporaryDirectory("pi-lsp-web-read-");
			await writeWebFiles(root);
			const harness = createWebHarness({ root, network, autoInstall });
			await expect(
				harness.service.read(
					context(root, trusted),
					candidate.file,
					"diagnostics",
					async (operation) => operation.server.id,
				),
			).rejects.toMatchObject({
				code: trusted ? "server_unavailable" : "untrusted_project",
			});
			// The trust check precedes configuration; the policy denial follows the
			// network and recipe checks before trust.
			if (trusted) {
				expect(harness.load).toHaveBeenCalledTimes(1);
				expect(harness.resolveCommand).toHaveBeenCalledWith(
					candidate.command,
					process.env,
					process.platform,
				);
			} else {
				expect(harness.load).not.toHaveBeenCalled();
				expect(harness.resolveCommand).not.toHaveBeenCalled();
			}
			const decision = evaluateInstallPolicy({
				origin: "tool",
				serverId: candidate.id,
				globalConfig: harness.config,
				projectConfig: harness.config,
				projectTrusted: trusted,
				platform: process.platform,
				architecture: process.arch,
			});
			expect(decision.allowed).toBe(false);
			if (!decision.allowed)
				expect(decision.reason).toBe(
					network === "offline" ? "offline" : "recipe_missing",
				);
			expect(harness.coordinator).not.toHaveBeenCalled();
			expect(harness.pool).not.toHaveBeenCalled();
			expect(harness.start).not.toHaveBeenCalled();
			await expectUntouchedWorkspace(root, WEB_FILES);
		},
	);

	it("discovers and scans every web file without installing or spawning", async () => {
		for (const network of ["auto", "offline"] as const) {
			for (const autoInstall of [true, false]) {
				for (const trusted of [true, false]) {
					const label = `${network}/autoInstall=${autoInstall}/trusted=${trusted}`;
					const root = await temporaryDirectory("pi-lsp-web-scan-");
					await writeWebFiles(root);
					const discovered = await discoverFiles({
						workspacePath: root,
						paths: ["."],
					});
					expect(
						discovered.files.map((file) => file.relativePath).sort(),
						label,
					).toEqual([...WEB_FILES].sort());
					const harness = createWebHarness({ root, network, autoInstall });
					const result = await diagnostics(
						harness.service,
						context(root, trusted),
						{ paths: ["."] },
						undefined,
					);
					if (trusted) {
						const output = text(result) as {
							filesScanned: number;
							serversUsed: string[];
							failures: { code: string }[];
						};
						expect(output.filesScanned, label).toBe(WEB_FILES.length);
						expect(output.serversUsed, label).toEqual([]);
						expect(
							output.failures.map((failure) => failure.code),
							label,
						).toEqual(WEB_FILES.map(() => "server_unavailable"));
						expect(harness.load, label).toHaveBeenCalledTimes(1);
					} else {
						expect(result.details?.code, label).toBe("untrusted_project");
						expect(harness.load, label).not.toHaveBeenCalled();
					}
					expect(harness.coordinator, label).not.toHaveBeenCalled();
					expect(harness.pool, label).not.toHaveBeenCalled();
					expect(harness.start, label).not.toHaveBeenCalled();
					await expectUntouchedWorkspace(root, WEB_FILES);
				}
			}
		}
	});

	it("lists the web candidates as unavailable and not installable", async () => {
		const root = await temporaryDirectory("pi-lsp-web-status-");
		await writeWebFiles(root);
		for (const trusted of [true, false]) {
			const harness = createWebHarness({
				root,
				network: "auto",
				autoInstall: true,
			});
			const result = await status(
				harness.service,
				context(root, trusted),
				undefined,
			);
			const output = text(result) as {
				trusted: boolean;
				servers: SafeServerStatus[];
			};
			expect(output.trusted).toBe(trusted);
			for (const candidate of WEB_CANDIDATES) {
				const row = output.servers.find((item) => item.id === candidate.id);
				expect(row, candidate.id).toMatchObject({
					enabled: true,
					available: false,
					runnable: false,
					admission: "candidate",
					autoInstall: true,
					routeConfigured: true,
					recipePresent: false,
					installable: false,
					runtime: "inactive",
				});
			}
			// Listing reports state; it may read the pool but never install or spawn.
			expect(harness.coordinator).not.toHaveBeenCalled();
			expect(harness.start).not.toHaveBeenCalled();
			await expectUntouchedWorkspace(root, WEB_FILES);
		}
	});
});

describe("web auxiliary boundaries", () => {
	it("never grants install rights to a web auxiliary and never lets it block the principal", async () => {
		const root = await temporaryDirectory("pi-lsp-web-auxiliary-");
		await writeWebFiles(root);
		for (const auxiliaryAvailable of [false, true]) {
			const label = `tailwindcss available: ${auxiliaryAvailable}`;
			const harness = createWebHarness({
				root,
				network: "auto",
				autoInstall: true,
				resolveCommand: async (command) =>
					command === "vue-language-server" ||
					(auxiliaryAvailable && command === "tailwindcss-language-server")
						? `/available/${command}`
						: undefined,
			});
			// The process transport is substituted, so this case proves only the
			// selection and the install argument each call receives: the coordinator
			// and the managed state are unreachable from the replacement. The matrix
			// above and the unstubbed case below assert the install effects.
			const withFile = vi
				.spyOn(harness.service, "withFile")
				.mockImplementation(async (...args) => {
					const server = args[6];
					if (!server) throw new Error("Expected a selected server.");
					if (server.id === "tailwindcss")
						throw new TransientRuntimeError("LSP transport closed.");
					return server.id as never;
				});
			const results = await harness.service.readDiagnostics(
				context(root, true),
				join(root, "Component.vue"),
				async (operation) => operation.server.id,
			);
			expect(
				results.map((entry) => entry.serverId),
				label,
			).toEqual(["vue"]);
			expect(withFile.mock.calls[0]?.[7], label).toBe(true);
			// A transient auxiliary failure is retried once; every auxiliary attempt
			// still runs without install rights and the principal result survives.
			const auxiliaryCalls = withFile.mock.calls.slice(1);
			expect(auxiliaryCalls.length, label).toBe(auxiliaryAvailable ? 2 : 0);
			for (const call of auxiliaryCalls) {
				expect(call[6]?.id, label).toBe("tailwindcss");
				expect(call[7], label).toBe(false);
			}
		}
	});

	it("fails a missing auxiliary route without install or spawn", async () => {
		const root = await temporaryDirectory("pi-lsp-web-auxiliary-missing-");
		await writeWebFiles(root);
		const harness = createWebHarness({
			root,
			network: "auto",
			autoInstall: true,
		});
		const server = harness.config.servers.tailwindcss;
		if (!server) throw new Error("Tailwind entry is required.");
		// The missing route is rejected before an install could run. Whether the
		// policy was consulted is not observable here: server_unavailable is the
		// same code either way, so only the reachable effects are asserted.
		await expect(
			harness.service.withFile(
				context(root, true),
				"Panel.svelte",
				"diagnostics",
				"tool",
				async () => "unused",
				undefined,
				server,
				false,
			),
		).rejects.toMatchObject({ code: "server_unavailable" });
		expect(harness.coordinator).not.toHaveBeenCalled();
		expect(harness.pool).not.toHaveBeenCalled();
		expect(harness.start).not.toHaveBeenCalled();
		await expectUntouchedWorkspace(root, WEB_FILES);
	});

	it("grants a missing auxiliary route install rights and still never reaches the coordinator", async () => {
		const root = await temporaryDirectory(
			"pi-lsp-web-auxiliary-missing-rights-",
		);
		await writeWebFiles(root);
		const harness = createWebHarness({
			root,
			network: "auto",
			autoInstall: true,
		});
		const server = harness.config.servers.tailwindcss;
		if (!server) throw new Error("Tailwind entry is required.");
		// Unlike the case above, this call grants install rights, so an install would
		// run if the missing auxiliary route still reached it. The coordinator spy
		// discriminates that: it is never called and the workspace stays untouched.
		// Which policy reason the denial carries is not observable here and is left
		// to the real policy matrix.
		await expect(
			harness.service.withFile(
				context(root, true),
				"Panel.svelte",
				"diagnostics",
				"tool",
				async () => "unused",
				undefined,
				server,
				true,
			),
		).rejects.toMatchObject({ code: "server_unavailable" });
		expect(harness.coordinator).not.toHaveBeenCalled();
		expect(harness.pool).not.toHaveBeenCalled();
		expect(harness.start).not.toHaveBeenCalled();
		await expectUntouchedWorkspace(root, WEB_FILES);
	});
});
