import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	codeActions,
	CodeActionPreviews,
	codeActionsSchema,
} from "../../src/tools/code-actions-preview.js";
import { definition, definitionSchema } from "../../src/tools/definition.js";
import { diagnosticsSchema } from "../../src/tools/diagnostics.js";
import {
	prepareRename,
	prepareRenameSchema,
} from "../../src/tools/prepare-rename.js";
import { references, referencesSchema } from "../../src/tools/references.js";
import { relativeLocation, success } from "../../src/tools/render.js";
import type { TrustedOperationService } from "../../src/tools/shared.js";
import { statusSchema } from "../../src/tools/status.js";
import { symbols, symbolsSchema } from "../../src/tools/symbols.js";

const context = {
	cwd: process.cwd(),
	signal: undefined,
	isProjectTrusted: () => true,
} as unknown as ExtensionContext;

function textOf(result: ReturnType<typeof success>): string {
	const content = result.content[0];
	if (!content || content.type !== "text")
		throw new Error("Expected text output.");
	return content.text;
}

function serviceWithoutCapabilities() {
	const request = vi.fn();
	const operation = {
		target: {
			rootPath: process.cwd(),
			filePath: "src/index.ts",
			relativePath: "src/index.ts",
		},
		server: {} as never,
		runtime: {
			diagnostics: { snapshot: () => 0 },
			session: {
				capabilities: {},
				documents: { get: () => ({ version: 1, text: "const value = 1;" }) },
			},
			connection: { request },
		},
		entry: {} as never,
		uri: "file:///workspace/src/index.ts",
		diagnosticGeneration: 0,
	};
	const service = {
		read: vi.fn(async (_ctx, _path, _role, work) => work(operation)),
	} as unknown as TrustedOperationService;
	return { service, request };
}

