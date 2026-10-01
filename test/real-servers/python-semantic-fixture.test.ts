import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyValidatedEdits } from "../../src/edits/apply.js";
import { normalizeWorkspaceEdit } from "../../src/edits/normalize.js";
import { validateWorkspaceEdit } from "../../src/edits/validate.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import {
	GATE_MANIFEST_FORMAT_VERSION,
	type GateHandoffServer,
	type GateManifest,
} from "./python-install-gate-ownership.js";
import {
	CHECKOUT,
	createPythonFixture,
	createPythonIsolation,
	createPythonWorkspace,
	EXPECTED_PYTHON_SERVER_VERSIONS,
	frozenWheel,
	isolatedPath,
	loadPythonSemanticHandoff,
	PYTHON_CLEAN,
	pythonSemanticConfig,
	pythonServerConfig,
} from "./python-semantic-fixture.js";

// Deterministic unit for the shared Python semantic fixture seam. It runs with no handoff,
// no interpreter and no package manager: it proves the fail-closed handoff guard, the
// environment the production session hands to a real `spawn` call, and the rejection of a
// workspace edit that points outside the owned root before any byte is written. Only the
// opt-in real fixtures start a native Ty or Ruff server.

const roots: string[] = [];

async function ownRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

async function sha256File(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 50,
		});
});

