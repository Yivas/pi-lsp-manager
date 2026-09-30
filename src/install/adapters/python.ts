import { constants } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	readFile,
	realpath,
	stat,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	posix,
	relative,
	sep,
	win32,
} from "node:path";
import {
	type InstallRecipe,
	type PythonInstallRecipe,
	selectPythonEntry,
} from "../catalog.js";
import { isSafeAbsolutePath } from "../../contracts.js";
import { PROXY_KEYS, type PackageManagerLaunch } from "../launch.js";
import type {
	AdapterPreflight,
	InstallPlatformContext,
	RecipeAdapter,
} from "./types.js";

const INSTALLER_DIRECTORY = "bin";
const REQUIREMENTS_FILE = "requirements.txt";

export interface ControlledPythonFiles {
	requirements: string;
}

function pythonRecipe(recipe: InstallRecipe): PythonInstallRecipe {
	if (recipe.kind !== "python") throw new Error("Python recipe required.");
	return recipe;
}

/** The wheel pip must receive for this host: exactly one line, never the other platforms. */
export function createControlledPythonRequirements(
	recipe: PythonInstallRecipe,
	context: Pick<InstallPlatformContext, "platform" | "architecture">,
): string {
	const entry = selectPythonEntry(
		recipe,
		context.platform,
		context.architecture,
	);
	if (!entry) throw new Error("Python recipe has no wheel for this platform.");
	return `${entry.url}#sha256=${entry.sha256}\n`;
}

export async function prepareControlledPythonFiles(
	stagingPath: string,
	recipe: InstallRecipe,
	context: InstallPlatformContext,
): Promise<ControlledPythonFiles> {
	const files = {
		requirements: createControlledPythonRequirements(
			pythonRecipe(recipe),
			context,
		),
	};
	// Create exactly the directories the installer environment declares, so no declared
	// path is missing when pip resolves user or machine configuration under the staging root.
	const home = join(stagingPath, "home");
	await Promise.all([
		mkdir(home, { recursive: true, mode: 0o700 }),
		mkdir(join(home, "AppData", "Roaming"), { recursive: true, mode: 0o700 }),
		mkdir(join(home, ".config"), { recursive: true, mode: 0o700 }),
		mkdir(join(stagingPath, "tmp"), { recursive: true, mode: 0o700 }),
		mkdir(join(stagingPath, "programdata"), { recursive: true, mode: 0o700 }),
	]);
	await writeFile(join(stagingPath, REQUIREMENTS_FILE), files.requirements, {
		encoding: "utf8",
		mode: 0o600,
	});
	return files;
}

export async function readControlledPythonFiles(
	stagingPath: string,
): Promise<ControlledPythonFiles> {
	return {
		requirements: await readFile(join(stagingPath, REQUIREMENTS_FILE), "utf8"),
	};
}

export function validateControlledPythonFiles(
	recipe: InstallRecipe,
	files: unknown,
	context: InstallPlatformContext,
): boolean {
	const expected = createControlledPythonRequirements(
		pythonRecipe(recipe),
		context,
	);
	return (
		typeof files === "object" &&
		files !== null &&
		(files as ControlledPythonFiles).requirements === expected
	);
}

