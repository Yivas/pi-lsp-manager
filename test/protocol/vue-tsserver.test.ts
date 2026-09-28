import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LspConnection } from "../../src/protocol/connection.js";
import {
	mapVueRenameEdits,
	VueTsserverBridge,
} from "../../src/protocol/vue-tsserver.js";
import { NodeLspRuntimeSession } from "../../src/protocol/process.js";
import type { EffectiveServerConfig } from "../../src/contracts.js";

const root = resolve("test/vue-workspace");
const file = resolve(root, "Component.vue");
const outside = resolve(root, "../outside.vue");
const span = { start: { line: 2, offset: 7 }, end: { line: 2, offset: 14 } };

function response(target: string, locs: unknown[] = [span]) {
	return { locs: [{ file: target, locs }] };
}

describe("Vue tsserver startup", () => {
	it("refuses an unverified package before launching any process", async () => {
		let launched = false;
		await expect(
			NodeLspRuntimeSession.start({
				launch: {
					command: process.execPath,
					args: [resolve(root, "missing-vue-cli.js")],
					shell: false,
				},
				rootPath: root,
				server: { id: "vue" } as EffectiveServerConfig,
				spawnProcess: (() => {
					launched = true;
					throw new Error("unexpected process");
				}) as typeof import("node:child_process").spawn,
			}),
		).rejects.toMatchObject({
			name: "VueIntegrationUnavailableError",
			message: "Vue TypeScript integration unavailable.",
		});
		expect(launched).toBe(false);
	});
});

const tsserverFixture = String.raw`
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(logPath, request.command + "\n");
  if (request.command === "definition" && mode === "invalid") {
    process.stdout.write("Content-Length: invalid\r\n\r\n");
    return;
  }
  if (request.command === "definition" && mode === "oversized") {
    process.stdout.write("Content-Length: 4194305\r\n\r\n");
    return;
  }
  if (request.command === "definition" && mode === "longHeader") {
    process.stdout.write("Content-Length: 0\r\nX-Pad: " + "x".repeat(256) + "\r\n\r\n");
    return;
  }
  if (request.command === "definition" && mode === "hugeBuffer") {
    process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 257, 120));
    return;
  }
  if (mode === "silent" || (mode === "silentDefinition" && request.command === "definition")) return;
  const location = {
    file: request.arguments?.file,
    start: { line: 1, offset: request.command === "references" ? 2 : 1 },
    end: { line: 1, offset: request.command === "references" ? 6 : 5 },
  };
  const definition = { ...location, start: { line: 1, offset: 1 }, end: { line: 1, offset: 5 } };
  const body = request.command === "definition" ? [location]
    : request.command === "references" ? { refs: mode === "withDeclaration" ? [definition, location] : [location] }
    : request.command === "syntacticDiagnosticsSync" ? [{
      start: { line: 2, offset: 3 }, end: { line: 2, offset: 7 },
      text: request.arguments?.file + ": broken expression", category: "error", code: 2322,
    }]
    : request.command === "semanticDiagnosticsSync" ? [{
      start: { line: 3, offset: 1 }, end: { line: 3, offset: 4 },
      text: "unused variable", category: "warning", code: 6133,
    }]
    : request.command === "rename" ? {
      info: { canRename: true, triggerSpan: { start: definition.start, end: definition.end } },
      locs: [{ file: request.arguments?.file, locs: [{
        start: definition.start, end: definition.end, prefixText: "$",
      }] }],
    } : null;
  if (request.command === "definition" && mode === "unknown") {
    const unknown = Buffer.from(JSON.stringify({
      type: "response", request_seq: request.seq + 100, success: true, body: [],
    }));
    process.stdout.write("Content-Length: " + unknown.length + "\r\n\r\n");
    process.stdout.write(unknown);
  }
  const message = Buffer.from(JSON.stringify({
    type: "response", request_seq: request.seq,
    success: mode !== "rejected" || request.command !== "definition", body,
  }));
  process.stdout.write("Content-Length: " + message.length + "\r\n\r\n");
  process.stdout.write(message.subarray(0, 5));
  setImmediate(() => process.stdout.write(message.subarray(5)));
});
`;

