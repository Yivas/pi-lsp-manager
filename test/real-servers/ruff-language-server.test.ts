import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasCapability } from "../../src/protocol/capabilities.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import {
	createPythonFixture,
	createPythonIsolation,
	createPythonWorkspace,
	diagnoseFile,
	globalConfigPath,
	loadPythonSemanticHandoff,
	PYTHON_CLEAN,
	PYTHON_CONFIG_PROBE,
	PYTHON_UNUSED_IMPORT,
	type PythonFixture,
	type PythonIsolation,
	type PythonSemanticHandoff,
	pythonSemanticConfig,
	pythonServerConfig,
	ruffConfig,
	ruffProbeConfig,
	toolValue,
	treeDelta,
	treeHashes,
} from "./python-semantic-fixture.js";

// Real Ruff 0.16.9 fixture. Opt-in with RUN_REAL_RUFF=1 and a read-only handoff from the
// real installation gate. Ruff is an auxiliary diagnostics-only candidate: this fixture
// measures its diagnostics, its batch reporting, its configuration read, its write footprint
// and its shutdown, and records that it advertises no navigation or rename capability. The
// server runs with an owned profile and the minimal production environment, and the fixture
// asserts that footprint instead of claiming a host-wide guarantee: only the analyzed
// workspace and the owned isolation root are hashed, so nothing here speaks for the rest of
// the host.

const runReal = process.env.RUN_REAL_RUFF === "1";

