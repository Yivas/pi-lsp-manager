import {
	access,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/config/load.js";
import type { AuditRecord } from "../../src/install/audit.js";
import {
	getRecipe,
	getRecipeRevision,
	VUE_RECIPE,
} from "../../src/install/catalog.js";
import {
	InstallCoordinator,
	type InstallPhase,
} from "../../src/install/coordinator.js";
import { NodePackageManager } from "../../src/install/npm.js";
import { evaluateInstallPolicy } from "../../src/install/policy.js";
import { createNodeInstallationVerifier } from "../../src/install/verify.js";

// Real installation gate for the frozen Vue recipe. It injects the decision
// because RECIPES does not expose `vue`: the policy denial asserted below stays
// the real one while staging, lock, npm, verification, rollback, cancellation,
// and the audit trail all run against the production adapters.
//
// CI reuse: `VUE_INSTALL_GATE_ROOT` names the directory the caller owns and
// removes, and `VUE_INSTALL_GATE_OUTPUT` receives the absolute CLI entry of the
// committed installation for the real Vue fixture step.

const runReal = process.env.RUN_REAL_VUE_INSTALL === "1";
const outputFile = process.env.VUE_INSTALL_GATE_OUTPUT;
const callerRoot = process.env.VUE_INSTALL_GATE_ROOT;
// The handoff needs both variables: the caller-owned root it removes and the
// file that receives the committed CLI. With only one of them the gate keeps and
// writes nothing, so no later step can follow a path into a removed install.
const handoff =
	outputFile && callerRoot ? { outputFile, callerRoot } : undefined;

// The rollback and ready cases each pay one real `npm ci` of the pinned closure,
// so the bound must stay well above the product default of two minutes on a slow
// runner. It is injected here only and does not change that default.
const INSTALL_TIMEOUT_MS = 600_000;

const VUE_INSTALL_DECISION = { allowed: true, recipe: VUE_RECIPE } as const;

const ownedRoots: string[] = [];
let retainedRoot: string | undefined;

async function gateRoot(prefix: string): Promise<string> {
	// A caller-provided root is the CI gate directory, so every artifact stays
	// under the exact path that caller removes; otherwise the OS temporary
	// directory is the parent.
	const root = await mkdtemp(join(callerRoot ?? tmpdir(), prefix));
	ownedRoots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of ownedRoots.splice(0)) {
		// A retained root is the committed installation the caller reuses for the
		// real Vue fixture; the caller removes that exact path afterwards.
		if (root === retainedRoot) continue;
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 50,
		});
	}
	retainedRoot = undefined;
});

function coordinator(): InstallCoordinator {
	return new InstallCoordinator({
		packageManager: new NodePackageManager(),
		verifier: createNodeInstallationVerifier(),
		installTimeoutMs: INSTALL_TIMEOUT_MS,
	});
}

function serverRoot(managed: string): string {
	return join(managed, "servers", VUE_RECIPE.serverId);
}

function revisionTarget(managed: string): string {
	return join(serverRoot(managed), VUE_RECIPE.revision);
}

function lockPath(managed: string): string {
	return join(
		managed,
		"locks",
		`${VUE_RECIPE.serverId}-${VUE_RECIPE.revision}.lock`,
	);
}

/** The stable CLI entry the real Vue fixture consumes from this installation. */
function languageServerEntry(managed: string): string {
	return join(
		revisionTarget(managed),
		"node_modules",
		"@vue",
		"language-server",
		"bin",
		"vue-language-server.js",
	);
}

async function auditRecords(managed: string): Promise<AuditRecord[]> {
	const text = await readFile(
		join(managed, "audit", "install.audit.jsonl"),
		"utf8",
	);
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as AuditRecord);
}

