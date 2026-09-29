import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import { discoverFiles } from "../../src/resolve/discover.js";
import { diagnostics } from "../../src/tools/diagnostics.js";
import { TrustedOperationService } from "../../src/tools/shared.js";

const managedPaths = {
	globalConfigPath: "global",
	projectConfigPath: "project",
	managedStatePath: "managed",
};

function loadCatalog() {
	return async () => ({
		config: createDefaultConfig(),
		paths: managedPaths,
		globalLayer: "absent" as const,
		projectLayer: "absent" as const,
	});
}

function trusted(cwd: string): ExtensionContext {
	return {
		cwd,
		signal: undefined,
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
}

describe("web route boundaries", () => {
	let directory: string | undefined;

	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it.each([
		["page.html", "vscode-eslint-language-server"],
		["styles.css", "biome"],
	] as const)(
		"does not install or start a missing server for %s",
		async (name, candidateCommand) => {
			directory = await mkdtemp(join(tmpdir(), "pi-lsp-web-read-"));
			await writeFile(join(directory, name), "content\n", "utf8");
			const coordinator = vi.fn();
			const pool = vi.fn();
			const start = vi.fn();
			const resolveCommand = vi.fn(async () => undefined);
			const service = new TrustedOperationService({
				coordinator,
				pool,
				start,
				resolveCommand,
				load: loadCatalog(),
			});

			await expect(
				service.read(
					trusted(directory),
					name,
					"diagnostics",
					async (operation) => operation.server.id,
				),
			).rejects.toMatchObject({ code: "server_unavailable" });

			// The resolver picks this file's diagnostics candidate; the install policy then
			// rejects it with recipe_missing because no internal recipe exists, so the
			// request ends without installation or process start.
			expect(resolveCommand).toHaveBeenCalledTimes(1);
			expect(resolveCommand).toHaveBeenCalledWith(
				candidateCommand,
				process.env,
				process.platform,
			);
			expect(coordinator).not.toHaveBeenCalled();
			expect(pool).not.toHaveBeenCalled();
			expect(start).not.toHaveBeenCalled();
		},
	);

	it("discovers web files and reports the missing route without installing or starting", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-lsp-web-scan-"));
		await writeFile(join(directory, "page.html"), "<main></main>\n", "utf8");
		await writeFile(join(directory, "styles.css"), "a {}\n", "utf8");
		const discovered = await discoverFiles({
			workspacePath: directory,
			paths: ["."],
		});
		expect(discovered.files.map((file) => file.relativePath).sort()).toEqual([
			"page.html",
			"styles.css",
		]);

		const coordinator = vi.fn();
		const pool = vi.fn();
		const start = vi.fn();
		const service = new TrustedOperationService({
			coordinator,
			pool,
			start,
			resolveCommand: async () => undefined,
			load: loadCatalog(),
		});

		const result = await diagnostics(
			service,
			trusted(directory),
			{ paths: ["."] },
			undefined,
		);
		const content = result.content[0];
		if (!content || content.type !== "text") throw new Error("Expected text.");
		const output = JSON.parse(content.text) as {
			filesScanned: number;
			serversUsed: string[];
			failures: { code: string }[];
		};
		expect(output.filesScanned).toBe(2);
		expect(output.serversUsed).toEqual([]);
		expect(output.failures.map((failure) => failure.code)).toEqual([
			"server_unavailable",
			"server_unavailable",
		]);
		expect(coordinator).not.toHaveBeenCalled();
		expect(pool).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
	});

	it("denies an untrusted web read before configuration, install, or start", async () => {
		const load = vi.fn();
		const coordinator = vi.fn();
		const pool = vi.fn();
		const start = vi.fn();
		const resolveCommand = vi.fn(async () => undefined);
		const service = new TrustedOperationService({
			load: load as never,
			coordinator,
			pool,
			start,
			resolveCommand,
		});
		const untrusted = {
			cwd: process.cwd(),
			signal: undefined,
			isProjectTrusted: () => false,
		} as unknown as ExtensionContext;

		await expect(
			service.read(untrusted, "page.html", "diagnostics", async () => "unused"),
		).rejects.toMatchObject({ code: "untrusted_project" });

		expect(load).not.toHaveBeenCalled();
		expect(resolveCommand).not.toHaveBeenCalled();
		expect(coordinator).not.toHaveBeenCalled();
		expect(pool).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
	});
});
