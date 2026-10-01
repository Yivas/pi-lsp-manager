import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	basename,
	delimiter,
	dirname,
	isAbsolute,
	join,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	EffectiveConfig,
	EffectiveServerConfig,
	ServerRole,
} from "../../src/contracts.js";
import {
	INACTIVE_PYTHON_RECIPES,
	type PythonInstallRecipe,
	selectPythonEntry,
} from "../../src/install/catalog.js";
import { NodeLspRuntimeSession } from "../../src/protocol/process.js";
import { RuntimePool } from "../../src/runtime/pool.js";
import type { TrustedOperationService } from "../../src/tools/shared.js";
import { TrustedOperationService as Service } from "../../src/tools/shared.js";
import {
	type GateHandoffServer,
	type GateManifest,
	inside,
	parseGateManifest,
} from "./python-install-gate-ownership.js";

// Shared seam for the opt-in Python semantic fixtures. They never resolve ty or ruff from
// PATH or the checkout: they consume the read-only manifest the real installation gate wrote,
// re-hash each committed executable and re-check each wheel against the frozen lock before a
// server starts. A missing variable, a wrong manifest, a foreign host or a changed binary
// fails closed before any process exists.

export const PYTHON_SEMANTIC_HANDOFF_VARIABLE = "PYTHON_INSTALL_GATE_HANDOFF";

/** The checkout the handoff root and the committed executables must never live inside. */
export const CHECKOUT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * The pinned versions the fixtures accept. They are read from the frozen, inactive recipes
 * instead of being copied, so a catalog bump cannot leave the fixture asserting a version
 * the manifest was never checked against.
 */
export const EXPECTED_PYTHON_SERVER_VERSIONS = {
	ty: INACTIVE_PYTHON_RECIPES.ty.expectedVersion,
	ruff: INACTIVE_PYTHON_RECIPES.ruff.expectedVersion,
} as const;

export type PythonServerId = keyof typeof EXPECTED_PYTHON_SERVER_VERSIONS;

/**
 * Native argv after the executable. The pinned CLI documentation defines `ty server` and
 * `ruff server`; the internal recipe declares no argv of its own.
 */
const PYTHON_SERVER_ARGS: readonly string[] = ["server"];

/** Ty analyzes as 3.13 only when the fixture config pins it; its default is 3.14. */
export const TY_ANALYSIS_PYTHON_VERSION = "3.13";
/** Ty's own default target version; only the discrimination case switches to it. */
export const TY_PROBE_PYTHON_VERSION = "3.14";
/** Ruff reads `target-version` from the workspace config; py313 matches the CI interpreter. */
export const RUFF_TARGET_VERSION = "py313";

export interface ReadyPythonServer {
	id: PythonServerId;
	executable: string;
	version: string;
	sha256: string;
}

export interface PythonSemanticHandoff {
	root: string;
	platform: NodeJS.Platform;
	architecture: NodeJS.Architecture;
	interpreter: string;
	servers: Readonly<Record<PythonServerId, ReadyPythonServer>>;
}

export type PythonHandoffResult =
	| { ok: true; handoff: PythonSemanticHandoff }
	| { ok: false; reason: string };

async function sha256File(path: string): Promise<string | undefined> {
	try {
		return createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
	} catch {
		return undefined;
	}
}

function wheelFor(id: PythonServerId) {
	const recipe: PythonInstallRecipe = INACTIVE_PYTHON_RECIPES[id];
	return selectPythonEntry(recipe, process.platform, process.arch);
}

/** The frozen wheel entry the host must match; shared with the deterministic guard unit. */
export function frozenWheel(serverId: PythonServerId) {
	return wheelFor(serverId);
}

/**
 * Reads and validates the gate handoff. Every refusal returns `ok: false` with a path-free
 * reason instead of throwing, so the fixture reports the guard that failed. `handoffPath`
 * defaults to the documented variable; the deterministic suite passes its own path so it
 * never mutates `process.env`.
 */
