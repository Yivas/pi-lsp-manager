import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import { TrustedOperationService } from "../../src/tools/shared.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

function service(managedStatePath: string): TrustedOperationService {
	return new TrustedOperationService({
		coordinator: () => undefined,
		pool: () => undefined,
		load: async () => ({
			config: createDefaultConfig(),
			paths: {
				globalConfigPath: "global",
				projectConfigPath: "project",
				managedStatePath,
			},
			globalLayer: "absent",
			projectLayer: "absent",
		}),
	});
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		signal: undefined,
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
}

function record(result: string, residual?: string): string {
	return `${JSON.stringify({
		at: "2026-01-01T00:00:00.000Z",
		serverId: "typescript",
		revision: "r",
		phase: result,
		durationMs: 1,
		result,
		...(residual ? { residual } : {}),
	})}\n`;
}

async function auditSnapshot(...records: string[]) {
	const root = await mkdtemp(join(tmpdir(), "pi-lsp-manager-audit-snapshot-"));
	temporaryDirectories.push(root);
	await mkdir(join(root, "audit"), { recursive: true });
	await writeFile(
		join(root, "audit", "install.audit.jsonl"),
		records.join(""),
		"utf8",
	);
	return service(root).auditSnapshot(context(root));
}

describe("audit snapshot residual", () => {
	it("clears the residual of an earlier record when the last record has none", async () => {
		const snapshot = await auditSnapshot(
			record("cancelled", "termination_unconfirmed"),
			record("ready"),
		);
		expect(snapshot).toEqual({ records: 2, lastResult: "ready" });
	});

	it("reports the residual of the last record", async () => {
		const snapshot = await auditSnapshot(
			record("ready"),
			record("failed", "lock_release_failed"),
		);
		expect(snapshot).toEqual({
			records: 2,
			lastResult: "failed",
			lastResidual: "lock_release_failed",
		});
	});

	it("ignores a residual outside the bounded enum", async () => {
		const snapshot = await auditSnapshot(record("ready", "made_up_residual"));
		expect(snapshot).toEqual({ records: 1, lastResult: "ready" });
	});
});