describe.runIf(runReal)(
	"Vue installation gate with the real coordinator",
	() => {
		it("keeps the recipe unregistered and the real policy denied", () => {
			expect(getRecipe("vue")).toBeUndefined();
			expect(getRecipeRevision("vue")).toBeUndefined();
			const decision = evaluateInstallPolicy({
				origin: "tool",
				serverId: "vue",
				globalConfig: createDefaultConfig(),
				projectTrusted: true,
				platform: process.platform,
				architecture: process.arch,
			});
			expect(decision).toMatchObject({
				allowed: false,
				reason: "recipe_missing",
			});
		});

		it(
			"cancels a real Vue installation at the installing phase and cleans its state",
			async () => {
				const root = await gateRoot("pi-lsp-vue-real-cancel-");
				const managed = join(root, "managed");
				const controller = new AbortController();
				const phases: InstallPhase[] = [];
				const instance = coordinator();
				try {
					const result = await instance.install({
						decision: VUE_INSTALL_DECISION,
						managedStatePath: managed,
						signal: controller.signal,
						onPhase: (phase) => {
							phases.push(phase);
							// Abort on one of the coordinator's own phases, before the real npm
							// process starts, instead of on a timer or a random moment.
							if (phase === "installing") controller.abort();
						},
					});
					expect(result).toEqual({ status: "failed", reason: "cancelled" });
					expect(phases).toEqual([
						"waiting-lock",
						"verifying",
						"missing",
						"installing",
						"failed",
					]);
					// An aborting join resolves before the coordinator drains its own
					// cleanup, so shut it down and only then read the managed state.
					await instance.shutdown();
					await expect(access(revisionTarget(managed))).rejects.toThrow();
					expect(await readdir(serverRoot(managed))).toEqual([]);
					await expect(access(lockPath(managed))).rejects.toThrow();
					const records = await auditRecords(managed);
					expect(records).toEqual([
						expect.objectContaining({
							serverId: "vue",
							revision: VUE_RECIPE.revision,
							result: "cancelled",
						}),
					]);
					// The real npm tree was confirmed stopped, so nothing was retained.
					expect(records[0]?.residual).toBeUndefined();
				} finally {
					await instance.shutdown();
				}
			},
			INSTALL_TIMEOUT_MS,
		);

		it(
			"rolls back a real Vue install whose pinned version does not verify",
			async () => {
				const root = await gateRoot("pi-lsp-vue-real-rollback-");
				const managed = join(root, "managed");
				// A copy of the frozen recipe that pins a different version, so the real
				// verifier reads the real installation and rejects the version it reports.
				// Only the pin differs; npm, the verifier, and the rollback path are real.
				const mismatched = { ...VUE_RECIPE, expectedVersion: "5.3.0" } as const;
				const instance = coordinator();
				try {
					const result = await instance.install({
						decision: { allowed: true, recipe: mismatched },
						managedStatePath: managed,
					});
					expect(result.status, result.reason).toBe("failed");
					expect(result.reason).toBe("verification_failed");
					await expect(access(revisionTarget(managed))).rejects.toThrow();
					expect(await readdir(serverRoot(managed))).toEqual([]);
					await expect(access(lockPath(managed))).rejects.toThrow();
					expect(await auditRecords(managed)).toEqual([
						expect.objectContaining({
							serverId: "vue",
							revision: VUE_RECIPE.revision,
							result: "failed",
						}),
					]);
				} finally {
					await instance.shutdown();
				}
			},
			INSTALL_TIMEOUT_MS,
		);

		it(
			"installs and verifies the pinned Vue closure and exposes its CLI",
			async () => {
				const root = await gateRoot("pi-lsp-vue-real-ready-");
				const managed = join(root, "managed");
				const instance = coordinator();
				try {
					const result = await instance.install({
						decision: VUE_INSTALL_DECISION,
						managedStatePath: managed,
					});
					expect(result.status, result.reason).toBe("ready");
					expect(result.executable?.version).toBe(VUE_RECIPE.expectedVersion);
					if (!result.executable)
						throw new Error("The verified executable is missing.");
					await expect(access(result.executable.path)).resolves.toBeUndefined();
					const entry = languageServerEntry(managed);
					await expect(access(entry)).resolves.toBeUndefined();
					// The committed installation is self-contained: no staging, no lock.
					expect(await readdir(serverRoot(managed))).toEqual([
						VUE_RECIPE.revision,
					]);
					await expect(access(lockPath(managed))).rejects.toThrow();
					const manifest = JSON.parse(
						await readFile(
							join(revisionTarget(managed), "package.json"),
							"utf8",
						),
					) as { dependencies: Record<string, string> };
					expect(manifest.dependencies).toEqual({
						"@vue/language-server": "3.3.11",
						"@vue/typescript-plugin": "3.3.11",
						typescript: "5.9.3",
						vue: "3.5.43",
					});
					expect(await auditRecords(managed)).toEqual([
						expect.objectContaining({
							serverId: "vue",
							revision: VUE_RECIPE.revision,
							phase: "ready",
							result: "ready",
						}),
					]);
					// The caller-provided path receives the absolute CLI entry only, so a
					// later fixture step can reuse this installation instead of paying a
					// second npm run; no repository path is written. Both variables must be
					// set, so the output file never points at an installation this gate
					// keeps for nobody.
					if (handoff) {
						await writeFile(handoff.outputFile, `${entry}\n`, "utf8");
						retainedRoot = root;
					}
				} finally {
					await instance.shutdown();
				}
			},
			INSTALL_TIMEOUT_MS,
		);
	},
);
