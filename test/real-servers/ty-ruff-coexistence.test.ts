import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { diagnostics } from "../../src/tools/diagnostics.js";
import {
	createPythonFixture,
	createPythonIsolation,
	createPythonWorkspace,
	diagnoseFile,
	globalConfigPath,
	loadPythonSemanticHandoff,
	PYTHON_INVALID,
	PYTHON_UNUSED_IMPORT,
	type PythonFixture,
	type PythonIsolation,
	type PythonSemanticHandoff,
	pythonSemanticConfig,
	pythonServerConfig,
	type ReportedDiagnostic,
	ruffConfig,
	TY_PROBE_PYTHON_VERSION,
	tyConfig,
} from "./python-semantic-fixture.js";

// Real Ty and Ruff coexistence on one Python file. Opt-in with RUN_REAL_PYTHON_COEXISTENCE=1
// and the read-only gate handoff. Ty stays the principal and Ruff the auxiliary, exactly as
// the catalog declares them (both candidates). The auxiliary never receives install rights,
// and a missing auxiliary route leaves the principal alone.

const runReal = process.env.RUN_REAL_PYTHON_COEXISTENCE === "1";

/** One file carrying both an unused import (F401) and a type error (invalid-assignment). */
const PYTHON_MIXED = `"""Mixed fixture: an unused import and a type error on the same file."""

from __future__ import annotations

import os

VALUE: int = "not an integer"
`;

const TYPE_ERROR_LINE = 7;
const UNUSED_IMPORT_LINE = 5;

describe.runIf(runReal)("Ty and Ruff coexistence on one Python file", () => {
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
	 * Owned profile for both servers. Each poisoned file declares what the workspace
	 * configuration contradicts, so a server that read the profile instead would change the
	 * observable diagnostics. On Windows the servers resolve `%APPDATA%`, which the production
	 * allowlist never forwards, so the profile is declared rather than reachable there.
	 */
	async function setUpIsolation(): Promise<PythonIsolation> {
		const isolation = await createPythonIsolation(interpreter());
		isolations.push(isolation.root);
		await writeFile(
			globalConfigPath(isolation.home, "ty"),
			tyConfig(interpreter(), TY_PROBE_PYTHON_VERSION),
			"utf8",
		);
		await writeFile(
			globalConfigPath(isolation.home, "ruff"),
			'[lint]\nignore = ["F401"]\n',
			"utf8",
		);
		return isolation;
	}

	function config() {
		if (!handoff) throw new Error("The handoff was not loaded.");
		return pythonSemanticConfig([
			pythonServerConfig(handoff.servers.ty, {
				priority: 100,
				roles: ["diagnostics", "semantic", "mutation"],
				// Declared initialization values, not instrumented: the fixture proves the
				// servers start with them, never that they sandbox the process.
				initialization: {
					untrustedWorkspace: true,
					experimental: { useUv: "off" },
				},
			}),
			pythonServerConfig(handoff.servers.ruff, {
				priority: 90,
				roles: ["diagnostics"],
			}),
		]);
	}

	async function setUp(options: {
		available: ReadonlySet<"ty" | "ruff">;
		trusted?: boolean;
	}): Promise<{ root: string; fixture: PythonFixture }> {
		if (!handoff) throw new Error("The handoff was not loaded.");
		const isolation = await setUpIsolation();
		const root = await createPythonWorkspace({
			"ty.toml": tyConfig(interpreter()),
			"ruff.toml": ruffConfig(),
			"invalid.py": PYTHON_INVALID,
			"lint.py": PYTHON_UNUSED_IMPORT,
			"mixed.py": PYTHON_MIXED,
		});
		workspaces.push(root);
		const created = createPythonFixture({
			workspace: root,
			config: config(),
			available: options.available,
			environment: isolation.environment,
			...(options.trusted === undefined ? {} : { trusted: options.trusted }),
		});
		fixtures.push(created);
		return { root, fixture: created };
	}

	it("labels both servers on one file in a stable order without consulting an installer", async () => {
		const { root, fixture: subject } = await setUp({
			available: new Set(["ty", "ruff"]),
		});
		const entries = await diagnoseFile(
			subject.service,
			subject.context as never,
			join(root, "mixed.py"),
		);
		expect(new Set(entries.map((entry) => entry.serverId))).toEqual(
			new Set(["ty", "ruff"]),
		);
		const typeError = entries.find(
			(entry) => entry.serverId === "ty" && entry.code === "invalid-assignment",
		);
		expect(typeError?.line).toBe(TYPE_ERROR_LINE);
		const unusedImport = entries.find(
			(entry) => entry.serverId === "ruff" && entry.code === "F401",
		);
		expect(unusedImport?.line).toBe(UNUSED_IMPORT_LINE);
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
		// The coordinator is never consulted in these fixtures: this records that no install
		// path ran, not that the auto-install branch was exercised.
		expect(subject.installCalls()).toBe(0);
		expect(subject.pool.activeServerIds()).toEqual(["ruff", "ty"]);
	}, 45_000);

	it("runs the principal alone when the auxiliary route is missing", async () => {
		const { root, fixture: subject } = await setUp({
			available: new Set(["ty"]),
		});
		const entries = await diagnoseFile(
			subject.service,
			subject.context as never,
			join(root, "mixed.py"),
		);
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((entry) => entry.serverId === "ty")).toBe(true);
		expect(subject.starts()).toBe(1);
		expect(subject.installCalls()).toBe(0);
		expect(subject.pool.activeServerIds()).toEqual(["ty"]);
	}, 45_000);

	it("refuses an untrusted project before starting anything", async () => {
		const { root, fixture: subject } = await setUp({
			available: new Set(["ty", "ruff"]),
			trusted: false,
		});
		const result = await diagnostics(
			subject.service,
			subject.context as never,
			{ filePath: join(root, "mixed.py") },
			undefined,
		);
		expect(result.details?.code).toBe("untrusted_project");
		// No session was started and no installer was consulted. The configuration loader is
		// the fixture's own seam, so this does not claim the production loader was skipped.
		expect(subject.starts()).toBe(0);
		expect(subject.installCalls()).toBe(0);
	}, 45_000);
});
