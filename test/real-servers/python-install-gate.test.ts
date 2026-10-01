import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	readFile,
	readdir,
	realpath,
	stat,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	delimiter,
	dirname,
	isAbsolute,
	join,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import { parseConfigText } from "../../src/config/schema.js";
import {
	pythonExecutablePath,
	resolveTrustedPythonInterpreter,
} from "../../src/install/adapters/python.js";
import type { AuditRecord } from "../../src/install/audit.js";
import {
	getRecipe,
	INACTIVE_PYTHON_RECIPES,
	type PythonInstallRecipe,
	selectPythonEntry,
} from "../../src/install/catalog.js";
import {
	InstallCoordinator,
	type InstallPhase,
} from "../../src/install/coordinator.js";
import {
	NodePackageManager,
	type SpawnFunction,
} from "../../src/install/npm.js";
import { evaluateInstallPolicy } from "../../src/install/policy.js";
import {
	createManagedInstallationVerifier,
	type InstallationVerifier,
	parsePythonServerVersion,
} from "../../src/install/verify.js";
import {
	inside,
	GATE_MANIFEST_FORMAT_VERSION,
	type GateCaseResults,
	type GateClaim,
	type GateHandoffServer,
	type GateManifest,
	type GateOwner,
	type GateScope,
	openGateRoot,
	ownGateOutput,
	requireGateEnvironment,
	resetGateScope,
	writeGateManifest,
} from "./python-install-gate-ownership.js";

// Real, opt-in installation gate for the two frozen Python recipes. `ty` and `ruff` are
// inactive candidates: the shipped registry answers `recipe_missing` and the gate proves
// that first. Only then does it inject a clearly named allowed decision so the production
// adapter, coordinator, package manager and verifier run a real `pip` install of exactly
// one pinned wheel per host. It never registers a recipe, never edits the catalog or the
// project configuration, and never starts an LSP: the committed binaries are probed with
// `--version` only.
//
// Handoff: `PYTHON_INSTALL_GATE_ROOT` is the owned directory the caller creates and later
// removes, `PYTHON_INSTALL_GATE_OUTPUT` receives a JSON manifest of the committed CLI
// paths (inside that root), and `PYTHON_GATE_INTERPRETER` is the absolute, trusted global
// interpreter. With any of them missing the gate fails closed instead of falling back to
// the host PATH or the checkout `node_modules`.
//
// Ownership: the root must be empty and outside the checkout, the interpreter is trusted
// before any marker exists, the marker is written O_EXCL with a random root token and run
// nonce, and every managed-scope reset re-proves that marker before touching a directory.
// A retained manifest is read-only reuse of the committed paths; every run needs a fresh
// unique root.

const runReal = process.env.RUN_REAL_PYTHON_INSTALL === "1";
const callerRoot = process.env.PYTHON_INSTALL_GATE_ROOT;
const outputFile = process.env.PYTHON_INSTALL_GATE_OUTPUT;
const configuredInterpreter = process.env.PYTHON_GATE_INTERPRETER;

// The checkout the gate must never install into, resolve a binary from, or read project
// configuration from.
const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const MINIMUM_PYTHON: readonly [number, number] = [3, 8];
// The product default install budget is two minutes; the gate pays two real wheel
// downloads and stays inside that same bound rather than hiding a hang.
const INSTALL_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = INSTALL_TIMEOUT_MS + 60_000;
const TOOL_TIMEOUT_MS = 60_000;

interface ProcessLaunch {
	command: string;
	args: readonly string[];
	cwd: string | undefined;
	env: Readonly<Record<string, string | undefined>> | undefined;
	pid: number | undefined;
}

interface Gate {
	claim: GateClaim;
	root: string;
	output: string;
	interpreter: string;
	pythonVersion: string;
	pipVersion: string;
	resetManaged(scope: GateScope): Promise<string>;
}

const handoff: { ty?: GateHandoffServer; ruff?: GateHandoffServer } = {};

