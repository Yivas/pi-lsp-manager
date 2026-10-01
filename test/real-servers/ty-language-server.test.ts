import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasCapability } from "../../src/protocol/capabilities.js";
import { definition } from "../../src/tools/definition.js";
import { prepareRename } from "../../src/tools/prepare-rename.js";
import { references } from "../../src/tools/references.js";
import { rename } from "../../src/tools/rename.js";
import { symbols } from "../../src/tools/symbols.js";
import {
	createPythonFixture,
	createPythonIsolation,
	createPythonWorkspace,
	diagnoseFile,
	globalConfigPath,
	isolatedPath,
	loadPythonSemanticHandoff,
	PYTHON_API,
	PYTHON_CLEAN,
	PYTHON_CONSUMER,
	PYTHON_INVALID,
	PYTHON_VERSION_PROBE,
	type PythonFixture,
	type PythonIsolation,
	type PythonSemanticHandoff,
	pythonSemanticConfig,
	pythonServerConfig,
	toolValue,
	treeDelta,
	treeHashes,
	TY_PROBE_PYTHON_VERSION,
	tyConfig,
} from "./python-semantic-fixture.js";

// Real Ty 0.0.84 fixture. Opt-in with RUN_REAL_TY=1 and a read-only handoff from the real
// installation gate (`test/real-servers/python-install-gate.test.ts`). It never resolves ty
// from PATH or the checkout: the shared helper re-hashes the committed executable and re-checks
// its wheel against the frozen lock before the production session starts. Ty stays a candidate
// in the catalog; this fixture measures semantics and never promotes it.
//
// The server runs with an owned profile and temporary directory and with the minimal
// environment the production launch builds. The fixtures assert that environment at the real
// spawn call; the initialization values (`untrustedWorkspace`, `experimental.useUv`) are
// declared, not instrumented, so nothing here claims a sandbox or that no external command
// can ever run.

const runReal = process.env.RUN_REAL_TY === "1";

