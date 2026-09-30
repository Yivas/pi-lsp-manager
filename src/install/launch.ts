import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, posix, win32 } from "node:path";
import type { InstallRecipe, NpmInstallRecipe } from "./catalog.js";

export const PROXY_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;
const CONTROLLED_NPMRC = "audit=false\nfund=false\nignore-scripts=true\n";

/**
 * The npm helpers keep accepting the recipe union so the frozen npm call sites do not
 * change type, but they only ever run for the npm variant the adapter dispatches.
 */
function npmRecipe(recipe: InstallRecipe): NpmInstallRecipe {
	if (recipe.kind !== "npm") throw new Error("Npm recipe required.");
	return recipe;
}

export interface ControlledNpmFiles {
	packageJson: string;
	packageLock: string;
	userConfig: string;
	globalConfig: string;
}

export interface PackageManagerLaunch {
	command: string;
	args: readonly string[];
	cwd: string;
	env: Readonly<Record<string, string>>;
	platform: NodeJS.Platform;
}

function findEnvironmentValue(
	environment: NodeJS.ProcessEnv,
	key: string,
): string | undefined {
	const match = Object.entries(environment).find(
		([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
	);
	return match?.[1];
}

function packageTarballUrl(
	recipe: NpmInstallRecipe,
	name: string,
	version: string,
): string {
	const escapedName = name.replace("@", "").replaceAll("/", "%2f");
	const filename = `${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
	return `${recipe.registry}/${escapedName}/-/${filename}`;
}

function lockedNpmPackages(
	recipe: NpmInstallRecipe,
	dependencies: Record<string, string>,
): Readonly<Record<string, unknown>> {
	const lock = recipe.lockfile;
	if (
		!lock ||
		lock.lockfileVersion !== 3 ||
		lock.requires !== true ||
		lock.name !== `pi-lsp-manager-${recipe.serverId}` ||
		lock.version !== "0.0.0"
	)
		throw new Error("Invalid internal npm lockfile.");
	const root = lock.packages[""] as
		| { name?: unknown; version?: unknown; dependencies?: unknown }
		| undefined;
	if (
		!root ||
		root.name !== lock.name ||
		root.version !== lock.version ||
		!root.dependencies ||
		typeof root.dependencies !== "object" ||
		Array.isArray(root.dependencies) ||
		JSON.stringify(root.dependencies) !== JSON.stringify(dependencies)
	)
		throw new Error("Internal npm lockfile has different direct dependencies.");
	for (const [path, raw] of Object.entries(lock.packages)) {
		if (!path) continue;
		const entry = raw as {
			version?: unknown;
			integrity?: unknown;
			resolved?: unknown;
			license?: unknown;
			hasInstallScript?: unknown;
			link?: unknown;
		} | null;
		if (
			!path.startsWith("node_modules/") ||
			path
				.split("/")
				.some((segment) => !segment || segment === "." || segment === "..") ||
			!entry ||
			typeof entry.version !== "string" ||
			!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(entry.version) ||
			typeof entry.integrity !== "string" ||
			!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity) ||
			typeof entry.license !== "string" ||
			!entry.license ||
			typeof entry.resolved !== "string" ||
			entry.hasInstallScript === true ||
			entry.link === true
		)
			throw new Error("Internal npm lockfile contains an unpinned package.");
		let url: URL;
		try {
			url = new URL(entry.resolved);
		} catch {
			throw new Error("Internal npm lockfile contains an invalid package URL.");
		}
		if (
			url.protocol !== "https:" ||
			url.hostname !== "registry.npmjs.org" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!url.pathname.endsWith(".tgz")
		)
			throw new Error(
				"Internal npm lockfile contains an external package URL.",
			);
	}
	for (const pin of recipe.packages) {
		const entry = lock.packages[`node_modules/${pin.name}`] as
			| { version?: unknown; integrity?: unknown; license?: unknown }
			| undefined;
		if (
			!entry ||
			entry.version !== pin.version ||
			entry.integrity !== pin.integrity ||
			entry.license !== pin.license
		)
			throw new Error("Internal npm lockfile disagrees with a package pin.");
	}
	return lock.packages;
}

export function createControlledNpmFiles(
	recipe: InstallRecipe,
): ControlledNpmFiles {
	const npm = npmRecipe(recipe);
	const dependencies = Object.fromEntries(
		npm.packages.map((pin) => [pin.name, pin.version]),
	);
	const packages: Record<string, unknown> = {
		"": {
			name: `pi-lsp-manager-${npm.serverId}`,
			version: "0.0.0",
			private: true,
			dependencies,
		},
	};
	for (const pin of npm.packages) {
		packages[`node_modules/${pin.name}`] = {
			version: pin.version,
			resolved: packageTarballUrl(npm, pin.name, pin.version),
			integrity: pin.integrity,
			license: pin.license,
			engines: { node: pin.node },
			bin:
				pin.name === "typescript-language-server"
					? { "typescript-language-server": "lib/cli.mjs" }
					: pin.name === "typescript"
						? { tsc: "bin/tsc", tsserver: "bin/tsserver" }
						: undefined,
		};
	}
	const locked = npm.lockfile
		? lockedNpmPackages(npm, dependencies)
		: undefined;
	return {
		packageJson: `${JSON.stringify({
			name: `pi-lsp-manager-${npm.serverId}`,
			version: "0.0.0",
			private: true,
			dependencies,
		})}\n`,
		packageLock: `${JSON.stringify(
			npm.lockfile
				? { ...npm.lockfile, packages: locked }
				: {
						name: `pi-lsp-manager-${npm.serverId}`,
						version: "0.0.0",
						lockfileVersion: 3,
						requires: true,
						packages,
					},
		)}\n`,
		userConfig: CONTROLLED_NPMRC,
		globalConfig: CONTROLLED_NPMRC,
	};
}

export function validateControlledNpmFiles(
	recipe: InstallRecipe,
	files: ControlledNpmFiles,
): boolean {
	const expected = createControlledNpmFiles(npmRecipe(recipe));
	return (
		files.packageJson === expected.packageJson &&
		files.packageLock === expected.packageLock &&
		files.userConfig === expected.userConfig &&
		files.globalConfig === expected.globalConfig
	);
}

export async function prepareControlledNpmFiles(
	stagingPath: string,
	recipe: InstallRecipe,
): Promise<ControlledNpmFiles> {
	const files = createControlledNpmFiles(recipe);
	await Promise.all([
		mkdir(join(stagingPath, "home"), { recursive: true, mode: 0o700 }),
		mkdir(join(stagingPath, "tmp"), { recursive: true, mode: 0o700 }),
		mkdir(join(stagingPath, "cache"), { recursive: true, mode: 0o700 }),
	]);
	await Promise.all([
		writeFile(join(stagingPath, "package.json"), files.packageJson, {
			encoding: "utf8",
			mode: 0o600,
		}),
		writeFile(join(stagingPath, "package-lock.json"), files.packageLock, {
			encoding: "utf8",
			mode: 0o600,
		}),
		writeFile(join(stagingPath, "npmrc"), files.userConfig, {
			encoding: "utf8",
			mode: 0o600,
		}),
		writeFile(join(stagingPath, "global-npmrc"), files.globalConfig, {
			encoding: "utf8",
			mode: 0o600,
		}),
	]);
	return files;
}

export async function readControlledNpmFiles(
	stagingPath: string,
): Promise<ControlledNpmFiles> {
	const [packageJson, packageLock, userConfig, globalConfig] =
		await Promise.all([
			readFile(join(stagingPath, "package.json"), "utf8"),
			readFile(join(stagingPath, "package-lock.json"), "utf8"),
			readFile(join(stagingPath, "npmrc"), "utf8"),
			readFile(join(stagingPath, "global-npmrc"), "utf8"),
		]);
	return { packageJson, packageLock, userConfig, globalConfig };
}

/** Builds a new environment. Project variables and npm configuration never cross this boundary. */
export function buildPackageManagerEnvironment(
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	stagingPath: string,
): Readonly<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const key of ["PATH", "SystemRoot", "ComSpec"]) {
		const value = findEnvironmentValue(environment, key);
		if (value) result[key] = value;
	}
	if (platform === "win32" && !result.PATH) {
		const pathValue = findEnvironmentValue(environment, "Path");
		if (pathValue) result.PATH = pathValue;
	}
	for (const key of PROXY_KEYS) {
		const value = environment[key];
		if (value) result[key] = value;
	}
	const home = join(stagingPath, "home");
	const temp = join(stagingPath, "tmp");
	result.HOME = home;
	result.USERPROFILE = home;
	result.TEMP = temp;
	result.TMP = temp;
	// npm 11 enables Node's module compile cache under `os.tmpdir()` (TEMP/TMP,
	// here the staging tmp). A deep staging path on Windows pushes that cache path
	// past the OS limit and cache initialization spins in CPU without output. Set
	// the disable flag explicitly so the managed run never inherits a host value.
	result.NODE_DISABLE_COMPILE_CACHE = "1";
	result.npm_config_userconfig = join(stagingPath, "npmrc");
	result.npm_config_globalconfig = join(stagingPath, "global-npmrc");
	result.npm_config_cache = join(stagingPath, "cache");
	return result;
}

export function createPackageManagerLaunch(
	recipe: InstallRecipe,
	stagingPath: string,
	resolvedNpmCommand: string,
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): PackageManagerLaunch {
	const npm = npmRecipe(recipe);
	return {
		command: resolvedNpmCommand,
		args: [
			"ci",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--foreground-scripts=false",
			"--registry",
			npm.registry,
			"--userconfig",
			join(stagingPath, "npmrc"),
			"--globalconfig",
			join(stagingPath, "global-npmrc"),
			"--cache",
			join(stagingPath, "cache"),
		],
		cwd: stagingPath,
		env: buildPackageManagerEnvironment(environment, platform, stagingPath),
		platform,
	};
}

export interface ServerLaunch {
	command: string;
	args: readonly string[];
	shell: false;
	windowsVerbatimArguments?: true;
}

function isSafeCmdSegment(value: string): boolean {
	return value.length > 0 && !/[&|<>^%"!\r\n\0]/.test(value);
}

function quoteForCmd(value: string): string | undefined {
	return isSafeCmdSegment(value) ? `"${value}"` : undefined;
}

/** cmd.exe parses a command string even when Node uses shell:false, so reject syntax it expands. */
export function createCmdShimLaunch(
	executablePath: string,
	internalArgs: readonly string[],
	comSpec: string,
): ServerLaunch | undefined {
	const quoted = [executablePath, ...internalArgs].map(quoteForCmd);
	if (
		!isSafeCmdSegment(comSpec) ||
		quoted.some((value) => value === undefined)
	) {
		return undefined;
	}
	return {
		command: comSpec,
		args: ["/d", "/s", "/c", `"${quoted.join(" ")}"`],
		shell: false,
		windowsVerbatimArguments: true,
	};
}

export function createServerLaunch(
	executablePath: string,
	internalArgs: readonly string[],
	platform: NodeJS.Platform,
	comSpec = "cmd.exe",
): ServerLaunch | undefined {
	const lowerPath = executablePath.toLowerCase();
	if (lowerPath.endsWith(".ps1")) return undefined;
	if (
		platform === "win32" &&
		(lowerPath.endsWith(".cmd") || lowerPath.endsWith(".bat"))
	) {
		return createCmdShimLaunch(executablePath, internalArgs, comSpec);
	}
	if (
		internalArgs.some(
			(argument) =>
				argument.includes("\0") ||
				argument.includes("\r") ||
				argument.includes("\n"),
		)
	) {
		return undefined;
	}
	return { command: executablePath, args: [...internalArgs], shell: false };
}

export function splitPath(
	pathValue: string,
	platform: NodeJS.Platform,
): string[] {
	return pathValue.split(platform === "win32" ? ";" : ":");
}

export function platformPath(platform: NodeJS.Platform) {
	return platform === "win32" ? win32 : posix;
}

export const HOST_PATH_DELIMITER = delimiter;
