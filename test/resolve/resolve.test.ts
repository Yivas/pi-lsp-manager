import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import type {
	EffectiveConfig,
	ResolvedFile,
	ServerDefinition,
	ServerSelectionContext,
} from "../../src/contracts.js";
import {
	isCanonicalPathWithinWorkspace,
	resolveFile,
} from "../../src/resolve/file.js";
import { ROOT_MARKERS, resolveRoot } from "../../src/resolve/root.js";
import { selectServers } from "../../src/resolve/server.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-lsp-manager-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function makeFile(
	root: string,
	path: string,
	content = "export const value = 1;\n",
): Promise<string> {
	const target = join(root, path);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, content);
	return target;
}

function definition(
	overrides: Partial<ServerDefinition> = {},
): ServerDefinition {
	return {
		id: "typescript",
		roles: ["diagnostics", "semantic", "mutation"],
		extensions: [".ts"],
		languageIds: ["typescript"],
		command: "typescript-language-server",
		args: ["--stdio"],
		priority: 100,
		autoInstall: true,
		admission: "auto-installable",
		diagnostics: {
			pushGraceMs: 5_000,
			settleMs: 50,
			pullGraceMs: 250,
		},
		compatibility: [],
		manualHelp: "manual",
		...overrides,
	};
}

function selectionContext(
	overrides: Partial<ServerSelectionContext> = {},
): ServerSelectionContext {
	return {
		projectTrusted: true,
		availableServerIds: new Set<string>(),
		...overrides,
	};
}

const selectedFile: ResolvedFile = {
	workspacePath: "/workspace",
	filePath: "/workspace/example.ts",
	relativePath: "example.ts",
	extension: ".ts",
	languageId: "typescript",
};

describe("file resolution", () => {
	it.each([
		[".ts", "typescript"],
		[".tsx", "typescriptreact"],
		[".js", "javascript"],
		[".jsx", "javascriptreact"],
		[".mjs", "javascript"],
		[".cjs", "javascript"],
	] as const)("canonicalizes %s as %s", async (extension, languageId) => {
		const workspace = await fixture();
		const source = await makeFile(
			workspace,
			`src/Example${extension.toUpperCase()}`,
		);
		const result = await resolveFile(workspace, source);
		expect(result).toMatchObject({
			ok: true,
			value: { filePath: source, extension, languageId },
		});
	});

	it("accepts relative, absolute, and single-at paths", async () => {
		const workspace = await fixture();
		const source = await makeFile(workspace, "src/example.ts");
		for (const input of ["src/example.ts", source, "@src/example.ts"]) {
			expect(await resolveFile(workspace, input)).toMatchObject({
				ok: true,
				value: { filePath: source },
			});
		}
	});

	it.each([
		["missing", "missing.ts", "file_not_found"],
		["directory", "directory", "file_not_regular"],
		["parent escape", "../outside.ts", "file_outside_workspace"],
		["unsupported extension", "notes.txt", "unsupported_file"],
	] as const)("rejects %s inputs", async (_name, input, code) => {
		const workspace = await fixture();
		await mkdir(join(workspace, "directory"));
		await makeFile(workspace, "notes.txt");
		expect(await resolveFile(workspace, input)).toEqual({ ok: false, code });
	});

	it("rejects absolute paths and symlinks that escape the canonical workspace", async () => {
		const workspace = await fixture();
		const outside = await fixture();
		const outsideFile = await makeFile(outside, "outside.ts");
		await symlink(outsideFile, join(workspace, "external.ts"));
		expect(await resolveFile(workspace, outsideFile)).toEqual({
			ok: false,
			code: "file_outside_workspace",
		});
		expect(await resolveFile(workspace, "external.ts")).toEqual({
			ok: false,
			code: "file_outside_workspace",
		});
	});

	it("canonicalizes an internal symlink and exposes explicit canonical containment", async () => {
		const workspace = await fixture();
		const source = await makeFile(workspace, "src/source.ts");
		const link = join(workspace, "linked.ts");
		await symlink(source, link);
		expect(await resolveFile(workspace, "linked.ts")).toMatchObject({
			ok: true,
			value: { filePath: source },
		});
		expect(await isCanonicalPathWithinWorkspace(workspace, link)).toBe(true);
		const outside = await fixture();
		const outsideFile = await makeFile(outside, "outside.ts");
		expect(await isCanonicalPathWithinWorkspace(workspace, outsideFile)).toBe(
			false,
		);
	});
});