// Set at the end of each real case, so a failure leaves a `failed` manifest instead of a
// misleading `complete` one.
const caseResults: GateCaseResults = {
	inactivePolicy: false,
	cancel: false,
	rollback: false,
	ty: false,
	ruff: false,
};

function currentUser(): string {
	return process.env.USERNAME ?? process.env.USER ?? "unknown";
}

/** Bounded child invocation. A hang is killed rather than left silent. */
function runTool(
	command: string,
	args: readonly string[],
): { code: number; stdout: string; stderr: string } {
	const result = spawnSync(command, [...args], {
		encoding: "utf8",
		timeout: TOOL_TIMEOUT_MS,
		windowsHide: true,
		maxBuffer: 1024 * 1024,
	});
	return {
		code: result.status ?? (result.error ? -1 : 1),
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function isProcessAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function sha256File(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

async function auditRecords(managed: string): Promise<AuditRecord[]> {
	const text = await readFile(
		join(managed, "audit", "install.audit.jsonl"),
		"utf8",
	);
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as AuditRecord);
}

/**
 * Captures the real spawn call before delegating to `node:child_process`, so the gate can
 * assert the scrubbed environment and staging cwd of the production manager without
 * replacing it.
 */
function recordingSpawn(records: ProcessLaunch[]): SpawnFunction {
	const record = (
		command: string,
		args: readonly string[],
		options: { cwd?: unknown; env?: unknown } | undefined,
	) => {
		const child = spawn(command, [...args], options as never);
		records.push({
			command,
			args: [...args],
			cwd: typeof options?.cwd === "string" ? options.cwd : undefined,
			env: (options?.env ?? undefined) as
				| Readonly<Record<string, string | undefined>>
				| undefined,
			pid: child.pid,
		});
		return child;
	};
	return record as unknown as SpawnFunction;
}

/**
 * A host environment that must be ignored: `PYTHON*` values, every pip variable except the
 * forced `PIP_CONFIG_FILE`, and a `PIP_REQUIRE_VIRTUALENV` that would hard-fail a leak. The
 * operating-system base is kept so pip can run at all; no proxy is set, because the design
 * deliberately forwards the trusted host proxy and the gate would then bind its own run to
 * that proxy.
 */
function poisonedEnvironment(root: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		PATH: `${join(root, "host-path")}${delimiter}${process.env.PATH ?? ""}`,
		PYTHONPATH: join(root, "poisoned-site"),
		PYTHONUSERBASE: join(root, "poisoned-user-base"),
		PYTHONHOME: join(root, "poisoned-home"),
		PIP_INDEX_URL: "https://127.0.0.1:9/simple",
		PIP_CONFIG_FILE: join(root, "poisoned-pip.ini"),
		PIP_TARGET: join(root, "poisoned-target"),
		PIP_REQUIRE_VIRTUALENV: "true",
	};
}

/**
 * Plants a Python hook on the poisoned `PYTHONPATH` and a poisoned pip configuration. A
 * hook that executes writes the returned marker; a config that is read carries an index
 * that must not be used.
 */
async function plantPoison(root: string): Promise<string> {
	const marker = join(root, "poison-python-executed.marker");
	const site = join(root, "poisoned-site");
	await mkdir(site, { recursive: true });
	await writeFile(
		join(site, "sitecustomize.py"),
		`import pathlib\npathlib.Path(${JSON.stringify(marker)}).write_text("executed")\n`,
		"utf8",
	);
	await writeFile(
		join(root, "poisoned-pip.ini"),
		"[global]\nindex-url = https://127.0.0.1:9/simple\nrequire-virtualenv = true\n",
		"utf8",
	);
	return marker;
}

/** The opt-in gate injects this; the shipped registry keeps answering `recipe_missing`. */
function gateOnlyAllowedDecision(id: "ty" | "ruff"): {
	allowed: true;
	recipe: PythonInstallRecipe;
} {
	return { allowed: true, recipe: INACTIVE_PYTHON_RECIPES[id] };
}

function coordinator(
	records: ProcessLaunch[],
	environment: NodeJS.ProcessEnv,
	verifier?: InstallationVerifier,
): InstallCoordinator {
	return new InstallCoordinator({
		packageManager: new NodePackageManager(recordingSpawn(records)),
		verifier: verifier ?? createManagedInstallationVerifier(),
		installTimeoutMs: INSTALL_TIMEOUT_MS,
		environment,
	});
}

/** Fails only the promoted revision, so the coordinator's quarantine/rollback branch runs. */
function promoteFailingVerifier(revision: string): InstallationVerifier {
	const real = createManagedInstallationVerifier();
	return async (path, recipe, signal) =>
		basename(path) === revision ? undefined : real(path, recipe, signal);
}

/** The production global-only route: a global value, then the real trust resolver. */
function configuredGlobalInterpreter(rawInterpreter: string): string {
	const globalLayer = parseConfigText(
		JSON.stringify({ version: 1, pythonInterpreter: rawInterpreter }),
		"global",
	);
	if (!globalLayer.ok)
		throw new Error(
			"PYTHON_GATE_INTERPRETER is not a valid global configuration value.",
		);
	const configured = (globalLayer.value as { pythonInterpreter?: string })
		.pythonInterpreter;
	if (!configured)
		throw new Error(
			"PYTHON_GATE_INTERPRETER is not a valid global configuration value.",
		);
	return configured;
}

/**
 * Trusts and preflights the interpreter before the root is claimed. A missing interpreter,
 * an unsafe path, a stale host or a pip without the required flags refuses here, so no
 * marker, directory or handoff is ever written into the caller root.
 */
async function trustInterpreter(
	configured: string,
	rawRoot: string,
	checkout: string,
): Promise<
	| { ok: true; interpreter: string; pythonVersion: string; pipVersion: string }
	| { ok: false; reason: string }
> {
	const trusted = await resolveTrustedPythonInterpreter(configured, {
		workspacePath: rawRoot,
		cwd: process.cwd(),
		platform: process.platform,
	});
	if (!trusted.ok) return { ok: false, reason: trusted.reason };
	const interpreter = trusted.path;
	if (inside(checkout, interpreter) || inside(rawRoot, interpreter))
		return { ok: false, reason: "interpreter_inside_owned_paths" };
	const python = runTool(interpreter, [
		"-I",
		"-c",
		"import sys;print('%d.%d.%d' % sys.version_info[:3])",
	]);
	if (python.code !== 0)
		return {
			ok: false,
			reason: `interpreter_cannot_run: ${python.stderr.trim()}`,
		};
	const pythonVersion = python.stdout.trim();
	const [major, minor] = pythonVersion.split(".").map(Number);
	const belowMinimum =
		(major ?? 0) < MINIMUM_PYTHON[0] ||
		((major ?? 0) === MINIMUM_PYTHON[0] && (minor ?? 0) < MINIMUM_PYTHON[1]);
	if (belowMinimum)
		return {
			ok: false,
			reason: `interpreter_below_minimum: ${pythonVersion}`,
		};
	const pip = runTool(interpreter, ["-I", "-m", "pip", "--version"]);
	if (pip.code !== 0)
		return { ok: false, reason: `pip_missing: ${pip.stderr.trim()}` };
	const pipVersion = /^pip (\d+\.\d+(?:\.\d+)?)/.exec(pip.stdout)?.[1];
	if (!pipVersion)
		return {
			ok: false,
			reason: `pip_version_unreadable: ${pip.stdout.trim()}`,
		};
	const help = runTool(interpreter, ["-I", "-m", "pip", "install", "--help"]);
	for (const flag of ["--require-hashes", "--only-binary", "--target"])
		if (!help.stdout.includes(flag))
			return { ok: false, reason: `pip_missing_flag: ${flag}` };
	return { ok: true, interpreter, pythonVersion, pipVersion };
}

async function openGate(): Promise<Gate> {
	const rawRoot = requireGateEnvironment(
		"PYTHON_INSTALL_GATE_ROOT",
		callerRoot,
	);
	const rawOutput = requireGateEnvironment(
		"PYTHON_INSTALL_GATE_OUTPUT",
		outputFile,
	);
	const rawInterpreter = requireGateEnvironment(
		"PYTHON_GATE_INTERPRETER",
		configuredInterpreter,
	);
	if (
		!isAbsolute(rawRoot) ||
		!isAbsolute(rawOutput) ||
		!isAbsolute(rawInterpreter)
	)
		throw new Error(
			"The gate root, output and interpreter must be absolute paths.",
		);
	const checkout = await realpath(CHECKOUT).catch(() => CHECKOUT);
	const configured = configuredGlobalInterpreter(rawInterpreter);
	const owner: GateOwner = {
		pid: process.pid,
		user: currentUser(),
		createdAt: new Date().toISOString(),
	};
	const trustedState: {
		interpreter?: string;
		pythonVersion?: string;
		pipVersion?: string;
	} = {};
	const claim = await openGateRoot({
		rawRoot,
		checkout,
		owner,
		trust: async () => {
			const trusted = await trustInterpreter(configured, rawRoot, checkout);
			if (!trusted.ok) return { ok: false, reason: trusted.reason };
			trustedState.interpreter = trusted.interpreter;
			trustedState.pythonVersion = trusted.pythonVersion;
			trustedState.pipVersion = trusted.pipVersion;
			return { ok: true };
		},
	});
	if (
		!trustedState.interpreter ||
		!trustedState.pythonVersion ||
		!trustedState.pipVersion
	)
		throw new Error("The trusted interpreter state was not captured.");
	return {
		claim,
		root: claim.root,
		output: ownGateOutput(claim.root, rawOutput),
		interpreter: trustedState.interpreter,
		pythonVersion: trustedState.pythonVersion,
		pipVersion: trustedState.pipVersion,
		resetManaged: (scope) => resetGateScope(claim, scope),
	};
}

function everyCasePassed(): boolean {
	return (
		caseResults.inactivePolicy &&
		caseResults.cancel &&
		caseResults.rollback &&
		caseResults.ty &&
		caseResults.ruff &&
		handoff.ty !== undefined &&
		handoff.ruff !== undefined
	);
}

describe.runIf(runReal)(
	"Python installation gate with the real coordinator",
	() => {
		let gate!: Gate;

		beforeAll(async () => {
			gate = await openGate();
		}, TEST_TIMEOUT_MS);

		afterAll(async () => {
			if (!gate) return;
			// The manifest is the reusable handoff: an explicit status, the five case
			// results, canonical CLI paths, hashes and measured versions. It is written
			// only after the claim is re-verified, so a refused or tampered root is never
			// mutated by this hook.
			const manifest: GateManifest = {
				gate: "python-install-gate",
				formatVersion: GATE_MANIFEST_FORMAT_VERSION,
				status: everyCasePassed() ? "complete" : "failed",
				createdAt: new Date().toISOString(),
				root: gate.root,
				marker: gate.claim.marker,
				owner: gate.claim.record.owner,
				token: gate.claim.record.token,
				nonce: gate.claim.record.nonce,
				interpreter: {
					path: gate.interpreter,
					pythonVersion: gate.pythonVersion,
					pipVersion: gate.pipVersion,
					provenance: "PYTHON_GATE_INTERPRETER",
				},
				platform: process.platform,
				architecture: process.arch,
				checkout: CHECKOUT,
				cases: { ...caseResults },
				servers: {
					...(handoff.ty ? { ty: handoff.ty } : {}),
					...(handoff.ruff ? { ruff: handoff.ruff } : {}),
				},
				retention:
					"Read-only handoff: reuse the committed executable paths, never rerun the destructive gate against this root, and create a fresh unique root for each run.",
				ciBaseline:
					"An approved system Python >= 3.8 whose pip supports --require-hashes, --only-binary and --target.",
			};
			await writeGateManifest(gate.claim, gate.output, manifest);
		}, TEST_TIMEOUT_MS);

		it("keeps the inactive Python recipes denied by the production policy", () => {
			expect(getRecipe("ty")).toBeUndefined();
			expect(getRecipe("ruff")).toBeUndefined();
			for (const id of ["ty", "ruff"] as const) {
				const decision = evaluateInstallPolicy({
					origin: "explicit",
					serverId: id,
					globalConfig: createDefaultConfig(),
					projectTrusted: true,
					platform: process.platform,
					architecture: process.arch,
					// A trusted interpreter is configured, yet the missing recipe still wins.
					pythonInterpreter: gate.interpreter,
				});
				expect(decision.allowed, id).toBe(false);
				if (!decision.allowed)
					expect(decision.reason, id).toBe("recipe_missing");
			}
			caseResults.inactivePolicy = true;
		});

		it(
			"cancels a real pip install at the installing phase and confirms termination",
			async () => {
				const managed = await gate.resetManaged("cancel");
				const records: ProcessLaunch[] = [];
				const phases: InstallPhase[] = [];
				const controller = new AbortController();
				const instance = coordinator(records, poisonedEnvironment(gate.root));
				try {
					const result = await instance.install({
						decision: gateOnlyAllowedDecision("ty"),
						managedStatePath: managed,
						pythonInterpreter: gate.interpreter,
						signal: controller.signal,
						onPhase: (phase) => {
							phases.push(phase);
							// Abort on the coordinator's own phase, before the spawned pip runs to
							// completion, instead of on a timer or a random moment.
							if (phase === "installing") controller.abort();
						},
					});
					expect(result).toEqual({
						status: "failed",
						reason: "cancelled",
					});
					// An aborting join resolves before the coordinator drains its own cleanup.
					await instance.shutdown();
					const recipe = INACTIVE_PYTHON_RECIPES.ty;
					const serverRoot = join(managed, "servers", recipe.serverId);
					await expect(
						access(join(serverRoot, recipe.revision)),
					).rejects.toThrow();
					expect(await readdir(serverRoot)).toEqual([]);
					await expect(
						access(
							join(
								managed,
								"locks",
								`${recipe.serverId}-${recipe.revision}.lock`,
							),
						),
					).rejects.toThrow();
					const audit = await auditRecords(managed);
					expect(audit).toEqual([
						expect.objectContaining({
							serverId: "ty",
							revision: recipe.revision,
							result: "cancelled",
						}),
					]);
					// Termination was confirmed, so no partial staging or lock is retained.
					expect(audit[0]?.residual).toBeUndefined();
					expect(phases).toEqual([
						"waiting-lock",
						"verifying",
						"missing",
						"installing",
						"failed",
					]);
					// The real pip child left the operating system.
					const pid = records.find(
						(entry) => entry.command === gate.interpreter,
					)?.pid;
					expect(pid).toBeDefined();
					expect(isProcessAlive(pid ?? 0)).toBe(false);
					caseResults.cancel = true;
				} finally {
					await instance.shutdown();
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"rolls a real pip install back to the previous ready sentinel when promotion fails",
			async () => {
				const managed = await gate.resetManaged("rollback");
				const recipe = INACTIVE_PYTHON_RECIPES.ty;
				const target = join(
					managed,
					"servers",
					recipe.serverId,
					recipe.revision,
				);
				await mkdir(target, { recursive: true });
				const sentinel = join(target, "previous-ready.txt");
				await writeFile(sentinel, "keep\n", "utf8");
				const records: ProcessLaunch[] = [];
				const instance = coordinator(
					records,
					poisonedEnvironment(gate.root),
					// Real pip installs and verifies the staging directory; only the promoted
					// revision is refused, so the rollback path runs against a real install.
					promoteFailingVerifier(recipe.revision),
				);
				try {
					const result = await instance.install({
						decision: gateOnlyAllowedDecision("ty"),
						managedStatePath: managed,
						pythonInterpreter: gate.interpreter,
					});
					expect(result.status).toBe("failed");
					// The real pip process actually ran.
					expect(
						records.some((entry) => entry.command === gate.interpreter),
					).toBe(true);
					// The owned previous ready marker is restored exactly, and the rejected
					// install was not promoted.
					expect(await readFile(sentinel, "utf8")).toBe("keep\n");
					expect(await exists(join(target, "requirements.txt"))).toBe(false);
					const leftovers = (
						await readdir(join(managed, "servers", recipe.serverId))
					).filter((name) => name.includes(".partial-"));
					expect(leftovers).toEqual([]);
					await expect(
						access(
							join(
								managed,
								"locks",
								`${recipe.serverId}-${recipe.revision}.lock`,
							),
						),
					).rejects.toThrow();
					expect(await auditRecords(managed)).toEqual([
						expect.objectContaining({
							serverId: "ty",
							revision: recipe.revision,
							result: "failed",
						}),
					]);
					caseResults.rollback = true;
				} finally {
					await instance.shutdown();
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"installs and verifies the pinned Ty wheel and exposes its canonical CLI",
			async () => {
				const managed = await gate.resetManaged("ty");
				const poisonMarker = await plantPoison(gate.root);
				const records: ProcessLaunch[] = [];
				const instance = coordinator(records, poisonedEnvironment(gate.root));
				try {
					const result = await instance.install({
						decision: gateOnlyAllowedDecision("ty"),
						managedStatePath: managed,
						pythonInterpreter: gate.interpreter,
					});
					expect(result.status, result.reason).toBe("ready");
					const recipe = INACTIVE_PYTHON_RECIPES.ty;
					const entry = selectPythonEntry(
						recipe,
						process.platform,
						process.arch,
					);
					if (!entry) throw new Error("The gate host has no pinned Ty wheel.");
					const serverRoot = join(managed, "servers", recipe.serverId);
					const target = join(serverRoot, recipe.revision);
					// One pip invocation, from the managed staging cwd, with a scrubbed
					// environment and the forced devnull pip configuration.
					expect(records).toHaveLength(1);
					const launch = records[0];
					if (!launch)
						throw new Error("No package manager launch was recorded.");
					expect(launch.command).toBe(gate.interpreter);
					expect(
						launch.cwd?.startsWith(
							join(serverRoot, `${recipe.revision}.partial-`),
						),
					).toBe(true);
					expect(launch.env?.PYTHONPATH).toBeUndefined();
					expect(launch.env?.PIP_INDEX_URL).toBeUndefined();
					expect(launch.env?.PIP_TARGET).toBeUndefined();
					expect(launch.env?.PIP_REQUIRE_VIRTUALENV).toBeUndefined();
					expect(launch.env?.PIP_CONFIG_FILE).toBe(
						process.platform === "win32" ? "nul" : "/dev/null",
					);
					expect(launch.env?.PATH).not.toContain(join(gate.root, "host-path"));
					// The poisoned interpreter hook never executed.
					expect(await exists(poisonMarker)).toBe(false);
					// Exactly one wheel and one dependency node: no auxiliary install.
					const requirements = await readFile(
						join(target, "requirements.txt"),
						"utf8",
					);
					const lines = requirements
						.split("\n")
						.filter((line) => line.length > 0);
					expect(lines).toEqual([`${entry.url}#sha256=${entry.sha256}`]);
					const distInfos = (await readdir(target, { withFileTypes: true }))
						.filter(
							(item) => item.isDirectory() && item.name.endsWith(".dist-info"),
						)
						.map((item) => item.name);
					expect(distInfos).toEqual([
						`${recipe.executable}-${recipe.expectedVersion}.dist-info`,
					]);
					// The committed CLI lives inside the owned root and reports its pinned
					// version natively.
					const executable = result.executable;
					if (!executable)
						throw new Error("The verified Ty executable is missing.");
					expect(executable.path).toBe(
						pythonExecutablePath(target, recipe.executable, process.platform),
					);
					expect(inside(gate.root, executable.path)).toBe(true);
					expect(executable.version).toBe(recipe.expectedVersion);
					expect((await stat(executable.path)).size).toBeGreaterThan(0);
					const executableSha = await sha256File(executable.path);
					const native = runTool(executable.path, ["--version"]);
					expect(native.code).toBe(0);
					expect(parsePythonServerVersion(recipe, native.stdout)).toBe(
						recipe.expectedVersion,
					);
					// The partial staging and the lock are gone; only the revision remains.
					expect(await readdir(serverRoot)).toEqual([recipe.revision]);
					handoff.ty = {
						serverId: recipe.serverId,
						revision: recipe.revision,
						executable: {
							path: executable.path,
							version: executable.version,
							sha256: executableSha,
						},
						requirementsSha256: createHash("sha256")
							.update(requirements)
							.digest("hex"),
						wheel: {
							fileName: entry.url.slice(entry.url.lastIndexOf("/") + 1),
							sha256: entry.sha256,
						},
						nativeOutput: native.stdout.trim().split(/\r?\n/, 1)[0] ?? "",
						phase: "ready",
					};
					caseResults.ty = true;
				} finally {
					await instance.shutdown();
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"installs Ruff as an independent recipe and never reinstalls Ty",
			async () => {
				const managed = await gate.resetManaged("ruff");
				const records: ProcessLaunch[] = [];
				const instance = coordinator(records, poisonedEnvironment(gate.root));
				try {
					const result = await instance.install({
						decision: gateOnlyAllowedDecision("ruff"),
						managedStatePath: managed,
						pythonInterpreter: gate.interpreter,
					});
					expect(result.status, result.reason).toBe("ready");
					const recipe = INACTIVE_PYTHON_RECIPES.ruff;
					const entry = selectPythonEntry(
						recipe,
						process.platform,
						process.arch,
					);
					if (!entry)
						throw new Error("The gate host has no pinned Ruff wheel.");
					const target = join(
						managed,
						"servers",
						recipe.serverId,
						recipe.revision,
					);
					expect(records).toHaveLength(1);
					const requirements = await readFile(
						join(target, "requirements.txt"),
						"utf8",
					);
					const lines = requirements
						.split("\n")
						.filter((line) => line.length > 0);
					expect(lines).toEqual([`${entry.url}#sha256=${entry.sha256}`]);
					expect(lines[0]).not.toContain("ty-");
					// Each recipe owns exactly one managed server: installing Ruff leaves Ty
					// untouched, whichever order the two requests run in.
					expect(await readdir(join(managed, "servers"))).toEqual(["ruff"]);
					const tyServers = join(gate.root, "ty", "managed", "servers");
					if (await exists(tyServers))
						expect(await readdir(tyServers)).toEqual(["ty"]);
					const executable = result.executable;
					if (!executable)
						throw new Error("The verified Ruff executable is missing.");
					expect(executable.version).toBe(recipe.expectedVersion);
					expect(inside(gate.root, executable.path)).toBe(true);
					const executableSha = await sha256File(executable.path);
					const native = runTool(executable.path, ["--version"]);
					expect(native.code).toBe(0);
					expect(parsePythonServerVersion(recipe, native.stdout)).toBe(
						recipe.expectedVersion,
					);
					handoff.ruff = {
						serverId: recipe.serverId,
						revision: recipe.revision,
						executable: {
							path: executable.path,
							version: executable.version,
							sha256: executableSha,
						},
						requirementsSha256: createHash("sha256")
							.update(requirements)
							.digest("hex"),
						wheel: {
							fileName: entry.url.slice(entry.url.lastIndexOf("/") + 1),
							sha256: entry.sha256,
						},
						nativeOutput: native.stdout.trim().split(/\r?\n/, 1)[0] ?? "",
						phase: "ready",
					};
					caseResults.ruff = true;
				} finally {
					await instance.shutdown();
				}
			},
			TEST_TIMEOUT_MS,
		);
	},
);
