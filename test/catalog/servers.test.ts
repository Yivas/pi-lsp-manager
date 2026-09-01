import { describe, expect, it } from "vitest";
import { DEFAULT_SERVERS } from "../../src/catalog/servers.js";

describe("v1 server catalog", () => {
	it("pins TypeScript compatibility claims and diagnostic timing", () => {
		expect(DEFAULT_SERVERS).toHaveLength(1);
		const server = DEFAULT_SERVERS[0];
		expect(server).toMatchObject({
			id: "typescript",
			admission: "auto-installable",
			command: "typescript-language-server",
			args: ["--stdio"],
			diagnostics: {
				pushGraceMs: 5_000,
				settleMs: 50,
				pullGraceMs: 250,
			},
		});
		expect(server?.compatibility).toHaveLength(3);
		expect(
			server?.compatibility.map((row) => [
				row.platform,
				row.architecture,
				row.runner,
			]),
		).toEqual([
			["win32", "x64", "windows-2022"],
			["darwin", "arm64", "macos-14"],
			["linux", "x64", "ubuntu-24.04"],
		]);
		for (const row of server?.compatibility ?? []) {
			expect(row).toMatchObject({
				nodeVersion: "22.19.0",
				piVersion: "0.84.1",
				serverVersion: "5.3.0",
				languageVersion: "5.9.3",
			});
			expect(row.capabilities).toEqual(
				expect.arrayContaining([
					"diagnostics",
					"definition",
					"references",
					"document-symbols",
					"rename",
					"process-reuse",
					"shutdown",
				]),
			);
		}
	});
});
