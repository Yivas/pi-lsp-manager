import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRecipe } from "../../src/install/catalog.js";
import {
	buildPackageManagerEnvironment,
	createCmdShimLaunch,
	createControlledNpmFiles,
	createPackageManagerLaunch,
	prepareControlledNpmFiles,
	readControlledNpmFiles,
	validateControlledNpmFiles,
} from "../../src/install/launch.js";

const temporaryDirectories: string[] = [];
async function temporaryDirectory() {
	const path = await mkdtemp(join(tmpdir(), "pi-lsp-manager-launch-"));
	temporaryDirectories.push(path);
	return path;
}
afterEach(async () => {
	for (const path of temporaryDirectories.splice(0)) {
		await import("node:fs/promises").then(({ rm }) =>
			rm(path, { recursive: true, force: true }),
		);
	}
});

const recipe = getRecipe("typescript");
if (!recipe) throw new Error("TypeScript recipe is required.");

describe("controlled npm inputs", () => {
	it("generates a complete immutable direct-dependency lock with exact registry tarballs and SRI", () => {
		const files = createControlledNpmFiles(recipe);
		const lock = JSON.parse(files.packageLock) as {
			packages: Record<
				string,
				{ resolved?: string; integrity?: string; bin?: Record<string, string> }
			>;
		};
		for (const pin of recipe.packages) {
			const entry = lock.packages[`node_modules/${pin.name}`];
			expect(entry?.resolved).toContain(
				`${pin.name.slice(pin.name.lastIndexOf("/") + 1)}-${pin.version}.tgz`,
			);
			expect(entry?.integrity).toBe(pin.integrity);
		}
		expect(Object.keys(lock.packages).sort()).toEqual([
			"",
			"node_modules/typescript",
			"node_modules/typescript-language-server",
		]);
		expect(
			lock.packages["node_modules/typescript-language-server"]?.bin,
		).toEqual({
			"typescript-language-server": "lib/cli.mjs",
		});
		expect(lock.packages["node_modules/typescript"]?.bin).toEqual({
			tsc: "bin/tsc",
			tsserver: "bin/tsserver",
		});
		expect(validateControlledNpmFiles(recipe, files)).toBe(true);
	});

	it("uses only staging-owned npm configuration and rejects a tampered lock", async () => {
		const staging = await temporaryDirectory();
		await prepareControlledNpmFiles(staging, recipe);
		const files = await readControlledNpmFiles(staging);
		expect(validateControlledNpmFiles(recipe, files)).toBe(true);
		await writeFile(
			join(staging, "package-lock.json"),
			files.packageLock.replace(
				recipe.packages[0]?.integrity ?? "",
				"sha512-tampered",
			),
		);
		expect(
			validateControlledNpmFiles(recipe, await readControlledNpmFiles(staging)),
		).toBe(false);
		const launch = createPackageManagerLaunch(
			recipe,
			staging,
			"/safe/npm",
			{
				PATH: "/safe/bin",
				HOME: "/host/home",
				NODE_OPTIONS: "--require hostile",
				npm_config_registry: "https://hostile.invalid",
				HTTP_PROXY: "http://user:secret@proxy.invalid",
			},
			"linux",
		);
		expect(launch.args).toContain("ci");
		expect(launch.args).not.toContain("install");
		expect(launch.args).not.toContain("--package-lock=false");
		expect(launch.env).toMatchObject({
			HOME: join(staging, "home"),
			npm_config_cache: join(staging, "cache"),
			HTTP_PROXY: "http://user:secret@proxy.invalid",
		});
		expect(launch.env.NODE_OPTIONS).toBeUndefined();
		expect(launch.env.npm_config_registry).toBeUndefined();
		expect(await readFile(join(staging, "npmrc"), "utf8")).toContain(
			"ignore-scripts=true",
		);
	});

	it("supports a cased Windows PATH and rejects cmd expansion syntax while allowing spaces", () => {
		const staging = String.raw`C:\managed state\staging`;
		expect(
			buildPackageManagerEnvironment(
				{ Path: String.raw`C:\safe path`, HTTPS_PROXY: "proxy", HOME: "host" },
				"win32",
				staging,
			),
		).toMatchObject({
			PATH: String.raw`C:\safe path`,
			HOME: join(staging, "home"),
			HTTPS_PROXY: "proxy",
		});
		expect(
			createCmdShimLaunch(
				String.raw`C:\safe path\npm.cmd`,
				["ci", "--cache", String.raw`C:\safe path\cache`],
				String.raw`C:\Windows\System32\cmd.exe`,
			),
		).toEqual({
			command: String.raw`C:\Windows\System32\cmd.exe`,
			args: [
				"/d",
				"/s",
				"/c",
				String.raw`""C:\safe path\npm.cmd" "ci" "--cache" "C:\safe path\cache""`,
			],
			shell: false,
			windowsVerbatimArguments: true,
		});
		expect(
			createCmdShimLaunch(String.raw`C:\safe\npm.cmd`, ["%EVIL%"], "cmd.exe"),
		).toBeUndefined();
		expect(
			createCmdShimLaunch(String.raw`C:\safe\npm.cmd`, ["a&b"], "cmd.exe"),
		).toBeUndefined();
	});
});
