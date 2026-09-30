import { join, posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { INACTIVE_PYTHON_RECIPES } from "../../src/install/catalog.js";
import {
	buildPythonInstallerEnvironment,
	createPythonPackageManagerLaunch,
} from "../../src/install/adapters/python.js";
import { PROXY_KEYS } from "../../src/install/launch.js";

const recipe = INACTIVE_PYTHON_RECIPES.ty;
const STAGING = String.raw`C:\managed\servers\ty\ty-0.0.84_pip-target_lock-1.partial-n1`;
const POSIX_STAGING =
	"/managed/servers/ty/ty-0.0.84_pip-target_lock-1.partial-n1";
const POSIX_INTERPRETER = "/usr/bin/python3";
const WINDOWS_INTERPRETER = String.raw`C:\Tools\Python312\python.exe`;

describe("controlled pip launch", () => {
	it("builds the environment from scratch and never inherits host Python, pip or Node values", () => {
		const env = buildPythonInstallerEnvironment(
			{
				PATH: "/host/other-project/.venv/bin:/host/bin",
				PYTHONPATH: "/host/poison",
				PYTHONUSERBASE: "/host/user-base",
				PYTHONHOME: "/host/home",
				PIP_INDEX_URL: "https://hostile.invalid/simple",
				PIP_CONFIG_FILE: "/host/pip.ini",
				PIP_TARGET: "/host/target",
				NODE_OPTIONS: "--require hostile",
				NODE_DISABLE_COMPILE_CACHE: "0",
				HOME: "/host/home",
				USERPROFILE: "/host/profile",
				APPDATA: "/host/appdata",
				TEMP: "/host/tmp",
				TMP: "/host/tmp",
				XDG_CONFIG_HOME: "/host/xdg",
				PROGRAMDATA: "/host/programdata",
				ALLUSERSPROFILE: "/host/allusers",
			},
			"linux",
			POSIX_STAGING,
			POSIX_INTERPRETER,
		);
		expect(env.PIP_CONFIG_FILE).toBe("/dev/null");
		expect(env.HOME).toBe(join(POSIX_STAGING, "home"));
		expect(env.USERPROFILE).toBe(join(POSIX_STAGING, "home"));
		expect(env.TEMP).toBe(join(POSIX_STAGING, "tmp"));
		expect(env.TMP).toBe(join(POSIX_STAGING, "tmp"));
		expect(env.APPDATA).toBe(join(POSIX_STAGING, "home", "AppData", "Roaming"));
		expect(env.XDG_CONFIG_HOME).toBe(join(POSIX_STAGING, "home", ".config"));
		expect(env.PROGRAMDATA).toBe(join(POSIX_STAGING, "programdata"));
		expect(env.ALLUSERSPROFILE).toBe(join(POSIX_STAGING, "programdata"));
		expect(env.PATH).toBe(posix.dirname(POSIX_INTERPRETER));
		expect(env.PATH).not.toContain("/host/other-project/.venv");
		for (const key of [
			"PYTHONPATH",
			"PYTHONUSERBASE",
			"PYTHONHOME",
			"PIP_INDEX_URL",
			"PIP_TARGET",
			"NODE_OPTIONS",
			"NODE_DISABLE_COMPILE_CACHE",
		])
			expect(env[key], key).toBeUndefined();
	});

	it("keeps only the system directories and the interpreter directory on Windows", () => {
		const env = buildPythonInstallerEnvironment(
			{
				SystemRoot: String.raw`C:\Windows`,
				ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
				PATH: String.raw`C:\host\other\venv\Scripts;C:\host\bin`,
			},
			"win32",
			STAGING,
			WINDOWS_INTERPRETER,
		);
		expect(env.PIP_CONFIG_FILE).toBe("nul");
		expect(env.SystemRoot).toBe(String.raw`C:\Windows`);
		expect(env.ComSpec).toBe(String.raw`C:\Windows\System32\cmd.exe`);
		expect(env.PATH).toBe(
			[
				win32.join(String.raw`C:\Windows`, "System32"),
				String.raw`C:\Windows`,
				win32.dirname(WINDOWS_INTERPRETER),
			].join(";"),
		);
		expect(env.PATH).not.toContain(String.raw`C:\host`);
	});

	it("forwards exactly the standard proxy keys that the trusted host configuration provides", () => {
		const provided: NodeJS.ProcessEnv = {
			PATH: "/host/bin",
			HTTP_PROXY: "http://proxy.invalid:8080",
			HTTPS_PROXY: "http://proxy.invalid:8443",
			NO_PROXY: "localhost",
			http_proxy: "http://lower.invalid:8080",
			https_proxy: "http://lower.invalid:8443",
			no_proxy: "127.0.0.1",
			PROJECT_PROXY: "http://project.invalid",
		};
		const env = buildPythonInstallerEnvironment(
			provided,
			"linux",
			POSIX_STAGING,
			POSIX_INTERPRETER,
		);
		for (const key of PROXY_KEYS) expect(env[key], key).toBe(provided[key]);
		expect(env.PROJECT_PROXY).toBeUndefined();
		const empty = buildPythonInstallerEnvironment(
			{ PATH: "/host/bin" },
			"linux",
			POSIX_STAGING,
			POSIX_INTERPRETER,
		);
		for (const key of PROXY_KEYS) expect(empty[key], key).toBeUndefined();
	});

	it("runs the pinned interpreter with hashed direct requirements from the staging cwd", () => {
		const launch = createPythonPackageManagerLaunch(
			recipe,
			POSIX_STAGING,
			POSIX_INTERPRETER,
			{ PATH: "/host/other-project/.venv/bin" },
			"linux",
		);
		expect(launch.command).toBe(POSIX_INTERPRETER);
		expect(launch.cwd).toBe(POSIX_STAGING);
		expect(launch.args).toEqual([
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
			POSIX_STAGING,
			"-r",
			join(POSIX_STAGING, "requirements.txt"),
		]);
		expect(launch.env.PIP_CONFIG_FILE).toBe("/dev/null");
		expect(launch.env.PATH).toBe(posix.dirname(POSIX_INTERPRETER));
	});
});
