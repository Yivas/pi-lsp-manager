import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAuditRecord } from "../../src/install/audit.js";
import {
	BoundedSanitizedOutput,
	sanitizeText,
} from "../../src/install/sanitize.js";

const temporaryDirectories: string[] = [];
async function temporaryDirectory() {
	const path = await mkdtemp(join(tmpdir(), "pi-lsp-manager-audit-"));
	temporaryDirectories.push(path);
	return path;
}
afterEach(async () => {
	for (const path of temporaryDirectories.splice(0))
		await import("node:fs/promises").then(({ rm }) =>
			rm(path, { recursive: true, force: true }),
		);
});

describe("sanitization", () => {
	it("redacts split credentials, bearer values, JSON secrets, control characters, private paths, and long output", () => {
		const output = new BoundedSanitizedOutput();
		output.append("Authorization: Bea");
		output.append(
			'rer abc.def\n{"token":"secret"}\u001b[31m /home/alice/a C:\\Users\\alice\\x',
		);
		const value = output.value();
		expect(value).not.toContain("abc.def");
		expect(value).not.toContain("secret");
		expect(value).not.toContain("alice");
		expect(value).not.toContain("\u001b");
		expect(sanitizeText("x".repeat(10_000)).length).toBeLessThanOrEqual(4_110);
	});

	it("bounds a megabyte raw chunk and does not leak a long secret split across chunks", () => {
		const output = new BoundedSanitizedOutput();
		output.append(`token=${"x".repeat(1_000_000)}`);
		output.append("\nAuthorization: Bearer split-");
		output.append(`${"s".repeat(700)}\n`);
		const value = output.value();
		expect(value.length).toBeLessThanOrEqual(4_110);
		expect(value).not.toContain("split-");
		expect(value).toContain("[output-truncated]");
	});
});

describe("bounded append-only audit", () => {
	it("serializes concurrent records and keeps each current file bounded", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "install.audit.jsonl");
		const record = (revision: string) => ({
			at: "2026-01-01T00:00:00.000Z",
			serverId: "typescript",
			revision,
			phase: "ready",
			durationMs: 3,
			result: "ready" as const,
		});
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				appendAuditRecord(path, record(`revision-${index}`), 256),
			),
		);
		expect((await stat(path)).size).toBeLessThanOrEqual(256);
		const current = await readFile(path, "utf8");
		expect(current).toContain("typescript");
		for (const line of current.trim().split("\n"))
			expect(JSON.parse(line)).toBeTruthy();
		await appendAuditRecord(path, record("x".repeat(10_000)), 256);
		const bounded = await readFile(path, "utf8");
		expect((await stat(path)).size).toBeLessThanOrEqual(256);
		for (const line of bounded.trim().split("\n"))
			expect(JSON.parse(line)).toBeTruthy();
	});
});
