// Real SDK format scenario, executed as one isolated Node child.
//
// The child owns every directory it touches, installs a spawn guard before the SDK is
// imported, loads the published extension through the SDK's public resource loader and
// drives one session through the real nested tool pipeline for the JSON and YAML format
// servers. It never selects a model, never contacts a provider and never reads a personal
// config: PI_CODING_AGENT_DIR points at its own agent directory from birth.
//
// One synthetic assistant message is appended to the in-memory session *before* the runtime
// exists: the SDK's nested-call path requires the calling assistant message
// (`_findLastAssistantMessage`), so this seed is the minimum preloaded history that lets
// `ctx.executeTool()` reach the real tool pipeline. It is not a model turn: no provider is
// selected, no generation happens and no outer tool result is fabricated.
//
// Every owned resource created after the first fixture directory shares one cleanup scope:
// the runtime is disposed, the observed children are awaited and the HTTP listener is closed
// even when an earlier step failed. The sidecar carries only a bounded phase token and error
// code, never a raw SDK exception, payload or absolute binary path.

import childProcess from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNNER_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = resolve(RUNNER_DIRECTORY, "../../src/index.ts");
const JSON_SERVER_ID = "vscode-json-language-server";
const YAML_SERVER_ID = "yaml-language-server";
const SCHEMA_PATH = "/schema.json";
const RESULT_NAME = "result.json";
const RECEIVE_DEADLINE_MS = 30_000;
const SETTLE_DEADLINE_MS = 30_000;
// The synthetic caller id never collides with the ids the SDK generates for nested calls
// (`<parent>/1`, `<parent>/2`, ...).
const SEED_TOOL_CALL_ID = "call_sdk_fixture_parent_1";

/** Builds an error whose phase and code are the only failure facts the sidecar keeps. */
function scenarioError(phase, code, message) {
	return Object.assign(new Error(message), { phase, code });
}

const observedSpawns = [];
let rejectedCommands = 0;

/**
 * Classifies a spawn request against the only commands this scenario may start, keeping a
 * PID in memory so a Windows `taskkill` helper must target a language server this process
 * already observed and has not closed, with the exact argv the product builds.
 */
function classifyAllowedSpawn(command, argv) {
	if (
		command === process.execPath &&
		argv.length === 2 &&
		(argv[0] === jsonCli || argv[0] === yamlCli) &&
		argv[1] === "--stdio"
	)
		return "language-server";
	const ownedHelper =
		process.platform === "win32" &&
		command === "taskkill" &&
		argv.length === 4 &&
		argv[0] === "/pid" &&
		argv[2] === "/t" &&
		argv[3] === "/f" &&
		observedSpawns.some(
			(record) =>
				record.kind === "language-server" &&
				!record.closed &&
				String(record.pid) === String(argv[1]),
		);
	return ownedHelper ? "helper" : undefined;
}

/**
 * Refuses anything that is not a known language server or its own Windows helper *before*
 * the real `spawn` runs, records `close` before returning the child, and forwards the
 * original `this`, arguments and options unchanged.
 */
const originalSpawn = childProcess.spawn;
childProcess.spawn = function observedSpawn(command, args, options) {
	const argv = Array.isArray(args) ? args.map(String) : [];
	const kind = classifyAllowedSpawn(String(command), argv);
	if (!kind) {
		rejectedCommands += 1;
		throw scenarioError("spawn", "unexpected_command", "An unapproved command was rejected before spawn.");
	}
	const child = originalSpawn.call(this, command, args, options);
	let markClosed;
	const close = new Promise((settle) => {
		markClosed = settle;
	});
	const record = { kind, cli: argv[0], pid: child.pid, closed: false, close };
	child.once("close", () => {
		record.closed = true;
		markClosed();
	});
	observedSpawns.push(record);
	return child;
};
// The extension reaches the same builtin export through jiti, so the guard has to reach
// the ESM namespace before any module that imports `spawn` is evaluated.
syncBuiltinESMExports();

const root = process.env.FORMATS_SDK_ROOT;
const jsonCli = process.env.JSON_LSP_CLI;
const yamlCli = process.env.YAML_LSP_CLI;
if (!root || !isAbsolute(root))
	throw scenarioError("environment", "invalid_root", "FORMATS_SDK_ROOT is invalid.");
for (const [name, value] of [
	["JSON_LSP_CLI", jsonCli],
	["YAML_LSP_CLI", yamlCli],
]) {
	if (!value || !isAbsolute(value))
		throw scenarioError("environment", "invalid_cli_path", `${name} is not a canonical absolute path.`);
}

