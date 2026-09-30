import { describe, expect, it } from "vitest";
import { createDefaultConfig, loadConfig } from "../../src/config/load.js";

const AGENT = "/agent";
const CWD = "/work/project";

function readText(source: {
	global?: string;
	project?: string;
}): (path: string) => Promise<string | undefined> {
	return async (path) => {
		if (path.includes("agent")) return source.global;
		return source.project;
	};
}

function load(options: {
	global?: string;
	project?: string;
	trusted?: boolean;
}) {
	return loadConfig({
		cwd: CWD,
		isProjectTrusted: options.trusted ?? true,
		agentDirectory: AGENT,
		projectConfigDirectory: ".pi",
		readText: readText(options),
	});
}

function globalConfig(extra: Record<string, unknown>): string {
	return JSON.stringify({ version: 1, ...extra });
}

describe("trusted installer interpreter configuration", () => {
	it("starts unset so no existing venv or launcher is used", () => {
		expect(createDefaultConfig().pythonInterpreter).toBeUndefined();
	});

	it("reads a strict absolute path from the global layer only", async () => {
		const loaded = await load({
			global: globalConfig({ pythonInterpreter: "/usr/bin/python3" }),
		});
		expect(loaded.globalLayer).toBe("valid");
		expect(loaded.config.pythonInterpreter).toBe("/usr/bin/python3");
	});

	it.each([
		["a relative path", "python3"],
		["a parent segment", "/usr/../etc/python3"],
		["shell syntax", "/usr/bin/python&calc"],
		["quotes", '"/usr/bin/python3"'],
		["a NUL byte", "/usr/bin/python3\0"],
		["a number", 7],
	])("rejects %s in the global layer", async (_label, value) => {
		const loaded = await load({
			global: globalConfig({ pythonInterpreter: value }),
		});
		expect(loaded.globalLayer).toBe("invalid");
		expect(loaded.config.pythonInterpreter).toBeUndefined();
	});

	it("treats an empty value as the manual fallback without losing the layer", async () => {
		const loaded = await load({
			global: globalConfig({ pythonInterpreter: "", autoInstall: false }),
		});
		expect(loaded.globalLayer).toBe("valid");
		expect(loaded.config.autoInstall).toBe(false);
		expect(loaded.config.pythonInterpreter).toBeUndefined();
	});

	it("refuses the key from the project layer and keeps the global value", async () => {
		const loaded = await load({
			global: globalConfig({ pythonInterpreter: "/usr/bin/python3" }),
			project: JSON.stringify({
				version: 1,
				pythonInterpreter: "/work/project/.venv/bin/python3",
			}),
		});
		expect(loaded.projectLayer).toBe("invalid");
		expect(loaded.config.pythonInterpreter).toBe("/usr/bin/python3");
	});
});