export async function loadPythonSemanticHandoff(
	handoffPath: string | undefined = process.env[
		PYTHON_SEMANTIC_HANDOFF_VARIABLE
	],
): Promise<PythonHandoffResult> {
	const raw = handoffPath;
	if (!raw || raw.trim().length === 0)
		return {
			ok: false,
			reason: `${PYTHON_SEMANTIC_HANDOFF_VARIABLE} is required; the fixture fails closed instead of resolving ty or ruff from PATH or the checkout.`,
		};
	if (!isAbsolute(raw))
		return {
			ok: false,
			reason: `${PYTHON_SEMANTIC_HANDOFF_VARIABLE} must be an absolute path.`,
		};
	let text: string;
	try {
		text = await readFile(raw, "utf8");
	} catch {
		return {
			ok: false,
			reason: "The Python installation gate handoff could not be read.",
		};
	}
	let manifest: GateManifest;
	try {
		manifest = parseGateManifest(text, {
			versions: EXPECTED_PYTHON_SERVER_VERSIONS,
		});
	} catch (error) {
		return {
			ok: false,
			reason:
				error instanceof Error
					? error.message
					: "The gate manifest is invalid.",
		};
	}
	if (inside(CHECKOUT, manifest.root))
		return {
			ok: false,
			reason: "The gate root must stay outside the checkout.",
		};
	if (
		manifest.platform !== process.platform ||
		manifest.architecture !== process.arch
	)
		return {
			ok: false,
			reason: `The gate manifest targets ${manifest.platform}/${manifest.architecture}, not this host (unsupported platform).`,
		};
	const servers = {} as Record<PythonServerId, ReadyPythonServer>;
	for (const id of ["ty", "ruff"] as const) {
		const server: GateHandoffServer | undefined = manifest.servers?.[id];
		if (!server)
			return { ok: false, reason: `The gate manifest is missing ${id}.` };
		const wheel = wheelFor(id);
		if (!wheel)
			return {
				ok: false,
				reason: `The frozen ${id} lock has no wheel for this host (unsupported platform).`,
			};
		if (
			server.wheel.sha256 !== wheel.sha256 ||
			server.wheel.fileName !== basename(wheel.url)
		)
			return {
				ok: false,
				reason: `The ${id} handoff wheel does not match the frozen lock.`,
			};
		const actual = await sha256File(server.executable.path);
		if (!actual)
			return {
				ok: false,
				reason: `The ${id} executable could not be read.`,
			};
		if (actual !== server.executable.sha256)
			return {
				ok: false,
				reason: `The ${id} executable hash changed since the gate wrote the handoff.`,
			};
		servers[id] = {
			id,
			executable: server.executable.path,
			version: server.executable.version,
			sha256: actual,
		};
	}
	return {
		ok: true,
		handoff: {
			root: manifest.root,
			platform: manifest.platform,
			architecture: manifest.architecture,
			interpreter: manifest.interpreter.path,
			servers,
		},
	};
}

/** The approved global manual route shape for one Python server; the project adds nothing. */
export function pythonServerConfig(
	server: ReadyPythonServer,
	options: {
		priority: number;
		roles: readonly ServerRole[];
		initialization?: Readonly<Record<string, unknown>>;
	},
): EffectiveServerConfig {
	return {
		id: server.id,
		enabled: true,
		autoInstall: false,
		priority: options.priority,
		route: {
			command: server.executable,
			args: [...PYTHON_SERVER_ARGS],
			...(options.initialization
				? { initialization: options.initialization }
				: {}),
		},
		extensions: [".py", ".pyi"],
		roles: options.roles,
		languageIds: ["python"],
		admission: "candidate",
		diagnostics: { pushGraceMs: 30_000, settleMs: 50, pullGraceMs: 250 },
		manualHelp: `Install ${server.id} ${server.version} through the trusted installer interpreter, then retry.`,
	};
}

/** Autoinstall stays off and the project layer is never consulted in these fixtures. */
export function pythonSemanticConfig(
	servers: readonly EffectiveServerConfig[],
): EffectiveConfig {
	return {
		version: 1,
		network: "offline",
		autoInstall: false,
		postEditDiagnostics: false,
		servers: Object.fromEntries(servers.map((server) => [server.id, server])),
	};
}

