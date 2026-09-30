import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getRecipe,
	getRecipeRevision,
	INACTIVE_PYTHON_RECIPES,
	selectPythonEntry,
} from "../../src/install/catalog.js";
import {
	createControlledPythonRequirements,
	prepareControlledPythonFiles,
	pythonAdapter,
	readControlledPythonFiles,
} from "../../src/install/adapters/python.js";
import { pythonExecutablePath } from "../../src/install/adapters/python.js";
import { recipeAdapter } from "../../src/install/adapters/index.js";

const toolchain = "C:/Tools/Python312/python.exe";

function context(
	platform: NodeJS.Platform,
	architecture: NodeJS.Architecture,
	pythonInterpreter: string | undefined = toolchain,
) {
	return {
		platform,
		architecture,
		...(pythonInterpreter ? { pythonInterpreter } : {}),
	};
}

function withoutInterpreter(
	platform: NodeJS.Platform,
	architecture: NodeJS.Architecture,
) {
	return { platform, architecture };
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-lsp-python-adapter-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true, maxRetries: 10 });
	}
});

describe("frozen Python lock", () => {
	it("keeps six typed wheel entries and stays outside the public recipe registry", () => {
		const entries = [
			...INACTIVE_PYTHON_RECIPES.ty.entries,
			...INACTIVE_PYTHON_RECIPES.ruff.entries,
		];
		expect(entries).toHaveLength(6);
		expect(new Set(entries.map((entry) => entry.url)).size).toBe(6);
		for (const entry of entries) {
			expect(entry.url).toMatch(
				/^https:\/\/files\.pythonhosted\.org\/packages\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{40,64}\/.+\.whl$/,
			);
			expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
		}
		for (const serverId of ["ty", "ruff"] as const) {
			expect(INACTIVE_PYTHON_RECIPES[serverId].targets).toHaveLength(3);
			expect(getRecipe(serverId), serverId).toBeUndefined();
			expect(getRecipeRevision(serverId), serverId).toBeUndefined();
		}
		expect(INACTIVE_PYTHON_RECIPES.ty.revision).toBe(
			"ty-0.0.84_pip-target_lock-1",
		);
		expect(INACTIVE_PYTHON_RECIPES.ruff.revision).toBe(
			"ruff-0.16.9_pip-target_lock-1",
		);
	});
});

describe("controlled Python requirements", () => {
	it("emits one line for the host wheel and never the other platforms", () => {
		const recipe = INACTIVE_PYTHON_RECIPES.ty;
		const requirements = createControlledPythonRequirements(recipe, {
			platform: "win32",
			architecture: "x64",
		});
		const entry = selectPythonEntry(recipe, "win32", "x64");
		if (!entry) throw new Error("Windows entry is required.");
		expect(requirements).toBe(`${entry.url}#sha256=${entry.sha256}\n`);
		expect(requirements.trim().split("\n")).toHaveLength(1);
		for (const other of recipe.entries.filter(
			(candidate) => candidate.url !== entry.url,
		))
			expect(requirements).not.toContain(other.url);
	});

	it("keeps Ty and Ruff independent so neither installs the other", () => {
		const ty = createControlledPythonRequirements(INACTIVE_PYTHON_RECIPES.ty, {
			platform: "linux",
			architecture: "x64",
		});
		const ruff = createControlledPythonRequirements(
			INACTIVE_PYTHON_RECIPES.ruff,
			{ platform: "linux", architecture: "x64" },
		);
		expect(ty).toContain("ty-0.0.84");
		expect(ruff).toContain("ruff-0.16.9");
		expect(ty).not.toContain("ruff-");
		expect(ruff).not.toContain("ty-");
	});

	it("refuses a platform outside the frozen targets before the manager starts", async () => {
		expect(() =>
			createControlledPythonRequirements(INACTIVE_PYTHON_RECIPES.ty, {
				platform: "freebsd",
				architecture: "x64",
			}),
		).toThrow();
		expect(
			pythonAdapter.preflight(
				INACTIVE_PYTHON_RECIPES.ty,
				context("freebsd", "x64"),
			),
		).toEqual({ ok: false, reason: "unsupported_platform" });
		expect(
			pythonAdapter.preflight(
				INACTIVE_PYTHON_RECIPES.ty,
				context("linux", "arm64"),
			),
		).toEqual({ ok: false, reason: "unsupported_platform" });
	});

	it("requires a configured trusted interpreter before any managed state", () => {
		expect(
			pythonAdapter.preflight(
				INACTIVE_PYTHON_RECIPES.ty,
				context("linux", "x64"),
			),
		).toEqual({ ok: true });
		expect(
			pythonAdapter.preflight(
				INACTIVE_PYTHON_RECIPES.ty,
				withoutInterpreter("linux", "x64"),
			),
		).toEqual({ ok: false, reason: "package_manager_missing" });
		expect(
			pythonAdapter.preflight(
				INACTIVE_PYTHON_RECIPES.ty,
				context("linux", "x64", "python3"),
			),
		).toEqual({ ok: false, reason: "package_manager_missing" });
	});

	it("writes, reads and revalidates the controlled requirement on disk", async () => {
		const staging = await temporaryDirectory();
		const host = context("linux", "x64");
		await prepareControlledPythonFiles(
			staging,
			INACTIVE_PYTHON_RECIPES.ty,
			host,
		);
		const onDisk = await readControlledPythonFiles(staging);
		expect(onDisk.requirements).toBe(
			await readFile(join(staging, "requirements.txt"), "utf8"),
		);
		expect(
			pythonAdapter.validate(INACTIVE_PYTHON_RECIPES.ty, onDisk, host),
		).toBe(true);
		// A different target context no longer matches the staged requirement.
		expect(
			pythonAdapter.validate(
				INACTIVE_PYTHON_RECIPES.ty,
				onDisk,
				context("darwin", "arm64"),
			),
		).toBe(false);
		// Project content can never satisfy the validation.
		expect(
			pythonAdapter.validate(
				INACTIVE_PYTHON_RECIPES.ty,
				{ requirements: "pyproject.toml\n" },
				host,
			),
		).toBe(false);
		await writeFile(join(staging, "requirements.txt"), "tampered\n", "utf8");
		expect(
			pythonAdapter.validate(
				INACTIVE_PYTHON_RECIPES.ty,
				await readControlledPythonFiles(staging),
				host,
			),
		).toBe(false);
	});

	it("resolves only the configured safe interpreter as the manager", async () => {
		const resolution = async (pythonInterpreter?: string) =>
			pythonAdapter.resolveManager({
				recipe: INACTIVE_PYTHON_RECIPES.ty,
				context: context("linux", "x64", pythonInterpreter),
				command: "pip",
				environment: {},
				resolve: async () => "/never-used",
			});
		expect(await resolution()).toBe(toolchain);
		expect(await resolution("python3")).toBeUndefined();
		expect(await resolution("C:/a/../b/python.exe")).toBeUndefined();
	});

	it("rejects an unknown recipe kind instead of falling through to the Python adapter", () => {
		expect(() => recipeAdapter({ kind: "rust" } as never)).toThrow();
	});

	it("locates the verified executable under bin with the platform suffix", () => {
		expect(pythonExecutablePath("/managed/ty", "ty", "linux")).toBe(
			join("/managed/ty", "bin", "ty"),
		);
		expect(pythonExecutablePath("/managed/ty", "ty", "win32")).toBe(
			join("/managed/ty", "bin", "ty.exe"),
		);
	});
});