const agentDir = join(root, "agent");
const homeDir = join(root, "home");
const workspace = join(root, "workspace");
const resultPath = join(root, RESULT_NAME);

/** Writes the bounded metadata sidecar. It never carries stdout, PIDs or payloads. */
async function writeResult(payload) {
	const text = `${JSON.stringify(payload)}\n`;
	if (Buffer.byteLength(text) > 8_192)
		throw new Error("The SDK scenario result exceeds 8 KiB.");
	await writeFile(resultPath, text, "utf8");
}

/** Keeps only a bounded, pre-declared failure token in the sidecar. */
function failureMetadata(error) {
	const phase = typeof error?.phase === "string" ? error.phase : "scenario";
	const code =
		typeof error?.code === "string" && /^[a-z_]{3,40}$/.test(error.code)
			? error.code
			: "sdk_fixture_failed";
	return { phase, errorCode: code };
}

/**
 * Owns one 127.0.0.1 server that serves a single schema path and holds the response until
 * `release`. Every other request is answered 404, so nothing is ever proxied. `received`
 * resolves only after a valid path request, which proves the JSON server already asked for
 * the schema before the caller aborts.
 */
function startWithheldSchemaServer(schemaText) {
	return new Promise((resolveServer, rejectServer) => {
		let markReceived = () => {};
		const received = new Promise((settle) => {
			markReceived = () => {
				settle();
			};
		});
		let release = () => {};
		const releaseGate = new Promise((settle) => {
			release = () => {
				settle();
			};
		});
		let released = false;
		let held;
		const server = createServer((request, response) => {
			if (request.method !== "GET" || request.url !== SCHEMA_PATH) {
				response.writeHead(404, { "content-type": "text/plain" });
				response.end("not found");
				return;
			}
			held = response;
			markReceived();
			void releaseGate.then(() => {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(schemaText);
			});
		});
		server.once("error", rejectServer);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", rejectServer);
			const address = server.address();
			if (!address || typeof address === "string") {
				rejectServer(new Error("The loopback schema server has no port."));
				return;
			}
			resolveServer({
				url: `http://127.0.0.1:${address.port}${SCHEMA_PATH}`,
				received,
				release: () => {
					released = true;
					release();
				},
				isReleased: () => released,
				close: async () => {
					release();
					held?.destroy();
					server.closeAllConnections();
					await new Promise((settleClose) => server.close(settleClose));
				},
			});
		});
	});
}

/**
 * Reads the diagnostics batch. `failures` is checked before any `files` entry so a request
 * failure is never mistaken for a genuinely clean file.
 */
function decodeDiagnostics(result) {
	const text = result.content?.find((item) => item.type === "text")?.text;
	if (typeof text !== "string") throw new Error("Expected a text tool result.");
	let decoded;
	try {
		decoded = JSON.parse(text);
	} catch {
		throw new Error("The diagnostics result is not JSON.");
	}
	const files = decoded?.files;
	const failures = decoded?.failures;
	if (!Array.isArray(files) || !Array.isArray(failures))
		throw new Error("Unexpected diagnostics result shape.");
	if (failures.length > 0) {
		const codes = failures
			.map((entry) => (typeof entry?.code === "string" ? entry.code : "unknown"))
			.join(", ");
		throw new Error(`The diagnostics request failed: ${codes}.`);
	}
	return decoded;
}
/** Returns the diagnostics reported for one server, or throws a named failure. */
function reportsFor(decoded, serverId) {
	const server = decoded.files?.[0]?.servers?.find(
		(entry) => entry.serverId === serverId,
	);
	if (!server) throw new Error(`No diagnostics were reported for ${serverId}.`);
	return server.diagnostics;
}

/** Asserts the reported position and message of the fixture's own type error. */
function assertStringTypeErrorAt(reports, line, character) {
	const match = reports.find(
		(entry) => entry.line === line && entry.character === character,
	);
	if (!match)
		throw new Error(`No diagnostics at line ${line} character ${character}.`);
	if (!/string/i.test(match.message))
		throw new Error("The expected string-type diagnostic is missing.");
}