// Original fixture sources. They are small, stable and named as fixtures; no upstream sample
// is copied and nothing here claims Discord.py or any other library compatibility.
export const PYTHON_CLEAN = `"""Clean fixture: the annotation resolves without a diagnostic."""

from __future__ import annotations

VALUE: int = 1


def double(value: int) -> int:
    return value * 2
`;

export const PYTHON_INVALID = `"""Invalid fixture: the annotated type never matches the assigned value."""

from __future__ import annotations

VALUE: int = "not an integer"
`;

/**
 * Version-sensitive fixture: the offending assignment sits in the branch ty only analyzes
 * from the target version 3.14 on, so the diagnostics must change with the configured
 * `python-version`. Under the pinned 3.13 the branch is unreachable and the file is clean.
 */
export const PYTHON_VERSION_PROBE = `"""Version-sensitive fixture: analyzed only from Python 3.14 on."""

from __future__ import annotations

import sys

if sys.version_info >= (3, 14):
    VALUE: int = "not an integer"
`;

export const PYTHON_UNUSED_IMPORT = `"""Lint fixture: an unused import the default Ruff rules flag with F401."""

from __future__ import annotations

import os

VALUE: int = 1
`;

/**
 * Configuration probe: an unused import the default rule set reports and a line past the
 * default width it does not select. A configuration change flips both findings at once, so
 * reading the configuration cannot be confused with not analyzing the file.
 */
export const PYTHON_CONFIG_PROBE = `"""Configuration probe: an unused import and a line past the default width."""

from __future__ import annotations

import os

VALUE: int = 1  # this trailing comment is deliberately longer than the configured maximum line length
`;

export const PYTHON_API = `"""Rename target: a local function imported by consumer.py."""

from __future__ import annotations


def compute(value: int) -> int:
    return value * 2
`;

export const PYTHON_CONSUMER = `"""Rename caller: imports and calls the local target."""

from __future__ import annotations

from api import compute

result: int = compute(2)
`;

/** Ty configuration file: pins the analysis version and selects a read-only interpreter. */
export function tyConfig(
	pythonInterpreter: string,
	pythonVersion: string = TY_ANALYSIS_PYTHON_VERSION,
): string {
	// TOML basic strings treat `\` as an escape; the analyzed host accepts forward slashes.
	const interpreter = pythonInterpreter.replaceAll("\\", "/");
	return `[environment]\npython = ${JSON.stringify(interpreter)}\npython-version = "${pythonVersion}"\n`;
}

/**
 * Ruff configuration file: pins the target version instead of inheriting py310. It stays
 * production-shaped: the fixture adds no cache redirection, so any write the analyzer makes
 * into the analyzed workspace fails the footprint case instead of being pre-empted.
 */
export function ruffConfig(): string {
	return `target-version = "${RUFF_TARGET_VERSION}"\n`;
}

/**
 * Ruff configuration probe: selects the long-line rule, which the default rule set does not
 * enable, and ignores the unused-import rule it does enable. Both changes are observable on
 * the probe file, so reading this configuration cannot be confused with not analyzing it.
 */
export function ruffProbeConfig(): string {
	return [
		`target-version = "${RUFF_TARGET_VERSION}"`,
		"[lint]",
		'select = ["E501", "F"]',
		'ignore = ["F401"]',
		"",
	].join("\n");
}

/** Creates an owned workspace under the operating-system temp directory. */
export async function createPythonWorkspace(
	files: Readonly<Record<string, string>>,
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-lsp-python-semantic-"));
	for (const [relativePath, contents] of Object.entries(files)) {
		const target = join(root, relativePath);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, "utf8");
	}
	return root;
}

/**
 * Candidate user-configuration path a pinned server reads when it resolves a profile from
 * `HOME` on POSIX. It is planted under the owned home, so a hostile profile can never be
 * the real one; on Windows the servers resolve `%APPDATA%`, which the production allowlist
 * never forwards to a child.
 */
export function globalConfigPath(
	home: string,
	serverId: PythonServerId,
): string {
	return join(home, ".config", serverId, `${serverId}.toml`);
}

