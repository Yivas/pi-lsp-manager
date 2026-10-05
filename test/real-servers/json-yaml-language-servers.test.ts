import {
	spawn,
	type ChildProcess,
	type SpawnOptions,
} from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../src/config/load.js";
import type { EffectiveConfig } from "../../src/contracts.js";
import {
	NodeLspRuntimeSession,
	type SpawnLspProcess,
} from "../../src/protocol/process.js";
import { RuntimePool } from "../../src/runtime/pool.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import { TrustedOperationService } from "../../src/tools/shared.js";
import { afterEach, describe, expect, it } from "vitest";

// Real-format gating. RUN_REAL_JSON and RUN_REAL_YAML enable one format each and
// require only that format's CLI. RUN_REAL_FORMATS enables both and migrates the
// previous unit, where the flag enabled the JSON case alone.
const runFormats = process.env.RUN_REAL_FORMATS === "1";
const runJson = runFormats || process.env.RUN_REAL_JSON === "1";
const runYaml = runFormats || process.env.RUN_REAL_YAML === "1";
const jsonCli = process.env.JSON_LSP_CLI;
const yamlCli = process.env.YAML_LSP_CLI;
if (runJson && !jsonCli)
	throw new Error(
		"JSON_LSP_CLI is required when RUN_REAL_JSON=1 or RUN_REAL_FORMATS=1.",
	);
if (runYaml && !yamlCli)
	throw new Error(
		"YAML_LSP_CLI is required when RUN_REAL_YAML=1 or RUN_REAL_FORMATS=1.",
	);

interface TrackedChild {
	closed: boolean;
	close: Promise<void>;
}

/** Records one owned child so a test can prove it closed without reading stdio. */
function trackSpawn(
	children: TrackedChild[],
): (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess {
	return (command, args, options) => {
		const child = spawn(command, args, options);
		let resolveClose!: () => void;
		const record: TrackedChild = {
			closed: false,
			close: new Promise<void>((resolveCloseEvent) => {
				resolveClose = resolveCloseEvent;
			}),
		};
		child.once("close", () => {
			record.closed = true;
			resolveClose();
		});
		children.push(record);
		return child;
	};
}

// The diagnostics tool reports per-server failures next to `files`, so a request
// that failed (missing tool, unsupported method, transport error) also arrives
// as empty diagnostics. `failures` is checked before any `files` entry is read
// so such a failure is never mistaken for a genuinely clean file.
function decodeDiagnostics(result: {
	content: readonly { type: string; text?: string }[];
}) {
	const text = result.content.find((item) => item.type === "text")?.text;
	if (!text) throw new Error("Expected a text result.");
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch {
		throw new Error("Could not parse the diagnostics response.");
	}
	if (typeof decoded !== "object" || decoded === null)
		throw new Error("Unexpected diagnostics response shape.");
	const { files, failures } = decoded as {
		files?: unknown;
		failures?: unknown;
	};
	if (!Array.isArray(files) || !Array.isArray(failures))
		throw new Error("Unexpected diagnostics response shape.");
	if (failures.length > 0) {
		const codes = failures
			.map((entry) => {
				const code =
					entry !== null && typeof entry === "object" && "code" in entry
						? (entry as { code: unknown }).code
						: undefined;
				return typeof code === "string" ? code : "unknown";
			})
			.join(", ");
		throw new Error(`The diagnostics request failed: ${codes}.`);
	}
	return { files } as {
		files?: readonly {
			servers: readonly {
				serverId: string;
				diagnostics: readonly {
					line: number;
					character: number;
					message: string;
				}[];
			}[];
		}[];
	};
}

// The diagnostics tool projects LSP positions into its own report: the line is
// 1-based (it adds one to the LSP start line) while the character stays 0-based.
// Each expected position below comes from its fixture text and is confirmed only
// by an opt-in RUN_REAL_JSON / RUN_REAL_YAML run, never by the type check.
function expectStringTypeErrorAt(
	reports: readonly { line: number; character: number; message: string }[],
	position: { line: number; character: number },
) {
	expect(reports).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				line: position.line,
				character: position.character,
				message: expect.stringMatching(/string/i),
			}),
		]),
	);
}

