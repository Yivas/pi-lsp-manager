import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEV_AUDIT_EXCEPTION,
	evaluateAuditOutput,
	evaluateAuditReport,
	formatVerdict,
	readEvidence,
	runLockAuditCheck,
} from "../../scripts/check-lock-audit.mjs";

interface ViaEntry {
	source: number;
	name: string;
	dependency: string;
	title: string;
	url: string;
	severity: string;
	[key: string]: unknown;
}

interface Vulnerability {
	name: string;
	severity: string;
	isDirect: boolean;
	via: Array<ViaEntry | string>;
	effects: string[];
	range: string;
	nodes: string[];
	[key: string]: unknown;
}

interface ReportFixture {
	auditReportVersion: number;
	vulnerabilities: Record<string, Vulnerability>;
	metadata: {
		vulnerabilities: Record<string, number>;
		dependencies: Record<string, number>;
	};
}

const PIN = DEV_AUDIT_EXCEPTION;

function advisoryEntry(id: string, severity: string, source: number): ViaEntry {
	return {
		source,
		name: "brace-expansion",
		dependency: "brace-expansion",
		title: `advisory ${id}`,
		url: `https://github.com/advisories/${id}`,
		severity,
		cwe: ["CWE-400"],
		cvss: {
			score: 7.5,
			vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
		},
		range: ">=4.0.0 <5.0.12",
	};
}

function knownReport(): ReportFixture {
	return {
		auditReportVersion: 2,
		vulnerabilities: {
			"brace-expansion": {
				name: "brace-expansion",
				severity: "high",
				isDirect: false,
				via: PIN.advisories.map((advisory, index) =>
					advisoryEntry(advisory.id, advisory.severity, 1240100 + index),
				),
				effects: [],
				range: "4.0.0 - 5.0.11",
				nodes: [PIN.nodePath],
				fixAvailable: true,
			},
		},
		metadata: {
			vulnerabilities: {
				info: 0,
				low: 0,
				moderate: 0,
				high: 1,
				critical: 0,
				total: 1,
			},
			dependencies: {
				prod: 2,
				dev: 402,
				optional: 61,
				peer: 2,
				peerOptional: 0,
				total: 403,
			},
		},
	};
}

function cleanReport(): ReportFixture {
	const report = knownReport();
	report.vulnerabilities = {};
	report.metadata.vulnerabilities = {
		info: 0,
		low: 0,
		moderate: 0,
		high: 0,
		critical: 0,
		total: 0,
	};
	return report;
}

interface EvidenceFixture {
	errors: string[];
	lockBrace: {
		version: string | null;
		dev: boolean;
		resolved: string | null;
		integrity: string | null;
	} | null;
	lockParent: {
		version: string | null;
		dev: boolean;
		resolved: string | null;
		integrity: string | null;
	} | null;
	installedBraceVersion: string | null;
	installedParentVersion: string | null;
	shrinkwrapPresent: boolean;
	shrinkwrapBraceVersion: string | null;
	hiddenLockBrace: {
		version: string | null;
		dev: boolean;
		resolved: string | null;
		integrity: string | null;
	} | null;
}

function knownEvidence(): EvidenceFixture {
	return {
		errors: [],
		lockBrace: {
			version: PIN.installedVersion,
			dev: true,
			resolved: PIN.lockResolved,
			integrity: PIN.lockIntegrity,
		},
		lockParent: {
			version: PIN.parentVersion,
			dev: true,
			resolved: null,
			integrity: null,
		},
		installedBraceVersion: PIN.installedVersion,
		installedParentVersion: PIN.parentVersion,
		shrinkwrapPresent: true,
		shrinkwrapBraceVersion: PIN.installedVersion,
		hiddenLockBrace: {
			version: PIN.installedVersion,
			dev: true,
			resolved: null,
			integrity: null,
		},
	};
}

function requireEntry<T>(value: T | null): T {
	if (value === null) throw new Error("fixture has no entry");
	return value;
}

function patchedEvidence(): EvidenceFixture {
	const evidence = knownEvidence();
	evidence.lockBrace = requireEntry(evidence.lockBrace);
	evidence.lockBrace.version = "5.0.12";
	evidence.installedBraceVersion = "5.0.12";
	evidence.shrinkwrapBraceVersion = "5.0.12";
	return evidence;
}

function removedEvidence(): EvidenceFixture {
	const evidence = knownEvidence();
	evidence.lockBrace = null;
	evidence.installedBraceVersion = null;
	evidence.shrinkwrapBraceVersion = null;
	return evidence;
}

function firstVulnerability(report: ReportFixture): Vulnerability {
	const entry = Object.values(report.vulnerabilities)[0];
	if (!entry) throw new Error("fixture has no vulnerability");
	return entry;
}

