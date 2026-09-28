import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { mapVueRenameEdits } from "../../src/protocol/vue-tsserver.js";
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