async function childrenClosed(
	children: readonly TrackedChild[],
): Promise<boolean> {
	if (children.every((child) => child.closed)) return true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.all(children.map((child) => child.close)).then(() => true),
			new Promise<boolean>((resolveTimeout) => {
				timer = setTimeout(() => resolveTimeout(false), 2_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe.runIf(runJson)("JSON and JSONC language server", () => {
	let workspace: string | undefined;
	let pool: RuntimePool | undefined;
	const children: TrackedChild[] = [];

	afterEach(async () => {
		let shutdownFailed = false;
		let shutdownError: unknown;
		try {
			await pool?.shutdown();
		} catch (error) {
			shutdownFailed = true;
			shutdownError = error;
		}
		pool = undefined;
		if (!(await childrenClosed(children)))
			throw new Error(
				"LSP child close was not observed; preserving the owned fixture workspace.",
			);
		const ownedWorkspace = workspace;
		workspace = undefined;
		if (ownedWorkspace)
			await rm(ownedWorkspace, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 50,
			});
		if (shutdownFailed) throw shutdownError;
	});

	it("validates local JSON schemas and accepts JSONC", async () => {
		if (!jsonCli) throw new Error("Missing JSON_LSP_CLI path.");
		workspace = await mkdtemp(join(tmpdir(), "pi-lsp-json-yaml-real-"));
		const root = workspace;
		const jsonSchema = join(root, "json-schema.json");
		const schema = JSON.stringify({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			required: ["name"],
			properties: {
				$schema: { type: "string" },
				name: { type: "string" },
			},
			additionalProperties: false,
		});
		await writeFile(jsonSchema, schema, "utf8");
		const jsonInvalid = join(root, "invalid.json");
		const jsonClean = join(root, "clean.json");
		const jsoncClean = join(root, "clean.jsonc");
		// `"name": 42` is on LSP line 2 (0-based), so the tool reports line 3;
		// `42` starts at character 10 (0-based).
		await writeFile(
			jsonInvalid,
			'{\n  "$schema": "./json-schema.json",\n  "name": 42\n}\n',
			"utf8",
		);
		await writeFile(
			jsonClean,
			JSON.stringify({ $schema: "./json-schema.json", name: "valid" }),
			"utf8",
		);
		await writeFile(
			jsoncClean,
			'{\n  "$schema": "./json-schema.json",\n  "name": "valid" // JSONC comment\n}\n',
			"utf8",
		);

		const config: EffectiveConfig = {
			version: 1,
			network: "offline",
			autoInstall: false,
			postEditDiagnostics: false,
			servers: {
				"vscode-json-language-server": {
					id: "vscode-json-language-server",
					enabled: true,
					autoInstall: false,
					priority: 100,
					command: process.execPath,
					args: [resolve(jsonCli), "--stdio"],
					extensions: [".json", ".jsonc"],
					roles: ["diagnostics"],
					languageIds: ["json", "jsonc"],
					languageIdByExtension: { ".json": "json", ".jsonc": "jsonc" },
					admission: "candidate",
					manualHelp: "Install vscode-langservers-extracted 4.10.0.",
					// The server disables validation when the client sends no settings:
					// `validateEnabled = !!settings.json?.validate?.enable` in its
					// `onDidChangeConfiguration`. These are the global per-server
					// settings, mirroring the YAML case below.
					settings: { json: { validate: { enable: true } } },
				},
			},
		};
		pool = new RuntimePool();
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
			start: (options) =>
				NodeLspRuntimeSession.start({
					...options,
					requestTimeoutMs: 30_000,
					spawnProcess: trackSpawn(children) as SpawnLspProcess,
				}),
		});
		const ctx = {
			cwd: root,
			signal: undefined,
			isProjectTrusted: () => true,
		} as never;
		const serverId = "vscode-json-language-server";

		const invalidResult = decodeDiagnostics(
			await diagnostics(
				service,
				ctx,
				{ filePath: jsonInvalid, servers: [serverId] },
				undefined,
			),
		);
		const invalidReports = invalidResult.files?.[0]?.servers.find(
			(server) => server.serverId === serverId,
		)?.diagnostics;
		expectStringTypeErrorAt(invalidReports ?? [], {
			line: 3,
			character: 10,
		});

		for (const filePath of [jsonClean, jsoncClean]) {
			const cleanResult = decodeDiagnostics(
				await diagnostics(
					service,
					ctx,
					{ filePath, servers: [serverId] },
					undefined,
				),
			);
			expect(cleanResult.files?.[0]?.servers).toEqual([
				{ serverId, diagnostics: [] },
			]);
		}
		expect(children).toHaveLength(1);
	}, 60_000);
});

describe.runIf(runYaml)("YAML language server", () => {
	let workspace: string | undefined;
	let pool: RuntimePool | undefined;
	const children: TrackedChild[] = [];

	afterEach(async () => {
		let shutdownFailed = false;
		let shutdownError: unknown;
		try {
			await pool?.shutdown();
		} catch (error) {
			shutdownFailed = true;
			shutdownError = error;
		}
		pool = undefined;
		if (!(await childrenClosed(children)))
			throw new Error(
				"LSP child close was not observed; preserving the owned fixture workspace.",
			);
		const ownedWorkspace = workspace;
		workspace = undefined;
		if (ownedWorkspace)
			await rm(ownedWorkspace, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 50,
			});
		if (shutdownFailed) throw shutdownError;
	});

	it("serves local schema settings through workspace/configuration", async () => {
		if (!yamlCli) throw new Error("Missing YAML_LSP_CLI path.");
		workspace = await mkdtemp(join(tmpdir(), "pi-lsp-json-yaml-real-"));
		const root = workspace;
		const yamlSchema = join(root, "yaml-schema.json");
		await writeFile(
			yamlSchema,
			JSON.stringify({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				required: ["name"],
				properties: { name: { type: "string" } },
				additionalProperties: false,
			}),
			"utf8",
		);
		const yamlInvalid = join(root, "invalid.yaml");
		const yamlClean = join(root, "clean.yaml");
		// `name: 42` is on LSP line 0 (0-based), so the tool reports line 1;
		// `42` starts at character 6 (0-based).
		await writeFile(yamlInvalid, "name: 42\n", "utf8");
		await writeFile(yamlClean, "name: valid\n", "utf8");

		// Settings, including `schemaStore.enable: false`, arrive through the real
		// global-config loader. An owned agent directory keeps the user profile and
		// its personal settings out of the run; nothing is passed as initialization.
		const agentDirectory = join(root, "agent");
		await mkdir(agentDirectory, { recursive: true });
		await writeFile(
			join(agentDirectory, "pi-lsp-manager.json"),
			JSON.stringify({
				version: 1,
				servers: {
					"yaml-language-server": {
						command: process.execPath,
						args: [resolve(yamlCli), "--stdio"],
						settings: {
							yaml: {
								schemaStore: { enable: false },
								schemas: { [pathToFileURL(yamlSchema).href]: "*.yaml" },
							},
						},
					},
				},
			}),
			"utf8",
		);

		pool = new RuntimePool();
		const service = new TrustedOperationService({
			coordinator: () => undefined,
			pool: () => pool,
			load: (options) => loadConfig({ ...options, agentDirectory }),
			resolveCommand: async () => process.execPath,
			start: (options) =>
				NodeLspRuntimeSession.start({
					...options,
					requestTimeoutMs: 30_000,
					spawnProcess: trackSpawn(children) as SpawnLspProcess,
				}),
		});
		const ctx = {
			cwd: root,
			signal: undefined,
			isProjectTrusted: () => true,
		} as never;
		const serverId = "yaml-language-server";

		const invalidResult = decodeDiagnostics(
			await diagnostics(
				service,
				ctx,
				{ filePath: yamlInvalid, servers: [serverId] },
				undefined,
			),
		);
		const invalidReports = invalidResult.files?.[0]?.servers.find(
			(server) => server.serverId === serverId,
		)?.diagnostics;
		expectStringTypeErrorAt(invalidReports ?? [], {
			line: 1,
			character: 6,
		});

		const cleanResult = decodeDiagnostics(
			await diagnostics(
				service,
				ctx,
				{ filePath: yamlClean, servers: [serverId] },
				undefined,
			),
		);
		expect(cleanResult.files?.[0]?.servers).toEqual([
			{ serverId, diagnostics: [] },
		]);
		expect(children).toHaveLength(1);
	}, 60_000);
});
