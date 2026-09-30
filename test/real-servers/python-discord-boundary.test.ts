import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDefaultConfig,
	type LoadedConfig,
} from "../../src/config/load.js";
import {
	type ActiveOperation,
	TrustedOperationService,
} from "../../src/tools/shared.js";

// This file exercises the deterministic service boundary over owned copies of the Python
// fixtures. The real Discord.py analysis needs a real ty/ruff install and the three-OS
// matrix, so it stays a pending gate instead of a hash-format assertion that cannot fail.
const FIXTURES = resolve("test/fixtures/python");

const temporaryDirectories: string[] = [];

async function ownedFixtureCopy(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-lsp-discord-boundary-"));
	temporaryDirectories.push(root);
	const workspace = join(root, "workspace");
	await cp(FIXTURES, workspace, { recursive: true });
	return workspace;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true, maxRetries: 10 });
	}
});

async function treeHash(root: string, relative = ""): Promise<string> {
	const hash = createHash("sha256");
	const entries = (
		await readdir(join(root, relative), { withFileTypes: true })
	).sort((left, right) => (left.name < right.name ? -1 : 1));
	for (const entry of entries) {
		const path = relative ? join(relative, entry.name) : entry.name;
		if (entry.isDirectory()) {
			hash.update(`d:${path}\n`);
			hash.update(await treeHash(root, path));
		} else {
			hash.update(`f:${path}\n`);
			hash.update(await readFile(join(root, path)));
		}
	}
	return hash.digest("hex");
}

/** Host state the boundary must never create: venv, bytecode cache and pip configuration. */
const FORBIDDEN_MARKERS = [
	".venv",
	"__pycache__",
	"pip.ini",
	"sitecustomize.py",
];

function markerPresence(root: string): Record<string, boolean> {
	return Object.fromEntries(
		FORBIDDEN_MARKERS.map((marker) => [marker, existsSync(join(root, marker))]),
	);
}

function context(cwd: string, trusted: boolean): ExtensionContext {
	return {
		cwd,
		signal: undefined,
		isProjectTrusted: () => trusted,
	} as unknown as ExtensionContext;
}

function harness(root: string) {
	const config = createDefaultConfig();
	config.network = "auto";
	config.autoInstall = true;
	for (const id of ["ty", "ruff"] as const) {
		const server = config.servers[id];
		if (!server) throw new Error(`${id} is missing from the default catalog.`);
		server.enabled = true;
		server.autoInstall = true;
	}
	const coordinator = vi.fn();
	const pool = vi.fn();
	const start = vi.fn();
	const resolveCommand = vi.fn(async () => undefined);
	const load = vi.fn(
		async (): Promise<LoadedConfig> => ({
			config,
			paths: {
				globalConfigPath: join(root, "global.json"),
				projectConfigPath: join(root, ".pi", "pi-lsp-manager.json"),
				managedStatePath: join(root, "managed"),
			},
			globalLayer: "absent",
			projectLayer: "not-read",
		}),
	);
	const service = new TrustedOperationService({
		coordinator,
		pool,
		start,
		resolveCommand,
		load,
		platform: "linux",
		architecture: "x64",
	});
	return { service, coordinator, pool, start, resolveCommand };
}

describe("Discord.py boundary fixture", () => {
	it("ships clean, invalid and fake-stub fixtures labelled as plumbing only", async () => {
		expect((await readdir(FIXTURES)).sort()).toEqual([
			"clean.py",
			"discord-stub-fixture",
			"invalid.py",
		]);
		const stub = await readFile(
			join(FIXTURES, "discord-stub-fixture", "stub.pyi"),
			"utf8",
		);
		expect(stub).toContain("Fake Discord plumbing stub");
		expect(stub).not.toMatch(/discord\.py 2\.7\.1/);
		const clean = await readFile(join(FIXTURES, "clean.py"), "utf8");
		const invalid = await readFile(join(FIXTURES, "invalid.py"), "utf8");
		expect(clean).toContain("VALUE: int = 1");
		expect(invalid).toContain('VALUE: int = "not an integer"');
	});

	it("detects a mutation, so the no-op boundary assertion below can fail", async () => {
		const workspace = await ownedFixtureCopy();
		const before = await treeHash(workspace);
		expect(markerPresence(workspace).__pycache__).toBe(false);
		await mkdir(join(workspace, "__pycache__"));
		expect(markerPresence(workspace).__pycache__).toBe(true);
		expect(await treeHash(workspace)).not.toBe(before);
	});

	it("denies the read before the install seams and leaves the workspace untouched", async () => {
		const workspace = await ownedFixtureCopy();
		const before = await treeHash(workspace);
		const markersBefore = markerPresence(workspace);
		const { service, coordinator, pool, start, resolveCommand } =
			harness(workspace);
		const work = vi.fn(
			async (operation: ActiveOperation) => operation.server.id,
		);

		await expect(
			service.read(context(workspace, true), "clean.py", "diagnostics", work),
		).rejects.toMatchObject({ code: "server_unavailable" });

		// The command lookup ran, but the denial lands before any install, pool, process or
		// semantic-work seam. The real semantic read stays in the pending todo below.
		expect(resolveCommand).toHaveBeenCalled();
		expect(work).not.toHaveBeenCalled();
		expect(coordinator).not.toHaveBeenCalled();
		expect(pool).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		// The fixture bytes and the host markers are exactly as before the operation.
		expect(await treeHash(workspace)).toBe(before);
		expect(markerPresence(workspace)).toEqual(markersBefore);
		await expect(stat(join(workspace, ".venv"))).rejects.toThrow();
		await expect(stat(join(workspace, "__pycache__"))).rejects.toThrow();
	});

	it.todo(
		"measures the real interpreter boundary once the Python activation gate is ready",
	);
});
