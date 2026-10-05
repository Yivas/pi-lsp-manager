import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	FORMAT_RECIPES,
	getRecipe,
	VUE_RECIPE,
	type InstallRecipe,
} from "../../src/install/catalog.js";
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
if (!recipe || recipe.kind !== "npm")
	throw new Error("TypeScript recipe is required.");

const jsonRecipe = FORMAT_RECIPES["vscode-json-language-server"];

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

	it("validates Vue's complete locked dependency closure before installation", () => {
		const files = createControlledNpmFiles(VUE_RECIPE);
		const lock = JSON.parse(files.packageLock) as {
			packages: Record<string, { integrity?: string; resolved?: string }>;
		};
		expect(Object.keys(lock.packages)).toHaveLength(100);
		expect(lock.packages["node_modules/@vue/language-server"]?.integrity).toBe(
			VUE_RECIPE.packages[0]?.integrity,
		);
		expect(validateControlledNpmFiles(VUE_RECIPE, files)).toBe(true);

		const entry = (
			packages: Record<string, Record<string, unknown>>,
			key: string,
		) => {
			const value = packages[key];
			if (!value) throw new Error(`Missing fixture package: ${key}`);
			return value;
		};
		for (const tamper of [
			(packages: Record<string, Record<string, unknown>>) => {
				entry(packages, "node_modules/@vue/language-server").integrity =
					"sha512-tampered";
			},
			(packages: Record<string, Record<string, unknown>>) => {
				entry(packages, "node_modules/vue").resolved =
					"https://attacker.example/vue.tgz";
			},
			(packages: Record<string, Record<string, unknown>>) => {
				entry(packages, "node_modules/vue").hasInstallScript = true;
			},
			(packages: Record<string, Record<string, unknown>>) => {
				packages["node_modules/../escaped"] = {
					...entry(packages, "node_modules/vue"),
				};
			},
			(packages: Record<string, Record<string, unknown>>) => {
				(entry(packages, "").dependencies as Record<string, string>).extra =
					"1.0.0";
			},
		]) {
			const lockfile = JSON.parse(JSON.stringify(VUE_RECIPE.lockfile)) as {
				packages: Record<string, Record<string, unknown>>;
			};
			tamper(lockfile.packages);
			expect(() =>
				createControlledNpmFiles({ ...VUE_RECIPE, lockfile } as InstallRecipe),
			).toThrow();
		}
	});

	it("accepts the exact JSON core-js script pin while retaining npm script suppression", () => {
		const files = createControlledNpmFiles(jsonRecipe);
		const lock = JSON.parse(files.packageLock) as {
			packages: Record<
				string,
				{ version?: string; integrity?: string; hasInstallScript?: boolean }
			>;
		};
		expect(Object.keys(lock.packages)).toHaveLength(33);
		expect(lock.packages["node_modules/core-js"]).toEqual(
			expect.objectContaining({
				version: "3.50.0",
				integrity:
					"sha512-BRWgOLKkFeCgRudR6zrs8p9XJZcE14grzKMMssoYrk6krtuEZ7MTKPIY5RzOnqsEKIR9kst7wNzphttraT+Yqw==",
				hasInstallScript: true,
			}),
		);
		expect(
			Object.entries(lock.packages)
				.filter(([, entry]) => entry.hasInstallScript === true)
				.map(([path]) => path),
		).toEqual(["node_modules/core-js"]);
		expect(files.userConfig).toContain("ignore-scripts=true");
		expect(files.globalConfig).toContain("ignore-scripts=true");
		const launch = createPackageManagerLaunch(
			jsonRecipe,
			"/managed/json-staging",
			"/safe/npm",
			{ PATH: "/safe/bin" },
			"linux",
		);
		expect(launch.args).toContain("ci");
		expect(launch.args).toContain("--ignore-scripts");
		expect(validateControlledNpmFiles(jsonRecipe, files)).toBe(true);
	});

	it.each([
		[
			"a changed core-js version",
			(packages: Record<string, Record<string, unknown>>) => {
				const entry = packages["node_modules/core-js"];
				if (!entry) throw new Error("Missing core-js lock entry.");
				entry.version = "3.50.1";
			},
		],
		[
			"a changed core-js integrity",
			(packages: Record<string, Record<string, unknown>>) => {
				const entry = packages["node_modules/core-js"];
				if (!entry) throw new Error("Missing core-js lock entry.");
				entry.integrity = "sha512-tampered";
			},
		],
		[
			"the core-js pin resolved from a different tarball",
			(packages: Record<string, Record<string, unknown>>) => {
				const entry = packages["node_modules/core-js"];
				if (!entry) throw new Error("Missing core-js lock entry.");
				entry.resolved = "https://registry.npmjs.org/other/-/other-3.50.0.tgz";
			},
		],
		[
			"the same script flag under a different package path",
			(packages: Record<string, Record<string, unknown>>) => {
				const entry = packages["node_modules/core-js"];
				if (!entry) throw new Error("Missing core-js lock entry.");
				packages["node_modules/unrelated/node_modules/core-js"] = {
					...entry,
				};
			},
		],
		[
			"an install script on another package",
			(packages: Record<string, Record<string, unknown>>) => {
				const entry = packages["node_modules/regenerator-runtime"];
				if (!entry) throw new Error("Missing runtime lock entry.");
				entry.hasInstallScript = true;
			},
		],
	] as const)("rejects %s", (_name, tamper) => {
		const lockfile = JSON.parse(JSON.stringify(jsonRecipe.lockfile)) as {
			packages: Record<string, Record<string, unknown>>;
		};
		tamper(lockfile.packages);
		expect(() =>
			createControlledNpmFiles({ ...jsonRecipe, lockfile } as InstallRecipe),
		).toThrow();
	});

	it("rejects the JSON core-js exception for a different recipe identity", () => {
		for (const changedRecipe of [
			{ ...jsonRecipe, serverId: "other-server" },
			{ ...jsonRecipe, revision: `${jsonRecipe.revision}-changed` },
		]) {
			expect(() =>
				createControlledNpmFiles(changedRecipe as InstallRecipe),
			).toThrow();
		}
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
			NODE_DISABLE_COMPILE_CACHE: "1",
			HTTP_PROXY: "http://user:secret@proxy.invalid",
		});
		expect(launch.env.NODE_OPTIONS).toBeUndefined();
		expect(launch.env.NODE_COMPILE_CACHE).toBeUndefined();
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

	it("disables the Node compile cache on every platform and drops inherited Node flags", () => {
		const staging = join(tmpdir(), "pi-lsp-manager-managed");
		const base = {
			PATH: "/safe/bin",
			NODE_OPTIONS: "--require hostile",
			NODE_COMPILE_CACHE: String.raw`C:\hostile\node-compile-cache`,
			NODE_DISABLE_COMPILE_CACHE: "0",
		};
		for (const platform of [
			"aix",
			"darwin",
			"freebsd",
			"linux",
			"openbsd",
			"sunos",
			"win32",
		] as const) {
			const env = buildPackageManagerEnvironment(base, platform, staging);
			expect(env.NODE_DISABLE_COMPILE_CACHE, platform).toBe("1");
			expect(env.NODE_COMPILE_CACHE, platform).toBeUndefined();
			expect(env.NODE_OPTIONS, platform).toBeUndefined();
		}
	});
});