/**
 * The trusted baseline PATH: the operating-system directories the plan allows plus the
 * directory of the selected interpreter. It never contains the host PATH, which on the
 * measured host carried another project's virtual environment.
 */
export function isolatedPath(interpreter: string): string {
	const directories = [dirname(interpreter)];
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot;
		if (systemRoot) directories.push(join(systemRoot, "System32"), systemRoot);
	} else {
		directories.push("/usr/bin", "/bin");
	}
	return directories.join(delimiter);
}

export interface PythonIsolation {
	/** The owned root the fixture teardown removes; it is never the checkout. */
	root: string;
	/** Own home: `HOME` points here, so a server that honours it stays owned. */
	home: string;
	/** Own temp: `TEMP` and `TMP` point here. */
	temp: string;
	/** The minimal environment the production session hands to the server. */
	environment: NodeJS.ProcessEnv;
}

/**
 * Builds the owned directories and the minimal environment for one fixture, before any
 * server launches. The environment is constructed from the operating-system base and the
 * owned directories only: it never spreads `process.env`, so no host PATH, profile, proxy
 * or `PYTHON*`/`PIP*` value can reach a child. `buildServerEnvironment` keeps exactly
 * `PATH`, `SystemRoot`, `ComSpec`, `HOME`, `TEMP` and `TMP`; the fixtures assert that
 * surviving set at the real spawn call.
 */
export async function createPythonIsolation(
	interpreter: string,
): Promise<PythonIsolation> {
	const root = await mkdtemp(join(tmpdir(), "pi-lsp-python-isolation-"));
	const home = join(root, "home");
	const temp = join(root, "temp");
	for (const directory of [
		home,
		temp,
		dirname(globalConfigPath(home, "ty")),
		dirname(globalConfigPath(home, "ruff")),
	])
		await mkdir(directory, { recursive: true });
	const environment: NodeJS.ProcessEnv = {
		PATH: isolatedPath(interpreter),
		HOME: home,
		TEMP: temp,
		TMP: temp,
	};
	const systemRoot = process.env.SystemRoot;
	if (systemRoot) environment.SystemRoot = systemRoot;
	const comSpec = process.env.ComSpec;
	if (comSpec) environment.ComSpec = comSpec;
	return { root, home, temp, environment };
}

export interface TreeDelta {
	added: readonly string[];
	changed: readonly string[];
	removed: readonly string[];
}

/** Compares two `treeHashes` snapshots so a fixture states an explicit write policy. */
export function treeDelta(
	before: Record<string, string>,
	after: Record<string, string>,
): TreeDelta {
	return {
		added: Object.keys(after)
			.filter((path) => !(path in before))
			.sort(),
		changed: Object.keys(after)
			.filter((path) => path in before && after[path] !== before[path])
			.sort(),
		removed: Object.keys(before)
			.filter((path) => !(path in after))
			.sort(),
	};
}

/** A stable digest per file, so a fixture can prove which paths an edit actually touched. */
export async function treeHashes(
	root: string,
	relative = "",
): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	const entries = (
		await readdir(join(root, relative), { withFileTypes: true }).catch(() => [])
	).sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
	for (const entry of entries) {
		const path = relative ? join(relative, entry.name) : entry.name;
		if (entry.isDirectory()) {
			Object.assign(result, await treeHashes(root, path));
		} else {
			result[path] = createHash("sha256")
				.update(await readFile(join(root, path)))
				.digest("hex");
		}
	}
	return result;
}