function findEnvironmentValue(
	environment: NodeJS.ProcessEnv,
	key: string,
): string | undefined {
	return Object.entries(environment).find(
		([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
	)?.[1];
}

/** Only the interpreter directory and the operating-system directories, never the host PATH. */
function pythonInstallerPath(
	platform: NodeJS.Platform,
	systemRoot: string | undefined,
	interpreterPath: string,
): string {
	if (platform === "win32") {
		const directories: string[] = [];
		if (systemRoot) {
			directories.push(win32.join(systemRoot, "System32"), systemRoot);
		}
		directories.push(win32.dirname(interpreterPath));
		return [...new Set(directories)].join(";");
	}
	return posix.dirname(interpreterPath);
}

/**
 * Builds the pip environment from scratch. Nothing from the host is inherited except the
 * operating-system root and the proxy variables of the trusted host configuration, so no
 * `PIP_*`, `PYTHON*` or `NODE_*` value can reach the installer.
 */
export function buildPythonInstallerEnvironment(
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	stagingPath: string,
	interpreterPath: string,
): Readonly<Record<string, string>> {
	const result: Record<string, string> = {};
	const systemRoot = findEnvironmentValue(environment, "SystemRoot");
	const comSpec = findEnvironmentValue(environment, "ComSpec");
	if (systemRoot) result.SystemRoot = systemRoot;
	if (comSpec) result.ComSpec = comSpec;
	result.PATH = pythonInstallerPath(platform, systemRoot, interpreterPath);
	for (const key of PROXY_KEYS) {
		const value = environment[key];
		if (value) result[key] = value;
	}
	const home = join(stagingPath, "home");
	const temp = join(stagingPath, "tmp");
	result.HOME = home;
	result.USERPROFILE = home;
	result.APPDATA = join(home, "AppData", "Roaming");
	result.XDG_CONFIG_HOME = join(home, ".config");
	result.TEMP = temp;
	result.TMP = temp;
	result.PROGRAMDATA = join(stagingPath, "programdata");
	result.ALLUSERSPROFILE = join(stagingPath, "programdata");
	// The real platform devnull makes pip take its early return and skip global, site
	// and user configuration. An empty file or the literal "os.devnull" does not.
	result.PIP_CONFIG_FILE = platform === "win32" ? "nul" : "/dev/null";
	return result;
}

export function createPythonPackageManagerLaunch(
	recipe: InstallRecipe,
	stagingPath: string,
	interpreterPath: string,
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): PackageManagerLaunch {
	void pythonRecipe(recipe);
	return {
		command: interpreterPath,
		args: [
			"-I",
			"-m",
			"pip",
			"install",
			"--require-hashes",
			"--no-deps",
			"--only-binary=:all:",
			"--no-input",
			"--no-cache-dir",
			"--disable-pip-version-check",
			"--target",
			stagingPath,
			"-r",
			join(stagingPath, REQUIREMENTS_FILE),
		],
		cwd: stagingPath,
		env: buildPythonInstallerEnvironment(
			environment,
			platform,
			stagingPath,
			interpreterPath,
		),
		platform,
	};
}

export type PythonInterpreterResolution =
	| { ok: true; path: string }
	| { ok: false; reason: "missing" | "unsafe" };

export interface PythonInterpreterFileSystem {
	realpath(path: string): Promise<string>;
	lstat(path: string): Promise<{ isFile(): boolean }>;
	stat(path: string): Promise<{ isFile(): boolean }>;
	/** Checks an access mode such as `X_OK`; the trust layer never runs this on Windows. */
	access(path: string, mode: number): Promise<void>;
}

const PYTHON_INTERPRETER_FILE_SYSTEM: PythonInterpreterFileSystem = {
	realpath,
	lstat,
	stat,
	access,
};

export interface TrustedPythonInterpreterOptions {
	/** The project directory whose contents can never supply the installer interpreter. */
	workspacePath: string;
	/** The process working directory, rejected for the same reason. */
	cwd?: string;
	platform: NodeJS.Platform;
	fileSystem?: PythonInterpreterFileSystem;
}

function inside(parent: string, child: string): boolean {
	const pathFromParent = relative(parent, child);
	return (
		pathFromParent === "" ||
		(pathFromParent !== ".." &&
			!pathFromParent.startsWith(`..${sep}`) &&
			!isAbsolute(pathFromParent))
	);
}

/**
 * A virtual environment keeps `pyvenv.cfg` at its root, one directory above the `bin` or
 * `Scripts` folder that holds the interpreter. Only those two candidates are probed: an
 * unrelated `pyvenv.cfg` far above a global interpreter must not disqualify it, and
 * walking to the filesystem root would both do that and read outside the trusted layout.
 */
const VIRTUAL_ENVIRONMENT_MARKER_DEPTH = 2;

async function hasVirtualEnvironmentMarker(
	directory: string,
	fileSystem: PythonInterpreterFileSystem,
): Promise<boolean> {
	let current = directory;
	for (let depth = 0; depth < VIRTUAL_ENVIRONMENT_MARKER_DEPTH; depth += 1) {
		try {
			await fileSystem.lstat(join(current, "pyvenv.cfg"));
			return true;
		} catch {
			// Only `pyvenv.cfg` at the interpreter directory or its parent marks the root.
		}
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
	return false;
}

/**
 * Establishes trust on the configured interpreter before any managed state or process
 * exists. `realpath` resolves a legitimate system symlink such as `/usr/bin/python3`,
 * while a project virtual environment, the workspace, the working directory and the
 * `py` launcher are refused.
 */
export async function resolveTrustedPythonInterpreter(
	configured: string | undefined,
	options: TrustedPythonInterpreterOptions,
): Promise<PythonInterpreterResolution> {
	const fileSystem = options.fileSystem ?? PYTHON_INTERPRETER_FILE_SYSTEM;
	if (!configured || configured.trim().length === 0)
		return { ok: false, reason: "missing" };
	if (!isSafeAbsolutePath(configured)) return { ok: false, reason: "unsafe" };
	const name = basename(configured).toLowerCase();
	if (name === "py" || name === "py.exe")
		return { ok: false, reason: "unsafe" };
	if (/\.(cmd|bat|ps1)$/i.test(name)) return { ok: false, reason: "unsafe" };
	let resolved: string;
	try {
		resolved = await fileSystem.realpath(configured);
	} catch {
		return { ok: false, reason: "unsafe" };
	}
	const forbiddenRoots: string[] = [];
	for (const root of [options.workspacePath, options.cwd]) {
		if (!root) continue;
		try {
			forbiddenRoots.push(await fileSystem.realpath(root));
		} catch {
			forbiddenRoots.push(root);
		}
	}
	if (forbiddenRoots.some((root) => inside(root, resolved)))
		return { ok: false, reason: "unsafe" };
	if (await hasVirtualEnvironmentMarker(dirname(resolved), fileSystem))
		return { ok: false, reason: "unsafe" };
	try {
		if (!(await fileSystem.stat(resolved)).isFile())
			return { ok: false, reason: "unsafe" };
		// POSIX needs the execute bit; Windows has no equivalent and must not look it up.
		if (options.platform !== "win32")
			await fileSystem.access(resolved, constants.X_OK);
	} catch {
		return { ok: false, reason: "unsafe" };
	}
	return { ok: true, path: resolved };
}

/** The verified executable lives under `<installation>/bin`, never under `node_modules/.bin`. */
export function pythonExecutablePath(
	installationPath: string,
	executable: string,
	platform: NodeJS.Platform,
): string {
	return join(
		installationPath,
		INSTALLER_DIRECTORY,
		platform === "win32" ? `${executable}.exe` : executable,
	);
}

export const pythonAdapter: RecipeAdapter = {
	preflight: (recipe, context): AdapterPreflight => {
		const python = pythonRecipe(recipe);
		if (!selectPythonEntry(python, context.platform, context.architecture))
			return { ok: false, reason: "unsupported_platform" };
		if (
			!context.pythonInterpreter ||
			!isSafeAbsolutePath(context.pythonInterpreter)
		)
			return { ok: false, reason: "package_manager_missing" };
		return { ok: true };
	},
	prepareStaging: (stagingPath, recipe, context) =>
		prepareControlledPythonFiles(stagingPath, recipe, context),
	readStaging: (stagingPath) => readControlledPythonFiles(stagingPath),
	validate: (recipe, files, context) =>
		validateControlledPythonFiles(recipe, files, context),
	resolveManager: async ({ recipe, context }) => {
		pythonRecipe(recipe);
		const configured = context.pythonInterpreter;
		return configured && isSafeAbsolutePath(configured)
			? configured
			: undefined;
	},
	createLaunch: (recipe, stagingPath, managerPath, environment, platform) =>
		createPythonPackageManagerLaunch(
			recipe,
			stagingPath,
			managerPath,
			environment,
			platform,
		),
};
