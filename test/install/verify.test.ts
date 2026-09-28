import { EventEmitter } from "node:events";
import {
	chmod,
	mkdtemp,
	mkdir,
	realpath,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRecipe, VUE_RECIPE } from "../../src/install/catalog.js";
import {
	createNodeInstallationVerifier,
	verifyInstallation,
} from "../../src/install/verify.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-lsp-manager-verify-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(async () => {
	for (const path of temporaryDirectories.splice(0)) {
		await import("node:fs/promises").then(({ rm }) =>
			rm(path, { recursive: true, force: true }),
		);
	}
});

describe("production installation verifier", () => {
	it("follows a Unix bin symlink only when its executable target remains in the installation", async () => {
		const recipe = getRecipe("typescript");
		if (!recipe) throw new Error("TypeScript recipe is required.");
		const root = await temporaryDirectory();
		const bin = join(root, "node_modules", ".bin");
		const target = join(
			root,
			"node_modules",
			"typescript-language-server",
			"lib",
			"cli.mjs",
		);
		await mkdir(bin, { recursive: true });
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, "#!/usr/bin/env node\n", "utf8");
		await chmod(target, 0o700);
		await symlink(target, join(bin, recipe.executable));
		const calls: unknown[][] = [];
		const verifier = createNodeInstallationVerifier(
			"linux",
			((...args: unknown[]) => {
				calls.push(args);
				const child = new EventEmitter() as EventEmitter & {
					stdout: EventEmitter;
					kill(): boolean;
				};
				child.stdout = new EventEmitter();
				child.kill = () => true;
				queueMicrotask(() => {
					child.stdout.emit("data", "5.3.0\n");
					child.emit("close", 0);
				});
				return child;
			}) as never,
			1_000,
			"cmd.exe",
			{ PATH: "/safe/bin", SECRET: "not-inherited" },
		);
		expect(await verifier(root, recipe, new AbortController().signal)).toEqual({
			path: await realpath(target),
			version: "5.3.0",
		});
		expect((calls[0]?.[2] as { cwd: string; env: NodeJS.ProcessEnv }).cwd).toBe(
			root,
		);
		expect(
			(calls[0]?.[2] as { cwd: string; env: NodeJS.ProcessEnv }).env,
		).toEqual({ PATH: "/safe/bin" });
		const outside = await temporaryDirectory();
		const outsideTarget = join(outside, "cli.mjs");
		await writeFile(outsideTarget, "#!/usr/bin/env node\n", "utf8");
		await chmod(outsideTarget, 0o700);
		await import("node:fs/promises").then(({ rm }) =>
			rm(join(bin, recipe.executable)),
		);
		await symlink(outsideTarget, join(bin, recipe.executable));
		expect(
			await verifier(root, recipe, new AbortController().signal),
		).toBeUndefined();
	});

	it("locates the promoted Windows shim, uses the controlled adapter, and accepts only the exact version", async () => {
		const recipe = getRecipe("typescript");
		if (!recipe) throw new Error("TypeScript recipe is required.");
		const root = await temporaryDirectory();
		const bin = join(root, "node_modules", ".bin");
		await mkdir(bin, { recursive: true });
		const executable = join(bin, `${recipe.executable}.cmd`);
		await writeFile(executable, "@echo off\r\n", "utf8");
		const calls: unknown[][] = [];
		const verifier = createNodeInstallationVerifier(
			"win32",
			((...args: unknown[]) => {
				calls.push(args);
				const child = new EventEmitter() as EventEmitter & {
					stdout: EventEmitter;
					kill(): boolean;
				};
				child.stdout = new EventEmitter();
				child.kill = () => true;
				queueMicrotask(() => {
					child.stdout.emit("data", "5.3.0\n");
					child.emit("close", 0);
				});
				return child;
			}) as never,
			1_000,
			"cmd.exe",
		);
		expect(await verifier(root, recipe, new AbortController().signal)).toEqual({
			path: executable,
			version: "5.3.0",
		});
		expect(calls[0]?.[0]).toBe("cmd.exe");
		expect(
			(calls[0]?.[2] as { windowsVerbatimArguments?: boolean })
				.windowsVerbatimArguments,
		).toBe(true);
	});

	it("requires the exact Vue plugin and SDK before executing its shim", async () => {
		const root = await temporaryDirectory();
		const bin = join(root, "node_modules", ".bin");
		await mkdir(bin, { recursive: true });
		await writeFile(join(bin, "vue-language-server.cmd"), "@echo off\r\n");
		let launched = 0;
		const verifier = createNodeInstallationVerifier("win32", (() => {
			launched += 1;
			const child = new EventEmitter() as EventEmitter & {
				stdout: EventEmitter;
				kill(): boolean;
			};
			child.stdout = new EventEmitter();
			child.kill = () => true;
			queueMicrotask(() => {
				child.stdout.emit("data", "3.3.11\n");
				child.emit("close", 0);
			});
			return child;
		}) as never);
		const writeMetadata = async (name: string, version: string) => {
			const path = join(root, "node_modules", name);
			await mkdir(path, { recursive: true });
			await writeFile(join(path, "package.json"), JSON.stringify({ version }));
		};
		await writeMetadata("@vue/language-server", "3.3.11");
		await writeMetadata("typescript", "5.9.3");
		await mkdir(join(root, "node_modules", "typescript", "lib"));
		await writeFile(
			join(root, "node_modules", "typescript", "lib", "tsserver.js"),
			"",
		);
		expect(
			await verifier(root, VUE_RECIPE, new AbortController().signal),
		).toBeUndefined();
		expect(launched).toBe(0);
		await writeMetadata("@vue/typescript-plugin", "2.2.12");
		expect(
			await verifier(root, VUE_RECIPE, new AbortController().signal),
		).toBeUndefined();
		expect(launched).toBe(0);
		await writeMetadata("@vue/typescript-plugin", "3.3.11");
		expect(
			await verifier(root, VUE_RECIPE, new AbortController().signal),
		).toMatchObject({ version: "3.3.11" });
		expect(launched).toBe(1);
	});

	it("rejects a verifier that reports a mismatched version", async () => {
		const recipe = getRecipe("typescript");
		if (!recipe) throw new Error("TypeScript recipe is required.");
		expect(
			await verifyInstallation(
				"/managed",
				recipe,
				new AbortController().signal,
				async () => ({ path: "/managed/bin", version: "0.0.0" }),
			),
		).toBeUndefined();
	});
});
