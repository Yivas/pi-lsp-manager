import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, posix, win32 } from "node:path";
import type { InstallRecipe } from "./catalog.js";

const PROXY_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;
const CONTROLLED_NPMRC = "audit=false\nfund=false\nignore-scripts=true\n";

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
	recipe: InstallRecipe,
	name: string,
	version: string,
): string {
	const escapedName = name.replace("@", "").replaceAll("/", "%2f");
	const filename = `${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
	return `${recipe.registry}/${escapedName}/-/${filename}`;
}

export function createControlledNpmFiles(
	recipe: InstallRecipe,
): ControlledNpmFiles {
	const dependencies = Object.fromEntries(
		recipe.packages.map((pin) => [pin.name, pin.version]),
	);
	const packages: Record<string, unknown> = {
		"": {
			name: `pi-lsp-manager-${recipe.serverId}`,
			version: "0.0.0",
			private: true,
			dependencies,
		},
	};
	for (const pin of recipe.packages) {
		packages[`node_modules/${pin.name}`] = {
			version: pin.version,
			resolved: packageTarballUrl(recipe, pin.name, pin.version),
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
	return {
		packageJson: `${JSON.stringify({
			name: `pi-lsp-manager-${recipe.serverId}`,
			version: "0.0.0",
			private: true,
			dependencies,
		})}\n`,
		packageLock: `${JSON.stringify({
			name: `pi-lsp-manager-${recipe.serverId}`,
			version: "0.0.0",
			lockfileVersion: 3,
			requires: true,
			packages,
		})}\n`,
		userConfig: CONTROLLED_NPMRC,
		globalConfig: CONTROLLED_NPMRC,
	};
}

export function validateControlledNpmFiles(
	recipe: InstallRecipe,
	files: ControlledNpmFiles,
): boolean {
	const expected = createControlledNpmFiles(recipe);
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
	return {
		command: resolvedNpmCommand,
		args: [
			"ci",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--foreground-scripts=false",
			"--registry",
			recipe.registry,
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
