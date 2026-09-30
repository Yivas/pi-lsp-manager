import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDefaultConfig,
	type LoadedConfig,
} from "../../src/config/load.js";
import { discoverFiles } from "../../src/resolve/discover.js";
import { TrustedOperationService } from "../../src/tools/shared.js";

const CANDIDATES = ["ty", "ruff"] as const;

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-lsp-python-explore-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true, maxRetries: 10 });
	}
});

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
	for (const id of CANDIDATES) {
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
	return { service, config, coordinator, pool, start, resolveCommand, load };
}

async function expectUntouchedWorkspace(root: string): Promise<void> {
	expect((await readdir(root)).sort()).toEqual(["sample.py"]);
	await expect(access(join(root, "managed"))).rejects.toThrow();
}

describe("Python exploration boundary", () => {
	it.each(CANDIDATES)(
		"never installs, audits or starts an LSP server while reading a %s file",
		async (id) => {
			const root = await temporaryDirectory();
			await writeFile(join(root, "sample.py"), "VALUE: int = 1\n", "utf8");
			const { service, coordinator, pool, start, resolveCommand } =
				harness(root);

			await expect(
				service.read(
					context(root, true),
					"sample.py",
					"diagnostics",
					async (operation) => operation.server.id,
				),
			).rejects.toMatchObject({ code: "server_unavailable" });

			// Only the read seam ran; the install seam, the pool and the LSP process did not.
			expect(coordinator).not.toHaveBeenCalled();
			expect(pool).not.toHaveBeenCalled();
			expect(start).not.toHaveBeenCalled();
			expect(resolveCommand).toHaveBeenCalled();
			if (id === "ty" || id === "ruff") await expectUntouchedWorkspace(root);
		},
	);

	it.each(CANDIDATES)("warmup for %s never starts a process", async (id) => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "sample.py"), "VALUE: int = 1\n", "utf8");
		const { service, coordinator, pool, start } = harness(root);
		await expect(service.warmup(context(root, true), id)).rejects.toMatchObject(
			{
				code: "server_unavailable",
			},
		);
		expect(coordinator).not.toHaveBeenCalled();
		expect(pool).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		await expectUntouchedWorkspace(root);
	});

	it("discovers Python files without touching managed state", async () => {
		const root = await temporaryDirectory();
		await writeFile(join(root, "sample.py"), "VALUE: int = 1\n", "utf8");
		await writeFile(join(root, "stub.pyi"), "VALUE: int\n", "utf8");
		const discovered = await discoverFiles({
			workspacePath: root,
			paths: ["."],
		});
		expect(discovered.files.map((file) => file.relativePath).sort()).toEqual([
			"sample.py",
			"stub.pyi",
		]);
		await expect(access(join(root, "managed"))).rejects.toThrow();
	});
});