describe.runIf(runReal)("Ruff 0.16.9 language server", () => {
	let handoff: PythonSemanticHandoff | undefined;
	const workspaces: string[] = [];
	const isolations: string[] = [];
	const fixtures: PythonFixture[] = [];

	beforeAll(async () => {
		const result = await loadPythonSemanticHandoff();
		if (!result.ok)
			throw new Error(`Python semantic handoff refused: ${result.reason}`);
		handoff = result.handoff;
	}, 60_000);

	afterEach(async () => {
		for (const created of fixtures.splice(0))
			await created.pool.shutdown().catch(() => undefined);
		for (const root of workspaces.splice(0))
			await rm(root, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 50,
			});
		for (const root of isolations.splice(0))
			await rm(root, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 50,
			});
	});

	function interpreter(): string {
		if (!handoff) throw new Error("The handoff was not loaded.");
		return handoff.interpreter;
	}

	/**
	 * Owns the profile and cache directories before any server launches. The poisoned profile
	 * ignores `F401`: a server that read the user configuration instead of the workspace one
	 * would hide the warning this fixture asserts.
	 */
	async function setUpIsolation(): Promise<PythonIsolation> {
		const isolation = await createPythonIsolation(interpreter());
		isolations.push(isolation.root);
		await writeFile(
			globalConfigPath(isolation.home, "ruff"),
			'[lint]\nignore = ["F401"]\n',
			"utf8",
		);
		return isolation;
	}

	function fixtureFor(root: string, isolation: PythonIsolation): PythonFixture {
		if (!handoff) throw new Error("The handoff was not loaded.");
		const server = pythonServerConfig(handoff.servers.ruff, {
			priority: 90,
			roles: ["diagnostics"],
		});
		const created = createPythonFixture({
			workspace: root,
			config: pythonSemanticConfig([server]),
			available: new Set(["ruff"]),
			environment: isolation.environment,
		});
		fixtures.push(created);
		return created;
	}

	/** A plain-file `.venv` sentinel proves the analyzer never mutates a project environment. */
	async function setUp(configText?: string): Promise<{
		root: string;
		isolation: PythonIsolation;
		fixture: PythonFixture;
	}> {
		const isolation = await setUpIsolation();
		const root = await createPythonWorkspace({
			"ruff.toml": configText ?? ruffConfig(),
			"clean.py": PYTHON_CLEAN,
			"lint.py": PYTHON_UNUSED_IMPORT,
			"probe.py": PYTHON_CONFIG_PROBE,
		});
		workspaces.push(root);
		await mkdir(join(root, ".venv"), { recursive: true });
		await writeFile(join(root, ".venv", "keep.txt"), "keep\n", "utf8");
		return { root, isolation, fixture: fixtureFor(root, isolation) };
	}

	it("reports an F401 warning for an unused import and nothing for a clean file", async () => {
		const { root, fixture: subject } = await setUp();
		expect(
			await diagnoseFile(
				subject.service,
				subject.context as never,
				join(root, "clean.py"),
			),
		).toEqual([]);
		const lint = await diagnoseFile(
			subject.service,
			subject.context as never,
			join(root, "lint.py"),
		);
		const warning = lint.find((entry) => entry.code === "F401");
		expect(warning).toBeDefined();
		expect(warning?.source).toBe("Ruff");
		expect(warning?.severity).toBe(2);
		expect(warning?.line).toBe(5);
		expect(warning?.serverId).toBe("ruff");
		// The coordinator is never consulted here: this records that no install path ran, not
		// that the auto-install branch was exercised.
		expect(subject.installCalls()).toBe(0);
	}, 45_000);

	it("keeps the analyzed workspace and the owned root byte-identical", async () => {
		const { root, isolation, fixture: subject } = await setUp();
		const workspaceBefore = await treeHashes(root);
		const isolationBefore = await treeHashes(isolation.root);
		const entries = await diagnoseFile(
			subject.service,
			subject.context as never,
			join(root, "probe.py"),
		);
		expect(entries.length).toBeGreaterThan(0);
		// A read-only analysis adds, changes and removes nothing in the analyzed workspace: no
		// `.ruff_cache`, no rewritten source and no touched `.venv` sentinel.
		expect(treeDelta(workspaceBefore, await treeHashes(root))).toEqual({
			added: [],
			changed: [],
			removed: [],
		});
		// The owned isolation root is untouched too: the profile sentinels, the temp tree and
		// every other owned path are byte-identical after the analysis.
		expect(
			treeDelta(isolationBefore, await treeHashes(isolation.root)),
		).toEqual({
			added: [],
			changed: [],
			removed: [],
		});
		const capabilities = subject.runtime()?.session.capabilities ?? {};
		expect(hasCapability(capabilities, "diagnostics")).toBe(true);
		// Recorded from the raw server payload: Ruff advertises no navigation, symbol or
		// rename method, matching its auxiliary diagnostics-only role.
		for (const capability of [
			"definition",
			"references",
			"documentSymbols",
			"prepareRename",
			"rename",
		] as const)
			expect(hasCapability(capabilities, capability), capability).toBe(false);
	}, 45_000);

	it("answers a batch scan with every python file, the expected findings and no failure", async () => {
		const { root, fixture: subject } = await setUp();
		const result = toolValue(
			await diagnostics(
				subject.service,
				subject.context as never,
				{ paths: [root], servers: ["ruff"], fileLimit: 10 },
				undefined,
			),
		);
		expect(result.serversUsed).toEqual(["ruff"]);
		expect(result.failures).toEqual([]);
		const files = result.files as {
			path: string;
			servers: { serverId: string; diagnostics: { code?: string }[] }[];
		}[];
		// Exactly the owned Python sources: an empty batch would satisfy every other assertion in
		// this case, so the count is the point.
		expect(files.map((file) => file.path).sort()).toEqual([
			"clean.py",
			"lint.py",
			"probe.py",
		]);
		expect(new Set(files.map((file) => file.path)).size).toBe(files.length);
		for (const file of files) {
			expect(file.servers.map((item) => item.serverId)).toEqual(["ruff"]);
			const codes = file.servers.flatMap((item) =>
				item.diagnostics.map((entry) => entry.code),
			);
			if (file.path === "lint.py") expect(codes).toContain("F401");
			else if (file.path === "clean.py") expect(codes).toEqual([]);
		}
	}, 45_000);

	it("reads the workspace ruff.toml: the configured rules replace the default set", async () => {
		const { root, isolation, fixture: first } = await setUp();
		const configPath = join(root, "ruff.toml");
		const baseline = await treeHashes(root);
		// The default rule set reports the unused import and does not select the long-line
		// rule, so the probe file yields exactly one finding.
		const defaults = await diagnoseFile(
			first.service,
			first.context as never,
			join(root, "probe.py"),
		);
		expect(defaults.map((entry) => entry.code)).toContain("F401");
		expect(defaults.map((entry) => entry.code)).not.toContain("E501");
		// A valid configuration that selects the long-line rule and ignores the unused import:
		// an unread file would keep the first result, and an invalid file would fall back to
		// the defaults and also keep it. Only a real read can flip both findings.
		await writeFile(configPath, ruffProbeConfig(), "utf8");
		await first.pool.shutdown();
		const second = fixtureFor(root, isolation);
		const configured = await diagnoseFile(
			second.service,
			second.context as never,
			join(root, "probe.py"),
		);
		expect(configured.map((entry) => entry.code)).toContain("E501");
		expect(configured.map((entry) => entry.code)).not.toContain("F401");
		expect(configured.every((entry) => entry.serverId === "ruff")).toBe(true);
		// Restore the owned configuration from the snapshot taken before the probe.
		await writeFile(configPath, ruffConfig(), "utf8");
		expect(await treeHashes(root)).toEqual(baseline);
	}, 45_000);

	it("reclaims the server on shutdown without a zombie", async () => {
		const { root, fixture: subject } = await setUp();
		await diagnoseFile(
			subject.service,
			subject.context as never,
			join(root, "clean.py"),
		);
		expect(subject.pool.size()).toBe(1);
		await subject.pool.shutdown();
		expect(subject.pool.size()).toBe(0);
		expect(subject.pool.activeServerIds()).toEqual([]);
		expect(subject.livePids()).toEqual([]);
	}, 45_000);
});
