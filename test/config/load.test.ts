import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDefaultConfig,
	getConfigPaths,
	loadConfig,
} from "../../src/config/load.js";
import {
	MAX_CONFIG_TEXT_LENGTH,
	MAX_STRING_LENGTH,
	parseConfigText,
} from "../../src/config/schema.js";

const cwd = "/workspace";
const agentDirectory = "/agent";
const projectDirectory = ".pi-test";
const temporaryDirectories: string[] = [];

function configText(value: object): string {
	return JSON.stringify({ version: 1, ...value });
}

function reader(files: Record<string, string>, reads: string[]) {
	return async (path: string): Promise<string | undefined> => {
		reads.push(path);
		return files[path];
	};
}

function load(
	files: Record<string, string>,
	isProjectTrusted = true,
	reads: string[] = [],
) {
	return loadConfig({
		cwd,
		isProjectTrusted,
		agentDirectory,
		projectConfigDirectory: projectDirectory,
		readText: reader(files, reads),
	});
}

async function fixture(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-lsp-manager-config-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("configuration paths", () => {
	it("derives global configuration and managed state from the agent directory", () => {
		expect(getConfigPaths(cwd, agentDirectory, projectDirectory)).toEqual({
			globalConfigPath: join(agentDirectory, "pi-lsp-manager.json"),
			managedStatePath: join(agentDirectory, "lsp-manager"),
			projectConfigPath: join(cwd, projectDirectory, "pi-lsp-manager.json"),
		});
	});
});

describe("strict configuration parsing", () => {
	it.each([
		["global", "corrupt JSON", "{"],
		["global", "unknown root key", configText({ extra: true })],
		["global", "wrong flag type", configText({ autoInstall: "yes" })],
		[
			"global",
			"unknown server key",
			configText({ servers: { typescript: { recipe: "npm" } } }),
		],
		[
			"project",
			"project auto-install elevation",
			configText({ autoInstall: true }),
		],
		["project", "project network elevation", configText({ network: "auto" })],
		[
			"project",
			"project post-edit elevation",
			configText({ postEditDiagnostics: true }),
		],
		[
			"project",
			"project command",
			configText({ servers: { typescript: { command: "bad" } } }),
		],
	] as const)("rejects %s %s as an entire layer", (layer, _name, text) => {
		expect(parseConfigText(text, layer).ok).toBe(false);
	});

	it("accepts documented global network and post-edit controls", () => {
		for (const config of [
			{ network: "auto", postEditDiagnostics: true },
			{ network: "offline", postEditDiagnostics: false },
		]) {
			expect(parseConfigText(configText(config), "global").ok).toBe(true);
		}
	});

	it("accepts only restrictive project flags", () => {
		expect(
			parseConfigText(
				configText({
					network: "offline",
					autoInstall: false,
					postEditDiagnostics: false,
					servers: { typescript: { enabled: false, autoInstall: false } },
				}),
				"project",
			).ok,
		).toBe(true);
	});

	it("bounds configuration text and initialization values before use", () => {
		expect(
			parseConfigText(" ".repeat(MAX_CONFIG_TEXT_LENGTH + 1), "global").ok,
		).toBe(false);
		expect(
			parseConfigText(
				configText({
					servers: {
						typescript: {
							initialization: { value: "x".repeat(MAX_STRING_LENGTH + 1) },
						},
					},
				}),
				"global",
			).ok,
		).toBe(false);
		expect(
			parseConfigText(
				'{"version":1,"servers":{"typescript":{"initialization":{"value":1e400}}}}',
				"global",
			).ok,
		).toBe(false);
	});
});

describe("configuration loading and restrictive merge", () => {
	it("does not open project configuration before checking trust", async () => {
		const reads: string[] = [];
		const paths = getConfigPaths(cwd, agentDirectory, projectDirectory);
		const result = await load(
			{ [paths.projectConfigPath]: configText({ autoInstall: false }) },
			false,
			reads,
		);
		expect(result.projectLayer).toBe("not-read");
		expect(reads).toEqual([paths.globalConfigPath]);
		expect(result.config.autoInstall).toBe(true);
	});

	it("discards invalid layers without changing their lower configuration", async () => {
		const paths = getConfigPaths(cwd, agentDirectory, projectDirectory);
		const result = await load({
			[paths.globalConfigPath]: "not-json",
			[paths.projectConfigPath]: configText({ network: "auto" }),
		});
		expect(result.globalLayer).toBe("invalid");
		expect(result.projectLayer).toBe("invalid");
		expect(result.config).toEqual(createDefaultConfig());
	});

	it("keeps false and offline sticky across valid layers", async () => {
		const paths = getConfigPaths(cwd, agentDirectory, projectDirectory);
		const result = await load({
			[paths.globalConfigPath]: configText({
				network: "offline",
				autoInstall: false,
				postEditDiagnostics: false,
				servers: { typescript: { enabled: false, autoInstall: false } },
			}),
			[paths.projectConfigPath]: configText({
				network: "offline",
				autoInstall: false,
				postEditDiagnostics: false,
				servers: {
					typescript: { enabled: false, autoInstall: false, priority: 90 },
				},
			}),
		});
		expect(result.globalLayer).toBe("valid");
		expect(result.projectLayer).toBe("valid");
		expect(result.config).toMatchObject({
			network: "offline",
			autoInstall: false,
			postEditDiagnostics: false,
			servers: {
				typescript: { enabled: false, autoInstall: false, priority: 90 },
			},
		});
	});

	it("rejects project IDs and priorities that exceed the lower layer", async () => {
		const paths = getConfigPaths(cwd, agentDirectory, projectDirectory);
		for (const projectConfig of [
			{ servers: { typescript: { priority: 101 } } },
			{ servers: { newServer: { enabled: false } } },
		]) {
			const result = await load({
				[paths.projectConfigPath]: configText(projectConfig),
			});
			expect(result.projectLayer).toBe("invalid");
		}
	});

	it("requires complete custom servers and applies global overrides", async () => {
		const paths = getConfigPaths(cwd, agentDirectory, projectDirectory);
		const incomplete = await load({
			[paths.globalConfigPath]: configText({
				servers: { custom: { command: "custom-ls" } },
			}),
		});
		expect(incomplete.globalLayer).toBe("invalid");
		const result = await load({
			[paths.globalConfigPath]: configText({
				servers: {
					typescript: {
						command: "custom-tsls",
						args: ["--stdio", "--trace"],
						extensions: [".custom"],
						roles: ["diagnostics"],
						languageIds: ["custom"],
						env: { MODE: "test" },
						initialization: { enabled: true },
					},
					custom: {
						command: "custom-ls",
						args: ["--stdio"],
						extensions: [".other"],
						roles: ["semantic"],
						languageIds: ["other"],
					},
				},
			}),
		});
		expect(result.globalLayer).toBe("valid");
		expect(result.config.servers.typescript).toMatchObject({
			command: "custom-tsls",
			args: ["--stdio", "--trace"],
			extensions: [".custom"],
			roles: ["diagnostics"],
			languageIds: ["custom"],
			env: { MODE: "test" },
			initialization: { enabled: true },
		});
		expect(result.config.servers.custom).toMatchObject({
			autoInstall: false,
			admission: "detected",
		});
	});

	it("rejects every forbidden project server field", async () => {
		const paths = getConfigPaths(cwd, agentDirectory, projectDirectory);
		for (const [field, value] of Object.entries({
			command: "value",
			args: [],
			env: {},
			extensions: [],
			roles: [],
			languageIds: [],
			recipes: "value",
			initialization: {},
		})) {
			const result = await load({
				[paths.projectConfigPath]: configText({
					servers: { typescript: { [field]: value } },
				}),
			});
			expect(result.projectLayer).toBe("invalid");
		}
	});

	it("rejects symlinked, non-regular, and oversized default config files", async () => {
		const root = await fixture();
		const project = join(root, "project");
		const agent = join(root, "agent");
		await mkdir(join(project, ".pi"), { recursive: true });
		await mkdir(agent, { recursive: true });
		const globalPath = join(agent, "pi-lsp-manager.json");
		const target = join(root, "target.json");
		await writeFile(target, configText({ network: "offline" }));
		await symlink(target, globalPath);
		let result = await loadConfig({
			cwd: project,
			isProjectTrusted: true,
			agentDirectory: agent,
		});
		expect(result.globalLayer).toBe("invalid");
		await rm(globalPath);
		await mkdir(globalPath);
		result = await loadConfig({
			cwd: project,
			isProjectTrusted: true,
			agentDirectory: agent,
		});
		expect(result.globalLayer).toBe("invalid");
		await rm(globalPath, { recursive: true });
		await writeFile(globalPath, " ".repeat(MAX_CONFIG_TEXT_LENGTH + 1));
		result = await loadConfig({
			cwd: project,
			isProjectTrusted: true,
			agentDirectory: agent,
		});
		expect(result.globalLayer).toBe("invalid");
	});
});