describe("Python semantic handoff guard", () => {
	/** Writes a synthetic manifest into an owned root and returns the guard verdict. */
	async function load(
		mutate: (manifest: GateManifest) => void = () => undefined,
	) {
		const root = await ownRoot("pi-lsp-python-handoff-");
		const binaries = join(root, "bin");
		await mkdir(binaries, { recursive: true });
		const servers = {} as Record<"ty" | "ruff", GateHandoffServer>;
		for (const id of ["ty", "ruff"] as const) {
			const wheel = frozenWheel(id);
			if (!wheel)
				throw new Error(`The frozen ${id} lock has no wheel for this host.`);
			const executable = join(binaries, `${id}.exe`);
			await writeFile(executable, `${id}\n`, "utf8");
			servers[id] = {
				serverId: id,
				revision: `${id}-${EXPECTED_PYTHON_SERVER_VERSIONS[id]}_pip-target_lock-1`,
				executable: {
					path: executable,
					version: EXPECTED_PYTHON_SERVER_VERSIONS[id],
					sha256: await sha256File(executable),
				},
				requirementsSha256: "0".repeat(64),
				wheel: { fileName: basename(wheel.url), sha256: wheel.sha256 },
				nativeOutput: `${id} ${EXPECTED_PYTHON_SERVER_VERSIONS[id]}`,
				phase: "ready",
			};
		}
		const manifest: GateManifest = {
			gate: "python-install-gate",
			formatVersion: GATE_MANIFEST_FORMAT_VERSION,
			status: "complete",
			createdAt: new Date(0).toISOString(),
			root,
			marker: join(root, ".python-install-gate-owner.json"),
			owner: {
				pid: process.pid,
				user: "fixture",
				createdAt: new Date(0).toISOString(),
			},
			token: "fixture-token",
			nonce: "fixture-nonce",
			interpreter: {
				path: process.execPath,
				pythonVersion: "3.13.7",
				pipVersion: "26.1.2",
				provenance: "fixture",
			},
			platform: process.platform,
			architecture: process.arch,
			checkout: CHECKOUT,
			cases: {
				inactivePolicy: true,
				cancel: true,
				rollback: true,
				ty: true,
				ruff: true,
			},
			servers,
			retention: "fixture",
			ciBaseline: "fixture",
		};
		mutate(manifest);
		const file = join(root, "handoff.json");
		await writeFile(file, JSON.stringify(manifest), "utf8");
		return loadPythonSemanticHandoff(file);
	}

	it("refuses a missing, blank, relative or unreadable handoff path", async () => {
		const cases = [
			["", "is required"],
			["   ", "is required"],
			[basename("handoff.json"), "must be an absolute path"],
			[join(tmpdir(), "pi-lsp-missing-handoff.json"), "could not be read"],
		] as const;
		for (const [handoffPath, reason] of cases) {
			const result = await loadPythonSemanticHandoff(handoffPath);
			expect(result.ok, handoffPath).toBe(false);
			if (!result.ok) expect(result.reason, handoffPath).toContain(reason);
		}
	}, 30_000);

	it("accepts a complete manifest and refuses every tampered variant", async () => {
		const accepted = await load();
		expect(accepted.ok).toBe(true);
		if (accepted.ok) {
			expect(accepted.handoff.platform).toBe(process.platform);
			expect(accepted.handoff.servers.ty.version).toBe(
				EXPECTED_PYTHON_SERVER_VERSIONS.ty,
			);
			expect(
				accepted.handoff.servers.ruff.executable.endsWith("ruff.exe") ||
					accepted.handoff.servers.ruff.executable.endsWith("ruff"),
			).toBe(true);
		}
		const tampered: {
			name: string;
			mutate: (manifest: GateManifest) => void;
			reason: string;
		}[] = [
			{
				name: "wrong kind",
				mutate: (manifest) => {
					(manifest as { gate: string }).gate = "other-gate";
				},
				reason: "wrong kind",
			},
			{
				name: "failed status",
				mutate: (manifest) => {
					manifest.status = "failed";
				},
				reason: "not complete",
			},
			{
				name: "no owned root",
				mutate: (manifest) => {
					manifest.root = "";
				},
				reason: "no owned root",
			},
			{
				name: "unexpected version",
				mutate: (manifest) => {
					if (manifest.servers.ty)
						manifest.servers.ty.executable.version = "0.0.0";
				},
				reason: "unexpected version",
			},
			{
				name: "an executable that changed since the handoff",
				mutate: (manifest) => {
					if (manifest.servers.ty)
						manifest.servers.ty.executable.sha256 = "0".repeat(64);
				},
				reason: "hash changed since the gate wrote the handoff",
			},
			{
				name: "a wheel that does not match the frozen lock",
				mutate: (manifest) => {
					if (manifest.servers.ruff)
						manifest.servers.ruff.wheel.sha256 = "0".repeat(64);
				},
				reason: "does not match the frozen lock",
			},
			{
				name: "a foreign platform",
				mutate: (manifest) => {
					manifest.platform = process.platform === "linux" ? "win32" : "linux";
				},
				reason: "unsupported platform",
			},
			{
				name: "a root inside the checkout",
				mutate: (manifest) => {
					// Both executables must stay inside the recorded root for the manifest to
					// parse, so they move into the checkout with it.
					const bundled = join(CHECKOUT, "package.json");
					manifest.root = CHECKOUT;
					for (const id of ["ty", "ruff"] as const) {
						const server = manifest.servers[id];
						if (server) server.executable.path = bundled;
					}
				},
				reason: "must stay outside the checkout",
			},
		];
		for (const { name, mutate, reason } of tampered) {
			const result = await load(mutate);
			expect(result.ok, name).toBe(false);
			if (!result.ok) expect(result.reason, name).toContain(reason);
		}
	}, 30_000);
});