describe("tool schemas, capability failures, and shared rendering", () => {
	it("declares every public tool schema as closed", () => {
		for (const schema of [
			diagnosticsSchema,
			definitionSchema,
			referencesSchema,
			symbolsSchema,
			prepareRenameSchema,
			codeActionsSchema,
			statusSchema,
		]) {
			expect(
				(schema as unknown as { additionalProperties?: unknown })
					.additionalProperties,
			).toBe(false);
		}
	});

	it.each([
		[
			"definition",
			(service: TrustedOperationService) =>
				definition(
					service,
					context,
					{ filePath: "x.ts", line: 1, character: 0 },
					undefined,
				),
		],
		[
			"references",
			(service: TrustedOperationService) =>
				references(
					service,
					context,
					{ filePath: "x.ts", line: 1, character: 0 },
					undefined,
				),
		],
		[
			"document symbols",
			(service: TrustedOperationService) =>
				symbols(
					service,
					context,
					{ filePath: "x.ts", scope: "document" },
					undefined,
				),
		],
		[
			"workspace symbols",
			(service: TrustedOperationService) =>
				symbols(
					service,
					context,
					{ filePath: "x.ts", scope: "workspace" },
					undefined,
				),
		],
		[
			"prepare rename",
			(service: TrustedOperationService) =>
				prepareRename(
					service,
					context,
					{ filePath: "x.ts", line: 1, character: 0 },
					undefined,
				),
		],
		[
			"code actions",
			(service: TrustedOperationService) =>
				codeActions(
					service,
					new CodeActionPreviews(),
					context,
					{ filePath: "x.ts" },
					undefined,
				),
		],
	] as const)(
		"returns a stable capability_missing result for %s",
		async (_name, run) => {
			const { service, request } = serviceWithoutCapabilities();
			const result = await run(service);
			expect(result.details?.code).toBe("capability_missing");
			expect(request).not.toHaveBeenCalled();
		},
	);

	it("accepts LocationLink responses and applies a structured definition limit", async () => {
		const rootPath = process.cwd();
		const request = vi.fn().mockResolvedValue({
			ok: true,
			value: [
				{
					targetUri: pathToFileURL(join(rootPath, "src", "z.ts")).href,
					targetRange: {
						start: { line: 4, character: 0 },
						end: { line: 4, character: 1 },
					},
					targetSelectionRange: {
						start: { line: 4, character: 1 },
						end: { line: 4, character: 2 },
					},
				},
				{
					uri: pathToFileURL(join(rootPath, "src", "a.ts")).href,
					range: {
						start: { line: 1, character: 0 },
						end: { line: 1, character: 1 },
					},
				},
			],
		});
		const operation = {
			target: { rootPath, filePath: join(rootPath, "src", "index.ts") },
			server: {} as never,
			runtime: {
				session: {
					capabilities: { definitionProvider: {} },
					documents: { get: () => ({ version: 1, text: "value" }) },
				},
				connection: { request },
			},
			entry: {} as never,
			uri: pathToFileURL(join(rootPath, "src", "index.ts")).href,
			diagnosticGeneration: 0,
		};
		const service = {
			read: vi.fn(async (_ctx, _path, _role, work) => work(operation)),
		} as unknown as TrustedOperationService;
		const result = await definition(
			service,
			context,
			{ filePath: "src/index.ts", line: 1, character: 0, limit: 1 },
			undefined,
		);
		const content = result.content[0];
		if (!content || content.type !== "text") throw new Error("Expected text.");
		expect(JSON.parse(content.text).definitions).toEqual([
			{ path: "src/a.ts", line: 2, character: 0 },
		]);
	});

	it("never renders a different URI authority as a workspace-relative path", () => {
		const root = "file:///workspace/";
		expect(
			relativeLocation("file://remote-host/workspace/src/file.ts", root, {
				line: 0,
				character: 0,
			}),
		).toEqual({ path: "<external>", line: 1, character: 0 });
		expect(
			relativeLocation("https://example.test/workspace/src/file.ts", root, {
				line: 0,
				character: 0,
			}),
		).toEqual({ path: "<external>", line: 1, character: 0 });
	});

	it("sanitizes private absolute paths, preserves relative paths, and truncates as valid JSON", () => {
		const home = process.env.HOME ?? process.env.USERPROFILE;
		const privatePath = home
			? `${home}/secret/file.ts`
			: "C:\\Users\\private\\file.ts";
		const rendered = textOf(
			success({
				path: "src/file.ts",
				[privatePath]: "private key",
				message: `Failure at ${privatePath} and \\\\server\\share\\private.ts`,
				deep: {
					a: { b: { c: { d: { e: { f: { g: { secret: privatePath } } } } } } },
				},
			}),
		);
		expect(rendered).toContain("src/file.ts");
		expect(rendered).toContain("<path>");
		expect(rendered).not.toContain(privatePath);
		expect(rendered).not.toContain("server\\\\share");
		expect(rendered).toContain("<truncated>");

		const truncated = success({ message: "x".repeat(30_000) });
		const truncatedText = textOf(truncated);
		expect(() => JSON.parse(truncatedText)).not.toThrow();
		expect(truncated.details?.truncated).toBe(true);
		expect(truncatedText.length).toBeLessThanOrEqual(12_000);
	});

	it("expires and bounds session-local code action previews", () => {
		let now = 0;
		const previews = new CodeActionPreviews(10, 2, () => now);
		const put = (title: string) =>
			previews.put({
				hash: "hash",
				filePath: "/workspace/file.ts",
				serverId: "server",
				action: { title },
			});
		const expected = {
			hash: "hash",
			filePath: "/workspace/file.ts",
			serverId: "server",
		};
		const first = put("first");
		const second = put("second");
		const third = put("third");
		expect(previews.get(first, expected)).toBeUndefined();
		expect(previews.get(second, expected)).toEqual({ title: "second" });
		expect(
			previews.get(third, { ...expected, filePath: "/other.ts" }),
		).toBeUndefined();
		now = 11;
		expect(previews.get(second, expected)).toBeUndefined();
	});
});