export function isProcessAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function toolValue(result: {
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

export interface ReportedDiagnostic {
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

/** Retries only an explicit cold-build timeout, never a fabricated empty success. */
export async function diagnoseFile(
	service: TrustedOperationService,
	ctx: never,
	filePath: string,
): Promise<ReportedDiagnostic[]> {
	const { diagnostics } = await import("../../src/tools/diagnostics.js");
	let response = await diagnostics(service, ctx, { filePath }, undefined);
	for (
		let retry = 0;
		retry < 2 && response.details?.code === "diagnostics_timed_out";
		retry++
	) {
		response = await diagnostics(service, ctx, { filePath }, undefined);
	}
	if (response.details?.code !== "ok") {
		const text = response.content.find((item) => item.type === "text")?.text;
		throw new Error(
			`Python diagnostics failed (${response.details?.code ?? "missing code"}): ${text ?? "<no message>"}`,
		);
	}
	const entries = toolValue(response).diagnostics;
	if (!Array.isArray(entries)) throw new Error("Missing diagnostics array.");
	return entries as ReportedDiagnostic[];
}

export interface PythonFixture {
	service: TrustedOperationService;
	pool: RuntimePool;
	context: ExtensionContext;
	starts(): number;
	installCalls(): number;
	livePids(): readonly number[];
	runtime(): NodeLspRuntimeSession | undefined;
	/** The exact environment handed to `node:child_process.spawn` for every start. */
	spawnEnvironments(): readonly NodeJS.ProcessEnv[];
}

/** Records the real child pid and the real spawn environment before delegating to
 * `node:child_process`, so a fixture can assert the production allowlist survivors at the
 * process boundary instead of trusting a helper return value. */
function recordingSpawn(
	pids: number[],
	environments: NodeJS.ProcessEnv[],
): typeof spawn {
	const record = (
		command: string,
		args: readonly string[],
		options: { cwd?: unknown; env?: NodeJS.ProcessEnv } | undefined,
	): ChildProcess => {
		const child = spawn(command, [...args], options as never);
		if (options?.env) environments.push({ ...options.env });
		if (child.pid) pids.push(child.pid);
		return child;
	};
	return record as unknown as typeof spawn;
}

/**
 * Builds the trusted-operation service over the real production session. Only the seams
 * named in the fixtures are injected: the configuration loader, the command resolver and the
 * start function. The pool, session, protocol and tools are the shipped ones.
 */
export function createPythonFixture(options: {
	workspace: string;
	config: EffectiveConfig;
	available: ReadonlySet<PythonServerId>;
	trusted?: boolean;
	/** The controlled environment the production session hands to the child. */
	environment: NodeJS.ProcessEnv;
	/** Runs just before a real start, so a test can abort its own signal in flight. */
	onStart?: () => void;
}): PythonFixture {
	const trusted = options.trusted ?? true;
	const pool = new RuntimePool();
	const pids: number[] = [];
	const environments: NodeJS.ProcessEnv[] = [];
	let starts = 0;
	let installCalls = 0;
	let runtime: NodeLspRuntimeSession | undefined;
	const executableById = new Map<string, string>();
	for (const server of Object.values(options.config.servers)) {
		const command = server.route?.command;
		if (command) executableById.set(command, server.id);
	}
	const service = new Service({
		coordinator: () => {
			installCalls += 1;
			return undefined;
		},
		pool: () => pool,
		load: async () => ({
			config: options.config,
			paths: {
				globalConfigPath: join(options.workspace, "global.json"),
				projectConfigPath: join(options.workspace, "project.json"),
				managedStatePath: join(options.workspace, "managed"),
			},
			globalLayer: "absent",
			projectLayer: "absent",
		}),
		resolveCommand: async (command) =>
			executableById.has(command) &&
			options.available.has(executableById.get(command) as PythonServerId)
				? command
				: undefined,
		start: async (sessionOptions) => {
			starts += 1;
			options.onStart?.();
			runtime = await NodeLspRuntimeSession.start({
				...sessionOptions,
				environment: options.environment,
				requestTimeoutMs: 15_000,
				spawnProcess: recordingSpawn(pids, environments),
			});
			return runtime;
		},
		platform: process.platform,
		architecture: process.arch,
	});
	return {
		service,
		pool,
		context: {
			cwd: options.workspace,
			signal: undefined,
			isProjectTrusted: () => trusted,
		} as unknown as ExtensionContext,
		starts: () => starts,
		installCalls: () => installCalls,
		livePids: () => pids.filter(isProcessAlive),
		runtime: () => runtime,
		spawnEnvironments: () => environments,
	};
}