describe("workspace root resolution", () => {
	it.each(ROOT_MARKERS)("uses %s as a nearest root marker", async (marker) => {
		const workspace = await fixture();
		await makeFile(
			workspace,
			`nested/${marker}`,
			marker === ".git" ? "gitdir: /elsewhere\n" : "{}",
		);
		const source = await makeFile(workspace, "nested/deeper/example.ts");
		const resolved = await resolveFile(workspace, source);
		if (!resolved.ok) {
			throw new Error(
				`Expected a resolved fixture, received ${resolved.code}.`,
			);
		}
		expect((await resolveRoot(resolved.value)).rootPath).toBe(
			join(workspace, "nested"),
		);
	});

	it("recognizes a marker at the workspace root and falls back when absent", async () => {
		const withMarker = await fixture();
		await makeFile(withMarker, "package.json", "{}");
		const marked = await resolveFile(
			withMarker,
			await makeFile(withMarker, "src/example.ts"),
		);
		if (!marked.ok) {
			throw new Error("Expected a marked fixture.");
		}
		expect((await resolveRoot(marked.value)).rootPath).toBe(withMarker);
		const withoutMarker = await fixture();
		const plain = await resolveFile(
			withoutMarker,
			await makeFile(withoutMarker, "src/example.ts"),
		);
		if (!plain.ok) {
			throw new Error("Expected a plain fixture.");
		}
		expect((await resolveRoot(plain.value)).rootPath).toBe(withoutMarker);
	});

	it("does not inspect root markers for a fabricated external file", async () => {
		const workspace = await fixture();
		const outside = await fixture();
		const outsideFile = await makeFile(outside, "outside.ts");
		const result = await resolveRoot({
			workspacePath: workspace,
			filePath: outsideFile,
			relativePath: "../outside.ts",
			extension: ".ts",
			languageId: "typescript",
		});
		expect(result.rootPath).toBe(workspace);
	});
});

describe("server selection", () => {
	it("uses priority then Unicode code-unit order as a deterministic tie breaker", () => {
		const config = createDefaultConfig([
			definition({ id: "éclair", roles: ["semantic"], priority: 10 }),
			definition({ id: "zeta", roles: ["semantic"], priority: 10 }),
		]);
		expect(
			selectServers(config, selectedFile, "semantic", selectionContext())
				.primary?.id,
		).toBe("zeta");
	});

	it("fails closed for untrusted projects", () => {
		const config = createDefaultConfig([definition()]);
		expect(
			selectServers(
				config,
				selectedFile,
				"diagnostics",
				selectionContext({ projectTrusted: false }),
			),
		).toEqual({ auxiliaries: [] });
	});

	it("returns only available diagnostic auxiliaries", () => {
		const config = createDefaultConfig([
			definition({ id: "primary", priority: 100, admission: "candidate" }),
			definition({ id: "available", priority: 50, admission: "tested" }),
			definition({ id: "missing", priority: 40, admission: "tested" }),
		]);
		const selection = selectServers(
			config,
			selectedFile,
			"diagnostics",
			selectionContext({ availableServerIds: new Set(["available"]) }),
		);
		expect(selection.primary?.id).toBe("primary");
		expect(selection.auxiliaries.map((server) => server.id)).toEqual([
			"available",
		]);
	});

	it("requires every gate before returning a missing install candidate", () => {
		const base = createDefaultConfig([definition()]);
		const server = base.servers.typescript;
		if (!server) {
			throw new Error("TypeScript server is required.");
		}
		const cases: Array<[string, EffectiveConfig, ServerSelectionContext]> = [
			["offline", { ...base, network: "offline" }, selectionContext()],
			["global disabled", { ...base, autoInstall: false }, selectionContext()],
			[
				"server disabled",
				{ ...base, servers: { typescript: { ...server, autoInstall: false } } },
				selectionContext(),
			],
			[
				"available",
				base,
				selectionContext({ availableServerIds: new Set(["typescript"]) }),
			],
			[
				"candidate admission",
				{
					...base,
					servers: { typescript: { ...server, admission: "candidate" } },
				},
				selectionContext(),
			],
			[
				"detected admission",
				{
					...base,
					servers: { typescript: { ...server, admission: "detected" } },
				},
				selectionContext(),
			],
			[
				"tested admission",
				{
					...base,
					servers: { typescript: { ...server, admission: "tested" } },
				},
				selectionContext(),
			],
		];
		for (const [_name, config, context] of cases) {
			expect(
				selectServers(config, selectedFile, "diagnostics", context)
					.installCandidate,
			).toBeUndefined();
		}
		expect(
			selectServers(base, selectedFile, "mutation", selectionContext())
				.installCandidate?.id,
		).toBe("typescript");
	});

	it("filters disabled, role, extension, and language mismatches", () => {
		const config = createDefaultConfig([
			definition({ id: "semantic", roles: ["semantic"] }),
			definition({
				id: "jsx",
				extensions: [".jsx"],
				languageIds: ["javascriptreact"],
			}),
			definition({ id: "disabled", autoInstall: false }),
		]);
		const disabled = config.servers.disabled;
		if (!disabled) {
			throw new Error("Disabled server is required.");
		}
		const withDisabled: EffectiveConfig = {
			...config,
			servers: { ...config.servers, disabled: { ...disabled, enabled: false } },
		};
		expect(
			selectServers(withDisabled, selectedFile, "mutation", selectionContext()),
		).toEqual({ auxiliaries: [] });
		expect(
			selectServers(
				withDisabled,
				selectedFile,
				"diagnostics",
				selectionContext(),
			),
		).toEqual({ auxiliaries: [] });
		expect(
			selectServers(
				config,
				{ ...selectedFile, extension: ".jsx", languageId: "typescript" },
				"semantic",
				selectionContext(),
			),
		).toEqual({ auxiliaries: [] });
	});
});
