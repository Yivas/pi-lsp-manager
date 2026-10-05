import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	evaluateAuditOutput,
	evaluateAuditReport,
	formatVerdict,
	runLockAuditCheck,
} from "../../scripts/check-lock-audit.mjs";

interface Vulnerability {
	name: string;
	severity: string;
}

interface ReportFixture {
	auditReportVersion: number;
	vulnerabilities: Record<string, Vulnerability>;
	metadata: {
		vulnerabilities: Record<string, number>;
		dependencies: Record<string, number>;
	};
}

function reportWith(
	vulnerabilities: Record<string, Vulnerability> = {},
): ReportFixture {
	const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
	for (const finding of Object.values(vulnerabilities)) {
		if (finding.severity in counts)
			counts[finding.severity as keyof typeof counts] += 1;
	}
	return {
		auditReportVersion: 2,
		vulnerabilities,
		metadata: {
			vulnerabilities: {
				...counts,
				total: Object.keys(vulnerabilities).length,
			},
			dependencies: { prod: 2, dev: 402, total: 404 },
		},
	};
}

function finding(name = "brace-expansion", severity = "high"): Vulnerability {
	return { name, severity };
}

describe("lock audit gate", () => {
	it("accepts a valid report with no findings", () => {
		const verdict = evaluateAuditReport(reportWith());
		expect(verdict).toEqual({
			status: "clean",
			code: "ok_no_findings",
			reasons: [],
		});
	});

	it("rejects every vulnerability, including a development-only finding", () => {
		const verdict = evaluateAuditReport(
			reportWith({ "brace-expansion": finding() }),
		);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_findings");
		expect(verdict.reasons[0]).toContain("brace-expansion (high)");
	});

	it("rejects multiple findings and identifies each package", () => {
		const verdict = evaluateAuditReport(
			reportWith({
				"brace-expansion": finding(),
				minimatch: finding("minimatch", "moderate"),
			}),
		);
		expect(verdict.status).toBe("rejected");
		expect(verdict.reasons[0]).toContain("brace-expansion (high)");
		expect(verdict.reasons[0]).toContain("minimatch (moderate)");
	});

	it("rejects an audit metadata count that contradicts its findings", () => {
		const report = reportWith({ "brace-expansion": finding() });
		report.metadata.vulnerabilities.total = 0;
		const verdict = evaluateAuditReport(report);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_inconsistent");
	});

	it("rejects an unknown finding severity", () => {
		const report = reportWith({
			"brace-expansion": finding("brace-expansion", "urgent"),
		});
		const verdict = evaluateAuditReport(report);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_inconsistent");
	});

	it("rejects a report with an unsupported schema version", () => {
		const report = reportWith();
		report.auditReportVersion = 1;
		const verdict = evaluateAuditReport(report);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_schema");
	});

	it("rejects reports with malformed metadata", () => {
		const report = reportWith();
		delete (report.metadata as { dependencies?: unknown }).dependencies;
		const verdict = evaluateAuditReport(report);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_schema");
	});

	it("rejects output that is not JSON", () => {
		const verdict = evaluateAuditOutput("npm ERR! network");
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_unparseable");
	});

	it("rejects a valid JSON audit error envelope", () => {
		const verdict = evaluateAuditOutput(
			JSON.stringify({ error: { code: "ENETUNREACH" } }),
		);
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_error");
	});

	it("rejects non-object JSON output", () => {
		const verdict = evaluateAuditOutput("[]");
		expect(verdict.status).toBe("rejected");
		expect(verdict.code).toBe("reject_audit_schema");
	});

	it("reports a clean result without exception language", () => {
		const text = formatVerdict(evaluateAuditReport(reportWith())).join("\n");
		expect(text).toBe("lock-audit: no vulnerable packages found");
		expect(text).not.toContain("exception");
	});

	describe.runIf(process.env.RUN_LOCK_AUDIT === "1")(
		"live audit against the installed tree",
		() => {
			it("passes only a clean complete dependency-tree audit", () => {
				const verdict = runLockAuditCheck(process.cwd());
				expect(verdict.status).toBe("clean");
				expect(verdict.code).toBe("ok_no_findings");
			});

			const hideDevEnvironments: Array<[string, NodeJS.ProcessEnv]> = [
				["npm_config_omit=dev", { npm_config_omit: "dev" }],
				["NODE_ENV=production", { NODE_ENV: "production" }],
				["npm_config_production=true", { npm_config_production: "true" }],
			];
			const script = join(process.cwd(), "scripts", "check-lock-audit.mjs");
			for (const [label, env] of hideDevEnvironments)
				it(`includes dev dependencies despite ${label}`, () => {
					const result = spawnSync(process.execPath, [script], {
						cwd: process.cwd(),
						encoding: "utf8",
						env: { ...process.env, ...env },
					});
					expect(result.status).toBe(0);
					expect(result.stdout).toContain("no vulnerable packages found");
					expect(result.stdout).not.toContain("accepted");
				});
		},
	);
});