/** Bounded wait for the pool's late cleanup to reap a cancelled start. */
async function waitForNoLivePids(
	fixture: PythonFixture,
	timeoutMs: number,
): Promise<readonly number[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const live = fixture.livePids();
		if (live.length === 0 || Date.now() >= deadline) return live;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe.runIf(runReal)("Ty 0.0.84 language server", () => {
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
	 * Owns the profile and temp directories before any server launches. The poisoned profile
	 * declares the version the fixture does not pin, so a server that read this file instead
	 * of the workspace one would select the other branch.
	 */
	async function setUpIsolation(): Promise<PythonIsolation> {
		const isolation = await createPythonIsolation(interpreter());
		isolations.push(isolation.root);
		await writeFile(
			globalConfigPath(isolation.home, "ty"),
			tyConfig(interpreter(), TY_PROBE_PYTHON_VERSION),
			"utf8",
		);
		return isolation;
	}

	function fixtureFor(
		root: string,
		isolation: PythonIsolation,
		onStart?: () => void,
	): PythonFixture {
		if (!handoff) throw new Error("The handoff was not loaded.");
		const server = pythonServerConfig(handoff.servers.ty, {
			priority: 100,
			roles: ["diagnostics", "semantic", "mutation"],
			// Declared initialization values: the fixture proves the server starts with
			// them, never that they sandbox the process or kill every child.
			initialization: {
				untrustedWorkspace: true,
				experimental: { useUv: "off" },
			},
		});
		const created = createPythonFixture({
			workspace: root,
			config: pythonSemanticConfig([server]),
			available: new Set(["ty"]),
			environment: isolation.environment,
			...(onStart ? { onStart } : {}),
		});
		fixtures.push(created);
		return created;
	}

	async function setUp(onStart?: () => void): Promise<{
		root: string;
		isolation: PythonIsolation;
		fixture: PythonFixture;
	}> {
		if (!handoff) throw new Error("The handoff was not loaded.");
		const isolation = await setUpIsolation();
		const root = await createPythonWorkspace({
			"ty.toml": tyConfig(interpreter()),
			"clean.py": PYTHON_CLEAN,
			"invalid.py": PYTHON_INVALID,
			"version.py": PYTHON_VERSION_PROBE,
			"api.py": PYTHON_API,
			"consumer.py": PYTHON_CONSUMER,
		});
		workspaces.push(root);
		return { root, isolation, fixture: fixtureFor(root, isolation, onStart) };
	}

	it("returns an empty set for a clean file and a real type error for the invalid one", async () => {
		const { root, fixture: subject } = await setUp();
		expect(
			await diagnoseFile(
				subject.service,
				subject.context as never,
				join(root, "clean.py"),
			),
		).toEqual([]);
		const invalid = await diagnoseFile(
			subject.service,
			subject.context as never,
			join(root, "invalid.py"),
		);
		const error = invalid.find((entry) => entry.code === "invalid-assignment");
		expect(error).toBeDefined();
		expect(error?.source).toBe("ty");
		expect(error?.severity).toBe(1);
		expect(error?.line).toBe(5);
		expect(error?.serverId).toBe("ty");
		// The clean file produced no fabricated timeout: Ty answers the pull request with an
		// empty result. The coordinator is never consulted here, so this records that no
		// install path ran, not that the auto-install branch was exercised.
		expect(subject.installCalls()).toBe(0);
	}, 45_000);

	it("advertises the measured capabilities and resolves cross-file navigation", async () => {
		const { root, fixture: subject } = await setUp();
		const api = join(root, "api.py");
		const consumer = join(root, "consumer.py");
		const definitions = toolValue(
			await definition(
				subject.service,
				subject.context as never,
				{ filePath: consumer, line: 7, character: 16 },
				undefined,
			),
		).definitions as { path: string; line: number; character: number }[];
		expect(definitions).toEqual([{ path: "api.py", line: 6, character: 4 }]);
		const used = toolValue(
			await references(
				subject.service,
				subject.context as never,
				{ filePath: api, line: 6, character: 5, includeDeclaration: true },
				undefined,
			),
		).references as { path: string }[];
		expect(used.map((item) => item.path).sort()).toEqual([
			"api.py",
			"consumer.py",
			"consumer.py",
		]);
		const listed = toolValue(
			await symbols(
				subject.service,
				subject.context as never,
				{ filePath: api, scope: "document" },
				undefined,
			),
		).symbols as { name: string; kind: number }[];
		expect(listed).toEqual([
			expect.objectContaining({ name: "compute", kind: 12 }),
		]);
		const capabilities = subject.runtime()?.session.capabilities ?? {};
		for (const capability of [
			"diagnostics",
			"definition",
			"references",
			"documentSymbols",
			"prepareRename",
			"rename",
		] as const)
			expect(hasCapability(capabilities, capability), capability).toBe(true);
		// Recorded from the raw server payload, not from a compiled field: `ServerCapabilities`
		// does not declare `positionEncoding`, so the fixture reads it with an explicit cast.
		expect(
			(capabilities as { positionEncoding?: unknown }).positionEncoding,
		).toBe("utf-16");
		// Recorded, not claimed: Ty advertises code actions, but this fixture asserts nothing
		// about applying one.
		expect(hasCapability(capabilities, "codeActions")).toBe(true);
	}, 45_000);

	it("validates prepare rename, applies exactly the two owned files and restores them", async () => {
		const { root, fixture: subject } = await setUp();
		const api = join(root, "api.py");
		const consumer = join(root, "consumer.py");
		const before = await treeHashes(root);
		const prepared = toolValue(
			await prepareRename(
				subject.service,
				subject.context as never,
				{ filePath: api, line: 6, character: 5 },
				undefined,
			),
		).prepareRename;
		expect(prepared).toEqual({
			start: { line: 6, character: 4 },
			end: { line: 6, character: 11 },
		});
		const result = toolValue(
			await rename(
				subject.service,
				subject.context as never,
				{ filePath: api, line: 6, character: 5, newName: "compute_value" },
				undefined,
			),
		).mutation as { status: string };
		expect(result.status).toBe("applied");
		const after = await treeHashes(root);
		const delta = treeDelta(before, after);
		// Only the owned sample paths the server referenced changed: api.py and consumer.py.
		expect(delta).toEqual({
			added: [],
			changed: ["api.py", "consumer.py"],
			removed: [],
		});
		expect(await readFile(api, "utf8")).toContain(
			"def compute_value(value: int) -> int:",
		);
		const consumerText = await readFile(consumer, "utf8");
		expect(consumerText).toContain("from api import compute_value");
		expect(consumerText).toContain("compute_value(2)");
		// Fixture bookkeeping, not a production rollback path: the two owned sample files are
		// restored from the baseline constants, so the case ends where it started.
		await writeFile(api, PYTHON_API, "utf8");
		await writeFile(consumer, PYTHON_CONSUMER, "utf8");
		expect(await treeHashes(root)).toEqual(before);
	}, 45_000);

	it("cancels a start in flight and reclaims the process without a zombie", async () => {
		const controller = new AbortController();
		const { root, fixture: subject } = await setUp(() => controller.abort());
		const result = await definition(
			subject.service,
			subject.context as never,
			{ filePath: join(root, "api.py"), line: 6, character: 5 },
			controller.signal,
		);
		expect(result.details?.code).toBe("cancelled");
		// Post-conditions of the pool shutdown: no published entry, no active id and no
		// recorded child pid left alive once the drained cleanup finishes.
		await subject.pool.shutdown();
		expect(subject.pool.size()).toBe(0);
		expect(subject.pool.activeServerIds()).toEqual([]);
		expect(await waitForNoLivePids(subject, 20_000)).toEqual([]);
		expect(subject.installCalls()).toBe(0);
	}, 45_000);

	it("hands the real child only the owned environment, never the host profile", async () => {
		const { root, isolation, fixture: subject } = await setUp();
		const profileBefore = await treeHashes(isolation.home);
		await diagnoseFile(
			subject.service,
			subject.context as never,
			join(root, "clean.py"),
		);
		const environments = subject.spawnEnvironments();
		expect(environments.length).toBeGreaterThan(0);
		const expected = ["HOME", "PATH", "TEMP", "TMP"];
		for (const key of ["SystemRoot", "ComSpec"])
			if (process.env[key]) expected.push(key);
		for (const environment of environments) {
			// The production allowlist survivors, captured at the real spawn call: no
			// `APPDATA`, `USERPROFILE`, `VIRTUAL_ENV`, `PYTHON*` or `PIP_*` value is forwarded.
			expect(Object.keys(environment).sort()).toEqual([...expected].sort());
			expect(environment.HOME).toBe(isolation.home);
			expect(environment.TEMP).toBe(isolation.temp);
			expect(environment.TMP).toBe(isolation.temp);
			expect(environment.PATH).toBe(isolatedPath(interpreter()));
			// The trusted baseline PATH only: not the host PATH, and specifically not the
			// foreign virtual environment the measured host PATH carried.
			expect(environment.PATH?.toLowerCase()).not.toContain("hermes");
			expect(environment.PATH).not.toBe(process.env.PATH);
		}
		// No server rewrote the poisoned profile sentinel under the owned home.
		expect(treeDelta(profileBefore, await treeHashes(isolation.home))).toEqual({
			added: [],
			changed: [],
			removed: [],
		});
	}, 45_000);

	it("reads the workspace ty.toml: the pinned version selects the analyzed branch", async () => {
		const { root, isolation, fixture: first } = await setUp();
		const probe = join(root, "version.py");
		const configPath = join(root, "ty.toml");
		const pinned = tyConfig(interpreter());
		const baseline = await treeHashes(root);
		const profileBefore = await treeHashes(isolation.home);
		// Under the pinned 3.13 the branch is unreachable: ty reports its "code is unreachable"
		// hint and never the assignment error. The owned profile declares 3.14, and an unread
		// workspace file would fall back to that same 3.14 default, so either mistake would
		// surface as a severity-1 error here.
		const pinnedResult = await diagnoseFile(
			first.service,
			first.context as never,
			probe,
		);
		expect(pinnedResult.every((entry) => entry.severity !== 1)).toBe(true);
		expect(pinnedResult.map((entry) => entry.code)).not.toContain(
			"invalid-assignment",
		);
		// Switch only the workspace configuration, then restart through a fresh real session:
		// the same bytes now produce a type error. The first case is the discriminator: Ty's
		// default target is 3.14, so an unread workspace file would produce this same error.
		await writeFile(
			configPath,
			tyConfig(interpreter(), TY_PROBE_PYTHON_VERSION),
			"utf8",
		);
		await first.pool.shutdown();
		const second = fixtureFor(root, isolation);
		const switched = await diagnoseFile(
			second.service,
			second.context as never,
			probe,
		);
		const error = switched.find((entry) => entry.code === "invalid-assignment");
		expect(error).toBeDefined();
		expect(error?.line).toBe(8);
		expect(error?.serverId).toBe("ty");
		// Restore the owned configuration from the snapshot taken before the probe.
		await writeFile(configPath, pinned, "utf8");
		expect(await treeHashes(root)).toEqual(baseline);
		expect(treeDelta(profileBefore, await treeHashes(isolation.home))).toEqual({
			added: [],
			changed: [],
			removed: [],
		});
	}, 45_000);
});
