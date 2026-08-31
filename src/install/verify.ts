import { spawn, type ChildProcess } from "node:child_process";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { InstallRecipe } from "./catalog.js";
import { createServerLaunch } from "./launch.js";

export interface InstalledExecutable {
	path: string;
	version: string;
}

export type InstallationVerifier = (
	installationPath: string,
	recipe: InstallRecipe,
	signal: AbortSignal,
) => Promise<InstalledExecutable | undefined>;

export type SpawnVerifierProcess = typeof spawn;

function isWithin(parent: string, child: string): boolean {
	const pathFromParent = relative(parent, child);
	return (
		pathFromParent === "" ||
		(pathFromParent !== ".." &&
			!pathFromParent.startsWith(`..${sep}`) &&
			!isAbsolute(pathFromParent))
	);
}

function executableName(
	recipe: InstallRecipe,
	platform: NodeJS.Platform,
): string {
	return platform === "win32" ? `${recipe.executable}.cmd` : recipe.executable;
}

async function existingExecutable(
	installationPath: string,
	recipe: InstallRecipe,
	platform: NodeJS.Platform,
): Promise<string | undefined> {
	const candidate = join(
		installationPath,
		"node_modules",
		".bin",
		executableName(recipe, platform),
	);
	try {
		const root = await realpath(installationPath);
		const metadata = await lstat(candidate);
		if (platform === "win32" && !metadata.isFile()) return undefined;
		const target = await realpath(candidate);
		if (!isWithin(root, target)) return undefined;
		const targetMetadata = await stat(target);
		if (!targetMetadata.isFile()) return undefined;
		if (platform !== "win32") await access(target, constants.X_OK);
		return platform === "win32" ? candidate : target;
	} catch {
		return undefined;
	}
}

function verifierEnvironment(
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "SystemRoot", "ComSpec"]) {
		const value = environment[key];
		if (value) result[key] = value;
	}
	if (platform === "win32" && !result.PATH && environment.Path) {
		result.PATH = environment.Path;
	}
	return result;
}

function waitForVersion(
	child: ChildProcess,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		let output = "";
		let settled = false;
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			resolve(value);
		};
		const abort = () => {
			child.kill("SIGKILL");
			finish(undefined);
		};
		const timer = setTimeout(abort, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer | string) => {
			output = `${output}${String(chunk)}`.slice(0, 256);
		});
		child.once("error", () => finish(undefined));
		child.once("close", (code) =>
			finish(code === 0 ? output.trim() : undefined),
		);
		signal.addEventListener("abort", abort, { once: true });
	});
}

/** Verifies an executable under the installation root through the same controlled shim adapter. */
export function createNodeInstallationVerifier(
	platform: NodeJS.Platform = process.platform,
	spawnProcess: SpawnVerifierProcess = spawn,
	timeoutMs = 10_000,
	comSpec = process.env.ComSpec ?? "cmd.exe",
	environment: NodeJS.ProcessEnv = process.env,
): InstallationVerifier {
	return async (installationPath, recipe, signal) => {
		if (signal.aborted) return undefined;
		const path = await existingExecutable(installationPath, recipe, platform);
		if (!path || signal.aborted) return undefined;
		const launch = createServerLaunch(path, ["--version"], platform, comSpec);
		if (!launch) return undefined;
		const child = spawnProcess(launch.command, [...launch.args], {
			cwd: installationPath,
			env: verifierEnvironment(environment, platform),
			shell: false,
			windowsHide: true,
			windowsVerbatimArguments: launch.windowsVerbatimArguments,
		});
		const version = await waitForVersion(child, signal, timeoutMs);
		return version === recipe.expectedVersion ? { path, version } : undefined;
	};
}

export async function verifyInstallation(
	installationPath: string,
	recipe: InstallRecipe,
	signal: AbortSignal,
	verifier: InstallationVerifier,
): Promise<InstalledExecutable | undefined> {
	if (signal.aborted) return undefined;
	const executable = await verifier(installationPath, recipe, signal);
	return executable?.version === recipe.expectedVersion
		? executable
		: undefined;
}