describe("Python semantic fixture isolation", () => {
	/**
	 * The production launch keeps exactly these keys; `SystemRoot` and `ComSpec` only exist
	 * on hosts that define them.
	 */
	function expectedKeys(): string[] {
		const keys = ["HOME", "PATH", "TEMP", "TMP"];
		for (const key of ["SystemRoot", "ComSpec"])
			if (process.env[key]) keys.push(key);
		return keys.sort();
	}

	it("drops every host-only key at the real spawn boundary", async () => {
		const isolation = await createPythonIsolation(process.execPath);
		const workspace = await createPythonWorkspace({ "clean.py": PYTHON_CLEAN });
		roots.push(isolation.root, workspace);
		const server = pythonServerConfig(
			{
				id: "ty",
				executable: process.execPath,
				version: "0.0.0-fixture",
				sha256: "0".repeat(64),
			},
			{ priority: 100, roles: ["diagnostics"] },
		);
		// A hostile host environment: every key here is either dropped by the production
		// allowlist or replaced by an owned directory. The command is the Node.js binary with
		// the fixture argv, so a real child spawns, records its environment and exits without
		// ever becoming a language server.
		const created = createPythonFixture({
			workspace,
			config: pythonSemanticConfig([server]),
			available: new Set(["ty"]),
			environment: {
				...isolation.environment,
				APPDATA: join("C:", "foreign", "AppData", "Roaming"),
				USERPROFILE: join("C:", "foreign", "users", "someone"),
				LOCALAPPDATA: join("C:", "foreign", "AppData", "Local"),
				VIRTUAL_ENV: join("D:", "foreign", "venv"),
				PYTHONPATH: join("D:", "foreign", "site-packages"),
				PIP_INDEX_URL: "https://127.0.0.1:9/simple",
				XDG_CONFIG_HOME: join("D:", "foreign", "xdg"),
			},
		});
		try {
			const response = await diagnostics(
				created.service,
				created.context as never,
				{ filePath: join(workspace, "clean.py") },
				undefined,
			);
			// The child is not a language server, so the tool fails instead of reporting a
			// fabricated empty result.
			expect(response.details?.code).not.toBe("ok");
			const environments = created.spawnEnvironments();
			expect(environments.length).toBeGreaterThan(0);
			for (const environment of environments) {
				expect(Object.keys(environment).sort()).toEqual(expectedKeys());
				expect(environment.HOME).toBe(isolation.home);
				expect(environment.TEMP).toBe(isolation.temp);
				expect(environment.TMP).toBe(isolation.temp);
				expect(environment.PATH).toBe(isolatedPath(process.execPath));
				expect(environment.PATH).not.toBe(process.env.PATH);
				// No poisoned value survives under any key.
				expect(JSON.stringify(environment)).not.toContain("foreign");
			}
		} finally {
			await created.pool.shutdown();
		}
	}, 30_000);

	it("rejects a workspace edit outside the owned root before any write", async () => {
		const root = await ownRoot("pi-lsp-python-edit-");
		const workspace = join(root, "workspace");
		await mkdir(workspace, { recursive: true });
		const inside = join(workspace, "inside.py");
		const outside = join(root, "outside.py");
		const baseline = "VALUE = 1\n";
		await writeFile(inside, baseline, "utf8");
		await writeFile(outside, "KEEP = 1\n", "utf8");
		const edit = (path: string, newText: string) => ({
			changes: {
				[pathToFileURL(path).href]: [
					{
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 0 },
						},
						newText,
					},
				],
			},
		});
		// Positive control: the same production lifecycle still applies an owned edit.
		const owned = normalizeWorkspaceEdit(edit(inside, "# header\n"));
		expect(owned).toBeDefined();
		if (!owned) throw new Error("The owned edit did not normalize.");
		const validated = await validateWorkspaceEdit(owned, {
			workspacePath: workspace,
		});
		expect(validated).toBeDefined();
		if (!validated) throw new Error("The owned edit did not validate.");
		const applied = await applyValidatedEdits(validated);
		expect(applied.status).toBe("applied");
		expect(await readFile(inside, "utf8")).toBe(`# header\n${baseline}`);
		// Owned-data restoration, not a production rollback path.
		await writeFile(inside, baseline, "utf8");
		expect(await readFile(inside, "utf8")).toBe(baseline);
		// Negative: the identical lifecycle refuses an edit that escapes the owned root, and
		// the production flow never reaches the apply step for it.
		const escaped = normalizeWorkspaceEdit(edit(outside, "# escape\n"));
		expect(escaped).toBeDefined();
		if (!escaped) throw new Error("The escaping edit did not normalize.");
		expect(
			await validateWorkspaceEdit(escaped, { workspacePath: workspace }),
		).toBeUndefined();
		expect(await readFile(outside, "utf8")).toBe("KEEP = 1\n");
	}, 30_000);
});