describe("lock audit gate", () => {
	it("keeps the exception bound to the exact nested node and known advisories", () => {
		expect(PIN.nodePath).toBe(
			"node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
		);
		expect(PIN.parentNodePath).toBe(
			"node_modules/@earendil-works/pi-coding-agent",
		);
		expect(PIN.installedVersion).toBe("5.0.9");
		expect(PIN.parentVersion).toBe("0.87.1");
		expect(PIN.advisories.map((advisory) => advisory.id)).toEqual([
			"GHSA-q2hr-2g5m-vwhr",
			"GHSA-qhr7-859c-m2p7",
			"GHSA-6j4f-fj2g-mc7p",
		]);
	});

	it("accepts exactly the pinned development-only exception", () => {
		const verdict = evaluateAuditReport(knownReport(), knownEvidence());
		expect(verdict.status).toBe("accepted");
		expect(verdict.code).toBe("ok_known_dev_exception");
		expect(verdict.pin).toEqual({
			version: "5.0.9",
			parent: "0.87.1",
			nodePath: PIN.nodePath,
		});
	});

	it("rejects a clean report while the pinned vulnerable version is still installed", () => {
		const verdict = evaluateAuditReport(cleanReport(), knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_inconsistent");
	});

	it("accepts a clean report once the pinned node is patched", () => {
		const verdict = evaluateAuditReport(cleanReport(), patchedEvidence());
		expect(verdict.status).toBe("clean");
		expect(verdict.code).toBe("ok_no_findings");
	});

	it("accepts a clean report once the pinned node is gone", () => {
		const verdict = evaluateAuditReport(cleanReport(), removedEvidence());
		expect(verdict.status).toBe("clean");
		expect(verdict.code).toBe("ok_no_findings");
	});

	it("reports the stale exception only for a genuinely clean tree", () => {
		const text = formatVerdict(
			evaluateAuditReport(cleanReport(), patchedEvidence()),
		).join("\n");
		expect(text).toContain("no vulnerable packages found");
		expect(text).toContain("no longer needed");
	});

	it("rejects output that is not JSON", () => {
		const verdict = evaluateAuditOutput("npm ERR! network", knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_unparseable");
	});

	it("rejects a valid JSON audit error envelope", () => {
		const verdict = evaluateAuditOutput(
			JSON.stringify({ error: { code: "ENETUNREACH" } }),
			knownEvidence(),
		);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_error");
	});

	it("rejects a non-object audit report", () => {
		const verdict = evaluateAuditOutput("[]", knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_schema");
	});

	it("rejects a report with a wrong audit schema version", () => {
		const report = knownReport();
		(report as { auditReportVersion: number }).auditReportVersion = 1;
		const verdict = evaluateAuditReport(report, knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_schema");
	});

	it("rejects inconsistent metadata counts", () => {
		const report = knownReport();
		report.metadata.vulnerabilities.total = 5;
		const verdict = evaluateAuditReport(report, knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_inconsistent");
	});

	it("rejects an unknown advisory added to the finding", () => {
		const report = knownReport();
		firstVulnerability(report).via.push(
			advisoryEntry("GHSA-0000-0000-0000", "high", 1240199),
		);
		const verdict = evaluateAuditReport(report, knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_unexpected_finding");
	});

	it("rejects a reduced advisory set", () => {
		const report = knownReport();
		firstVulnerability(report).via.pop();
		const verdict = evaluateAuditReport(report, knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_unexpected_finding");
	});

	it("rejects a changed advisory severity", () => {
		const report = knownReport();
		const via = firstVulnerability(report).via;
		const entry = via[0];
		if (typeof entry !== "object")
			throw new Error("fixture should hold objects");
		entry.severity = "critical";
		const verdict = evaluateAuditReport(report, knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_unexpected_finding");
	});

	it("rejects a title-only match that points at a different advisory", () => {
		const report = knownReport();
		const via = firstVulnerability(report).via;
		const entry = via[0];
		if (typeof entry !== "object")
			throw new Error("fixture should hold objects");
		entry.url = "https://github.com/advisories/GHSA-aaaa-bbbb-cccc";
		const verdict = evaluateAuditReport(report, knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_unexpected_finding");
	});

	it("rejects an advisory entry that names another package", () => {
		const report = knownReport();
		const via = firstVulnerability(report).via;
		const entry = via[0];
		if (typeof entry !== "object")
			throw new Error("fixture should hold objects");
		entry.name = "minimatch";
		const verdict = evaluateAuditReport(report, knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_unexpected_finding");
	});

	it("rejects a production finding for another package", () => {
		const report = knownReport();
		report.vulnerabilities = {
			minimatch: {
				name: "minimatch",
				severity: "high",
				isDirect: false,
				via: [advisoryEntry("GHSA-q2hr-2g5m-vwhr", "moderate", 1)],
				effects: [],
				range: "4.0.0 - 5.0.11",
				nodes: ["node_modules/minimatch"],
			},
		};
		const verdict = evaluateAuditReport(report, knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_unexpected_finding");
	});

	it("rejects the same package at a different node path", () => {
		const report = knownReport();
		firstVulnerability(report).nodes = ["node_modules/brace-expansion"];
		const verdict = evaluateAuditReport(report, knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_unexpected_finding");
	});

	it("rejects a transitive string reference instead of a resolved advisory", () => {
		const report = knownReport();
		firstVulnerability(report).via = ["minimatch"];
		const verdict = evaluateAuditReport(report, knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_unexpected_finding");
	});

	it("rejects a finding that affects other packages", () => {
		const report = knownReport();
		firstVulnerability(report).effects = ["minimatch"];
		const verdict = evaluateAuditReport(report, knownEvidence());
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_unexpected_finding");
	});

	it("rejects a wrong parent version in the lock", () => {
		const evidence = knownEvidence();
		evidence.lockParent = requireEntry(evidence.lockParent);
		evidence.lockParent.version = "0.99.1";
		const verdict = evaluateAuditReport(knownReport(), evidence);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_dev_evidence_mismatch");
	});

	it("rejects a lock version change", () => {
		const evidence = knownEvidence();
		evidence.lockBrace = requireEntry(evidence.lockBrace);
		evidence.lockBrace.version = "5.0.12";
		const verdict = evaluateAuditReport(knownReport(), evidence);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_version_changed");
	});

	it("rejects a production exposure in the lock", () => {
		const evidence = knownEvidence();
		evidence.lockBrace = requireEntry(evidence.lockBrace);
		evidence.lockBrace.dev = false;
		const verdict = evaluateAuditReport(knownReport(), evidence);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_dev_evidence_mismatch");
	});

	it("rejects an installed version change", () => {
		const evidence = knownEvidence();
		evidence.installedBraceVersion = "5.0.12";
		const verdict = evaluateAuditReport(knownReport(), evidence);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_version_changed");
	});

	it("rejects a changed upstream shrinkwrap pin", () => {
		const evidence = knownEvidence();
		evidence.shrinkwrapBraceVersion = "5.0.12";
		const verdict = evaluateAuditReport(knownReport(), evidence);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_shrinkwrap_mismatch");
	});

	it("rejects unreadable lock evidence", () => {
		const evidence = knownEvidence();
		evidence.errors = ["package-lock.json is not valid JSON"];
		const verdict = evaluateAuditReport(knownReport(), evidence);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_evidence_unreadable");
	});

	it("prints the real pin and known advisories without a false clean claim", () => {
		const accepted = evaluateAuditReport(knownReport(), knownEvidence());
		const text = formatVerdict(accepted).join("\n");
		expect(text).toContain("brace-expansion@5.0.9");
		expect(text).toContain("GHSA-q2hr-2g5m-vwhr");
		expect(text).toContain("GHSA-qhr7-859c-m2p7");
		expect(text).toContain("GHSA-6j4f-fj2g-mc7p");
		expect(text).toContain("issues/5653");
		expect(text).not.toContain("0 vulnerabilities");
	});

	it("reads the installed tree evidence without errors", () => {
		const evidence = readEvidence(process.cwd());
		expect(evidence.errors).toEqual([]);
		expect(evidence.lockBrace?.version).toBe(PIN.installedVersion);
		expect(evidence.lockBrace?.dev).toBe(true);
		expect(evidence.lockParent?.version).toBe(PIN.parentVersion);
		expect(evidence.installedBraceVersion).toBe(PIN.installedVersion);
		expect(evidence.shrinkwrapBraceVersion).toBe(PIN.installedVersion);
	});

	describe.runIf(process.env.RUN_LOCK_AUDIT === "1")(
		"live audit against the installed tree",
		() => {
			it("accepts only the documented development-only exception", () => {
				const verdict = runLockAuditCheck(process.cwd());
				expect(verdict.status).toBe("accepted");
				expect(verdict.code).toBe("ok_known_dev_exception");
			});

			const hideDevEnvironments: Array<[string, NodeJS.ProcessEnv]> = [
				["npm_config_omit=dev", { npm_config_omit: "dev" }],
				["NODE_ENV=production", { NODE_ENV: "production" }],
				["npm_config_production=true", { npm_config_production: "true" }],
			];
			const script = join(process.cwd(), "scripts", "check-lock-audit.mjs");
			for (const [label, env] of hideDevEnvironments)
				it(`still accepts the pinned exception under ${label}`, () => {
					const result = spawnSync(process.execPath, [script], {
						cwd: process.cwd(),
						encoding: "utf8",
						env: { ...process.env, ...env },
					});
					expect(result.status).toBe(0);
					expect(result.stdout).toContain(
						"accepted the documented development-only exception",
					);
					expect(result.stdout).not.toContain("no vulnerable packages found");
				});
		},
	);
});