/** Waits for every observed child to close, or fails instead of reporting vacuously. */
async function childrenClosed(records) {
	if (records.every((record) => record.closed)) return true;
	let timer;
	try {
		return await Promise.race([
			Promise.all(records.map((record) => record.close)).then(() => true),
			new Promise((settle) => {
				timer = setTimeout(() => settle(false), 5_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function main() {
	// One place for the metadata that is written on success and on failure.
	const summary = {
		version: 1,
		agentDirOwned: false,
		trusted: false,
		tools: 0,
		lspCommand: false,
		json: {},
		yaml: {},
		spawns: { json: 0, yaml: 0, helpers: 0, unexpected: 0 },
		liveBeforeShutdown: 0,
		evictedBeforeReplacement: false,
		allChildrenClosed: false,
		httpClosed: false,
	};
	let runtime;
	let withheld;
	let failure;
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(homeDir, { recursive: true });
		await mkdir(workspace, { recursive: true });

		const jsonSchema = join(workspace, "json-schema.json");
		const yamlSchema = join(workspace, "yaml-schema.json");
		const jsonInvalid = join(workspace, "invalid.json");
		const jsonClean = join(workspace, "clean.json");
		const jsonRemoteInvalid = join(workspace, "remote-invalid.json");
		const jsonRemoteClean = join(workspace, "remote-clean.json");
		const yamlInvalid = join(workspace, "invalid.yaml");
		const yamlClean = join(workspace, "clean.yaml");
		const jsonSchemaText = JSON.stringify({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			required: ["name"],
			properties: { $schema: { type: "string" }, name: { type: "string" } },
			additionalProperties: false,
		});
		const yamlSchemaText = JSON.stringify({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			required: ["name"],
			properties: { name: { type: "string" } },
			additionalProperties: false,
		});
		await writeFile(jsonSchema, jsonSchemaText, "utf8");
		await writeFile(yamlSchema, yamlSchemaText, "utf8");
		withheld = await startWithheldSchemaServer(jsonSchemaText);

		// `"name": 42` sits on LSP line 2, so the tool reports line 3; `42` starts at
		// character 10. The remote file keeps the positions: the schema URL only
		// lengthens line 1.
		await writeFile(
			jsonInvalid,
			'{\n  "$schema": "./json-schema.json",\n  "name": 42\n}\n',
			"utf8",
		);
		await writeFile(
			jsonRemoteInvalid,
			`{\n  "$schema": "${withheld.url}",\n  "name": 42\n}\n`,
			"utf8",
		);
		await writeFile(
			jsonClean,
			`${JSON.stringify({ $schema: "./json-schema.json", name: "valid" })}\n`,
			"utf8",
		);
		await writeFile(
			jsonRemoteClean,
			`${JSON.stringify({ $schema: withheld.url, name: "valid" })}\n`,
			"utf8",
		);
		// `name: 42` sits on LSP line 0, so the tool reports line 1; `42` starts at 6.
		await writeFile(yamlInvalid, "name: 42\n", "utf8");
		await writeFile(yamlClean, "name: valid\n", "utf8");

		await writeFile(
			join(agentDir, "pi-lsp-manager.json"),
			JSON.stringify({
				version: 1,
				network: "offline",
				autoInstall: false,
				postEditDiagnostics: false,
				servers: {
					// The real loader supplies `json.validate.enable` for this built-in ID, so the
					// scenario relies on that default instead of repeating it here.
					[JSON_SERVER_ID]: {
						command: process.execPath,
						args: [jsonCli, "--stdio"],
					},
					[YAML_SERVER_ID]: {
						command: process.execPath,
						args: [yamlCli, "--stdio"],
						settings: {
							yaml: {
								schemaStore: { enable: false },
								schemas: {
									[pathToFileURL(yamlSchema).href]: [
										"invalid.yaml",
										"clean.yaml",
									],
								},
							},
						},
					},
				},
			}),
			"utf8",
		);
		const sdk = await import("@earendil-works/pi-coding-agent");
		const agentDirectory = await realpath(agentDir);
		if ((await realpath(sdk.getAgentDir())) !== agentDirectory)
			throw scenarioError("trust", "agent_dir_mismatch", "getAgentDir() does not resolve to the owned agent directory.");
		summary.agentDirOwned = true;

		const settingsManager = sdk.SettingsManager.create(workspace, agentDir, {
			projectTrusted: true,
		});
		const sessionManager = sdk.SessionManager.inMemory(workspace);
		// Preloaded synthetic history: the minimum caller record the nested-call path
		// requires. `api`/`provider`/`model` are deliberately synthetic so no known
		// provider, credential or catalog entry can match them.
		sessionManager.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: SEED_TOOL_CALL_ID,
					name: "lsp_status",
					arguments: {},
				},
			],
			api: "pi-lsp-manager-fixture",
			provider: "pi-lsp-manager-fixture",
			model: "pi-lsp-manager-fixture",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1_700_000_000_000,
		});

		const createRuntime = async ({
			cwd,
			agentDir: runtimeAgentDir,
			sessionManager: runtimeSessionManager,
			sessionStartEvent,
		}) => {
			const services = await sdk.createAgentSessionServices({
				cwd,
				agentDir: runtimeAgentDir,
				settingsManager,
				resourceLoaderOptions: {
					additionalExtensionPaths: [EXTENSION_PATH],
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			return {
				...(await sdk.createAgentSessionFromServices({
					services,
					sessionManager: runtimeSessionManager,
					sessionStartEvent,
					noTools: "builtin",
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		runtime = await sdk.createAgentSessionRuntime(createRuntime, {
			cwd: workspace,
			agentDir,
			sessionManager,
		});
		const runner = runtime.session.extensionRunner;

		const tools = runner
			.getAllRegisteredTools()
			.map((tool) => tool.definition.name)
			.sort();
		const expectedTools = [
			"lsp_apply_code_action",
			"lsp_code_actions",
			"lsp_definition",
			"lsp_diagnostics",
			"lsp_fix",
			"lsp_prepare_rename",
			"lsp_references",
			"lsp_rename",
			"lsp_status",
			"lsp_symbols",
		].sort();
		if (tools.join(",") !== expectedTools.join(","))
			throw scenarioError("registry", "tools_missing", "The extension did not register its ten LSP tools.");
		summary.tools = tools.length;
		if (
			!runner
				.getRegisteredCommands()
				.map((command) => command.name)
				.includes("lsp")
		)
			throw scenarioError("registry", "command_missing", "The extension did not register the lsp command.");
		summary.lspCommand = true;
		if (!settingsManager.isProjectTrusted())
			throw scenarioError("trust", "untrusted", "The owned session is not trusted.");
		const toolCall = async (name, args, signal) =>
			runner
				.createToolContext(SEED_TOOL_CALL_ID, signal)
				.executeTool(name, args, signal ? { signal } : undefined);
		const runDiagnostics = (filePath, serverId, signal) =>
			toolCall("lsp_diagnostics", { filePath, servers: [serverId] }, signal);

		const statusOutcome = await toolCall("lsp_status", {});
		if (statusOutcome.isError === true)
			throw new Error("lsp_status reported a failure.");
		const statusText = statusOutcome.result.content?.find(
			(item) => item.type === "text",
		)?.text;
		if (JSON.parse(statusText).trusted !== true)
			throw scenarioError("trust", "untrusted", "The extension did not observe project trust.");
		summary.trusted = true;

		const jsonInvalidOutcome = await runDiagnostics(jsonInvalid, JSON_SERVER_ID);
		if (jsonInvalidOutcome.isError === true)
			throw new Error("The local JSON diagnostics call failed.");
		assertStringTypeErrorAt(
			reportsFor(decodeDiagnostics(jsonInvalidOutcome.result), JSON_SERVER_ID),
			3,
			10,
		);
		summary.json.invalid = { line: 3, character: 10 };

		const jsonCleanResult = decodeDiagnostics(
			(await runDiagnostics(jsonClean, JSON_SERVER_ID)).result,
		);
		if (jsonCleanResult.files?.[0]?.servers?.[0]?.diagnostics.length !== 0)
			throw new Error("The clean JSON fixture reported diagnostics.");
		summary.json.clean = true;

		const yamlInvalidOutcome = await runDiagnostics(yamlInvalid, YAML_SERVER_ID);
		if (yamlInvalidOutcome.isError === true)
			throw new Error("The local YAML diagnostics call failed.");
		assertStringTypeErrorAt(
			reportsFor(decodeDiagnostics(yamlInvalidOutcome.result), YAML_SERVER_ID),
			1,
			6,
		);
		summary.yaml.invalid = { line: 1, character: 6 };

		const yamlCleanResult = decodeDiagnostics(
			(await runDiagnostics(yamlClean, YAML_SERVER_ID)).result,
		);
		if (yamlCleanResult.files?.[0]?.servers?.[0]?.diagnostics.length !== 0)
			throw new Error("The clean YAML fixture reported diagnostics.");
		summary.yaml.clean = true;

		// The remote schema stays withheld while the SDK signal aborts the pending tool,
		// so the cancellation is active, never pre- or post-completed.
		const controller = new AbortController();
		const pending = runDiagnostics(
			jsonRemoteInvalid,
			JSON_SERVER_ID,
			controller.signal,
		);
		let receiveTimer;
		try {
			await Promise.race([
				withheld.received,
				new Promise((_settle, rejectDeadline) => {
					receiveTimer = setTimeout(
						() =>
							rejectDeadline(
								new Error("The loopback schema request was not observed."),
							),
						RECEIVE_DEADLINE_MS,
					);
				}),
			]);
		} finally {
			if (receiveTimer) clearTimeout(receiveTimer);
		}
		controller.abort();
		let settleTimer;
		let settled;
		try {
			settled = await Promise.race([
				pending.then(() => true),
				new Promise((settle) => {
					settleTimer = setTimeout(() => settle(false), SETTLE_DEADLINE_MS);
				}),
			]);
		} finally {
			if (settleTimer) clearTimeout(settleTimer);
		}
		if (settled !== true)
			throw new Error("The cancelled diagnostics call never settled.");
		if (withheld.isReleased())
			throw new Error("The schema response was released before the tool settled.");
		const cancelledOutcome = await pending;
		const cancelledText = cancelledOutcome.result.content?.find(
			(item) => item.type === "text",
		)?.text;
		if (cancelledText !== "cancelled: Retry the request.")
			throw new Error("The cancelled tool result is not the structured failure.");
		summary.json.cancelled = "cancelled";
		summary.json.withheldAtCancel = true;

		// The tainted original child is already closed before the replacement runs.
		summary.evictedBeforeReplacement = observedSpawns[0]?.closed === true;
		if (!summary.evictedBeforeReplacement)
			throw new Error("The evicted JSON child was still open at replacement.");

		withheld.release();
		assertStringTypeErrorAt(
			reportsFor(
				decodeDiagnostics(
					(await runDiagnostics(jsonRemoteInvalid, JSON_SERVER_ID)).result,
				),
				JSON_SERVER_ID,
			),
			3,
			10,
		);
		summary.json.replacementInvalid = { line: 3, character: 10 };
		const replacementClean = decodeDiagnostics(
			(await runDiagnostics(jsonRemoteClean, JSON_SERVER_ID)).result,
		);
		if (replacementClean.files?.[0]?.servers?.[0]?.diagnostics.length !== 0)
			throw new Error("The clean remote JSON fixture reported diagnostics.");
		summary.json.replacementClean = true;

		const jsonSpawns = observedSpawns.filter((record) => record.cli === jsonCli);
		const yamlSpawns = observedSpawns.filter((record) => record.cli === yamlCli);
		if (jsonSpawns.length !== 2 || yamlSpawns.length !== 1)
			throw scenarioError("spawn", "unexpected_language_servers", `Expected 2 JSON and 1 YAML language server, observed ${jsonSpawns.length} and ${yamlSpawns.length}.`);
		summary.spawns.json = jsonSpawns.length;
		summary.spawns.yaml = yamlSpawns.length;
		summary.spawns.helpers = observedSpawns.filter(
			(record) => record.kind === "helper",
		).length;
		const live = observedSpawns.filter((record) => !record.closed);
		summary.liveBeforeShutdown = live.length;
		if (live.length !== 2)
			throw scenarioError("spawn", "unexpected_live_servers", "Expected two live language servers before shutdown.");
	} catch (error) {
		failure = error;
	}
	// Every owned resource is released here, and each cleanup failure is collected
	// instead of replacing the operation that already failed.
	if (runtime) {
		try {
			await runtime.dispose();
		} catch (error) {
			failure ??= error;
		}
	} else {
		failure ??= scenarioError("runtime", "runtime_not_created", "The SDK runtime was never created.");
	}
	if (observedSpawns.length > 0) {
		if (!(await childrenClosed(observedSpawns))) {
			failure ??= scenarioError("cleanup", "children_not_closed", "Owned child close was not observed; preserving the owned root.");
		}
		summary.allChildrenClosed = observedSpawns.every((record) => record.closed);
	} else {
		// Zero records never proves cleanup, so it never reports a closed scenario.
		failure ??= scenarioError("spawn", "no_language_server_observed", "No owned language server was ever observed.");
	}
	summary.spawns.unexpected = rejectedCommands;
	// A rejected command already escaped the guard, so the scenario never reports success
	// even if the SDK would otherwise keep the session running.
	if (rejectedCommands > 0)
		failure ??= scenarioError(
			"spawn",
			"unexpected_command",
			"An unapproved command was rejected.",
		);
	if (withheld) {
		try {
			await withheld.close();
			summary.httpClosed = true;
		} catch (error) {
			failure ??= error;
		}
	}
	summary.ok = failure === undefined;
	const payload = summary.ok
		? summary
		: { ...summary, ...failureMetadata(failure) };
	return { ok: summary.ok, payload };
}

let result;
try {
	result = await main();
} catch (error) {
	// Only an unexpected throw outside the cleanup scope reaches here.
	result = { ok: false, payload: { version: 1, ...failureMetadata(error) } };
}
await writeResult(result.payload);
process.exitCode = result.ok ? 0 : 1;
