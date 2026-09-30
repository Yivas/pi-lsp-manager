import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INACTIVE_PYTHON_RECIPES } from "../../src/install/catalog.js";
import {
	buildPythonInstallerEnvironment,
	prepareControlledPythonFiles,
} from "../../src/install/adapters/python.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true, maxRetries: 10 });
	}
});

describe("host pip state stays outside the managed launch", () => {
	it("ignores poisoned user configuration, site hooks and index overrides", async () => {
		const host = await temporaryDirectory("pi-lsp-pip-host-");
		await writeFile(
			join(host, "pip.ini"),
			"[global]\nindex-url = https://poison.invalid/simple\n",
			"utf8",
		);
		await mkdir(join(host, "site-packages"), { recursive: true });
		await writeFile(
			join(host, "site-packages", "sitecustomize.py"),
			"raise SystemExit('poison')\n",
			"utf8",
		);
		await writeFile(
			join(host, "site-packages", "usercustomize.py"),
			"raise SystemExit('poison')\n",
			"utf8",
		);
		const staging = join(host, "staging");
		await mkdir(staging, { recursive: true });

		const env = buildPythonInstallerEnvironment(
			{
				PATH: join(host, ".venv", "bin"),
				HOME: host,
				USERPROFILE: host,
				APPDATA: host,
				XDG_CONFIG_HOME: host,
				PROGRAMDATA: host,
				ALLUSERSPROFILE: host,
				PIP_CONFIG_FILE: join(host, "pip.ini"),
				PIP_INDEX_URL: "https://poison.invalid/simple",
				PYTHONPATH: join(host, "site-packages"),
				PYTHONUSERBASE: host,
			},
			"linux",
			staging,
			"/usr/bin/python3",
		);

		expect(env.PIP_CONFIG_FILE).toBe("/dev/null");
		expect(env.PIP_INDEX_URL).toBeUndefined();
		expect(env.PYTHONPATH).toBeUndefined();
		expect(env.PYTHONUSERBASE).toBeUndefined();
		for (const key of [
			"HOME",
			"USERPROFILE",
			"APPDATA",
			"XDG_CONFIG_HOME",
			"PROGRAMDATA",
			"ALLUSERSPROFILE",
		] as const)
			expect(env[key]?.startsWith(staging), key).toBe(true);
		expect(env.PATH).not.toContain(".venv");

		// The staging tree holds only the controlled requirement the recipe generated plus
		// exactly the directories the environment above declares.
		await prepareControlledPythonFiles(staging, INACTIVE_PYTHON_RECIPES.ty, {
			platform: "linux",
			architecture: "x64",
		});
		expect((await readdir(staging)).sort()).toEqual([
			"home",
			"programdata",
			"requirements.txt",
			"tmp",
		]);
		for (const declared of [
			join(staging, "home"),
			join(staging, "home", "AppData", "Roaming"),
			join(staging, "home", ".config"),
			join(staging, "programdata"),
			join(staging, "tmp"),
		])
			await expect(
				access(declared).then(
					() => true,
					() => false,
				),
				declared,
			).resolves.toBe(true);
	});
});