async function withTsserver(
	mode: string,
	check: (
		bridge: VueTsserverBridge,
		rootPath: string,
		log: string,
		failures: () => number,
	) => Promise<void>,
): Promise<void> {
	const rootPath = await mkdtemp(join(tmpdir(), "pi-vue-bridge-"));
	const script = join(rootPath, "tsserver.cjs");
	const log = join(rootPath, "requests.log");
	await writeFile(
		script,
		`const mode = ${JSON.stringify(mode)};\nconst logPath = ${JSON.stringify(log)};\n${tsserverFixture}`,
	);
	const connection = new LspConnection(new PassThrough(), new PassThrough(), {
		requestTimeoutMs: 1_000,
		cancelDrainMs: 100,
	});
	let failed = 0;
	const bridge = VueTsserverBridge.start(
		{ typescriptServer: script, pluginRoot: rootPath },
		rootPath,
		connection,
		() => {
			failed++;
		},
	);
	try {
		await check(bridge, rootPath, log, () => failed);
	} finally {
		await bridge.stop();
		connection.close();
		await rm(rootPath, { recursive: true, force: true });
	}
}

describe("Vue tsserver protocol", () => {
	it.each(["normal", "unknown"])(
		"serializes requests and ignores unknown response IDs (%s)",
		async (mode) => {
			await withTsserver(mode, async (bridge, rootPath, log, failures) => {
				const component = join(rootPath, "Component.vue");
				const position = { line: 0, character: 0 };
				const [definitions, references] = await Promise.all([
					bridge.definition(component, "<script setup></script>", position),
					bridge.references(
						component,
						"<script setup></script>",
						position,
						true,
					),
				]);
				expect(definitions).toEqual([
					{
						uri: pathToFileURL(component).href,
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 4 },
						},
					},
				]);
				expect(references).toEqual([
					{
						uri: pathToFileURL(component).href,
						range: {
							start: { line: 0, character: 1 },
							end: { line: 0, character: 5 },
						},
					},
				]);
				expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
					"configure",
					"open",
					"definition",
					"references",
				]);
				expect(failures()).toBe(0);
			});
		},
	);

	it("maps diagnostics, rename and source positions from tsserver replies", async () => {
		await withTsserver("normal", async (bridge, rootPath, log, failures) => {
			const component = join(rootPath, "Component.vue");
			expect(
				await bridge.diagnostics(component, "const value = broken"),
			).toEqual([
				{
					range: {
						start: { line: 1, character: 2 },
						end: { line: 1, character: 6 },
					},
					message: `${component}: broken expression`,
					severity: 1,
					code: 2322,
					source: "typescript",
				},
				{
					range: {
						start: { line: 2, character: 0 },
						end: { line: 2, character: 3 },
					},
					message: "unused variable",
					severity: 2,
					code: 6133,
					source: "typescript",
				},
			]);
			expect(
				await bridge.rename(
					component,
					"const value = broken",
					{ line: 1, character: 2 },
					"changed",
				),
			).toEqual({
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 4 },
				},
				edit: {
					changes: {
						[pathToFileURL(component).href]: [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 4 },
								},
								newText: "$changed",
							},
						],
					},
				},
			});
			expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
				"configure",
				"open",
				"syntacticDiagnosticsSync",
				"semanticDiagnosticsSync",
				"rename",
			]);
			expect(failures()).toBe(0);
		});
	}, 15_000);

	it("excludes the declaration from references when requested", async () => {
		await withTsserver(
			"withDeclaration",
			async (bridge, rootPath, log, failures) => {
				const component = join(rootPath, "Component.vue");
				expect(
					await bridge.references(
						component,
						"symbol",
						{ line: 0, character: 0 },
						false,
					),
				).toEqual([
					{
						uri: pathToFileURL(component).href,
						range: {
							start: { line: 0, character: 1 },
							end: { line: 0, character: 5 },
						},
					},
				]);
				expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
					"configure",
					"open",
					"references",
					"definition",
				]);
				expect(failures()).toBe(0);
			},
		);
	}, 15_000);

	it.each(["invalid", "oversized", "longHeader", "hugeBuffer"])(
		"rejects %s response framing and stops the bridge",
		async (mode) => {
			await withTsserver(mode, async (bridge, rootPath, _log, failures) => {
				await expect(
					bridge.definition(join(rootPath, "Component.vue"), "content", {
						line: 0,
						character: 0,
					}),
				).rejects.toThrow("Vue tsserver stopped.");
				expect(failures()).toBe(1);
			});
		},
		15_000,
	);

	it("rejects an unsuccessful semantic response without pretending it is empty", async () => {
		await withTsserver("rejected", async (bridge, rootPath, _log, failures) => {
			await expect(
				bridge.definition(join(rootPath, "Component.vue"), "content", {
					line: 0,
					character: 0,
				}),
			).rejects.toThrow("Vue tsserver semantic request failed.");
			expect(failures()).toBe(0);
		});
	});

	it("rejects a pending request when the bridge closes without reporting a crash", async () => {
		await withTsserver(
			"silentDefinition",
			async (bridge, rootPath, log, failures) => {
				const pending = bridge.definition(
					join(rootPath, "Component.vue"),
					"content",
					{ line: 0, character: 0 },
				);
				await vi.waitFor(
					async () => {
						expect((await readFile(log, "utf8")).trim().split("\n")).toContain(
							"definition",
						);
					},
					{ timeout: 2_000 },
				);
				const rejected = expect(pending).rejects.toThrow(
					"Vue tsserver stopped.",
				);
				await bridge.stop();
				await rejected;
				expect(failures()).toBe(0);
			},
		);
	}, 15_000);

	it("rejects an in-flight request on cancellation and stops the bridge", async () => {
		await withTsserver("silent", async (bridge, rootPath, _log, failures) => {
			const controller = new AbortController();
			const pending = bridge.definition(
				join(rootPath, "Component.vue"),
				"content",
				{ line: 0, character: 0 },
				controller.signal,
			);
			controller.abort();
			await expect(pending).rejects.toThrow("Vue tsserver stopped.");
			expect(failures()).toBe(1);
		});
	});
});

describe("Vue tsserver rename mapping", () => {
	it("maps a bounded rename without returning source lines", () => {
		expect(
			mapVueRenameEdits(
				root,
				file,
				response(file, [{ ...span, prefixText: "$" }]),
				"updated",
			),
		).toEqual({
			changes: {
				[pathToFileURL(file).href]: [
					{
						range: {
							start: { line: 1, character: 6 },
							end: { line: 1, character: 13 },
						},
						newText: "$updated",
					},
				],
			},
		});
	});

	it.each([
		["outside workspace", response(outside), "updated"],
		[
			"secondary file with an unbound snapshot",
			response(resolve(root, "Secondary.ts")),
			"updated",
		],
		["invalid identifier", response(file), "has spaces"],
		[
			"invalid span",
			response(file, [{ ...span, start: { line: 0, offset: 1 } }]),
			"updated",
		],
		[
			"duplicate file",
			{ locs: [response(file).locs[0], response(file).locs[0]] },
			"updated",
		],
		["invalid prefix", response(file, [{ ...span, prefixText: 3 }]), "updated"],
		["missing locations", { locs: [] }, "updated"],
	])("rejects %s", (_label, body, name) => {
		expect(() => mapVueRenameEdits(root, file, body, name)).toThrow();
	});
});
