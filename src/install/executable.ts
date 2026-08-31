import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { posix, win32 } from "node:path";

export interface ExecutableFileSystem {
	lstat(path: string): Promise<{ isFile(): boolean }>;
	access(path: string, mode?: number): Promise<void>;
}

const NODE_FILE_SYSTEM: ExecutableFileSystem = { lstat, access };

function getEnvironment(
	environment: NodeJS.ProcessEnv,
	key: string,
): string | undefined {
	return Object.entries(environment).find(
		([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
	)?.[1];
}

function isPathSeparator(character: string): boolean {
	return character === "/" || character === "\\";
}

function isAbsoluteCommand(
	command: string,
	platform: NodeJS.Platform,
): boolean {
	return platform === "win32"
		? /^[a-z]:[\\/]/i.test(command) || command.startsWith("\\\\")
		: command.startsWith("/");
}

async function isExecutable(
	fileSystem: ExecutableFileSystem,
	path: string,
	platform: NodeJS.Platform,
): Promise<boolean> {
	try {
		const status = await fileSystem.lstat(path);
		if (!status.isFile()) {
			return false;
		}
		if (platform !== "win32") {
			await fileSystem.access(path, constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

function windowsExtensions(environment: NodeJS.ProcessEnv): readonly string[] {
	const raw = getEnvironment(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
	return raw
		.split(";")
		.map((extension) => extension.trim().toLowerCase())
		.filter((extension) => /^\.[a-z0-9]+$/i.test(extension));
}

function commandCandidates(
	command: string,
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): readonly string[] {
	if (platform !== "win32") {
		return [command];
	}
	if (
		windowsExtensions(environment).some((extension) =>
			command.toLowerCase().endsWith(extension),
		)
	) {
		return [command];
	}
	return windowsExtensions(environment).map(
		(extension) => `${command}${extension}`,
	);
}

export async function resolveExecutable(
	command: string,
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
	fileSystem: ExecutableFileSystem = NODE_FILE_SYSTEM,
): Promise<string | undefined> {
	if (
		command.length === 0 ||
		command.includes("\0") ||
		command.includes("\n") ||
		command.includes("\r")
	) {
		return undefined;
	}
	if (
		isAbsoluteCommand(command, platform) ||
		command.split("").some(isPathSeparator)
	) {
		for (const candidate of commandCandidates(command, environment, platform)) {
			if (await isExecutable(fileSystem, candidate, platform)) {
				return candidate;
			}
		}
		return undefined;
	}
	const pathValue = getEnvironment(environment, "PATH") ?? "";
	const pathModule = platform === "win32" ? win32 : posix;
	for (const directory of pathValue.split(platform === "win32" ? ";" : ":")) {
		if (!directory) {
			continue;
		}
		for (const candidate of commandCandidates(command, environment, platform)) {
			const absolutePath = pathModule.join(directory, candidate);
			if (await isExecutable(fileSystem, absolutePath, platform)) {
				return absolutePath;
			}
		}
	}
	return undefined;
}
