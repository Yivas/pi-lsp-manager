#!/usr/bin/env node
// Full lock audit gate. Always include development dependencies and reject malformed reports or findings.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * @typedef {{ status: "clean" | "rejected", code: string, reasons: string[] }} AuditVerdict
 */

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

/**
 * @param {string} code
 * @param {string[]} reasons
 * @returns {AuditVerdict}
 */
function rejected(code, reasons) {
	return { status: "rejected", code, reasons };
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * @param {unknown} report
 * @returns {string | null}
 */
function reportSchemaProblem(report) {
	if (!isPlainObject(report)) return "audit output is not an object";
	if (report.auditReportVersion !== 2) return "audit report version is not 2";
	if (!isPlainObject(report.vulnerabilities))
		return "audit report has no vulnerabilities map";
	const metadata = report.metadata;
	if (!isPlainObject(metadata)) return "audit report has no metadata";
	if (!isPlainObject(metadata.vulnerabilities))
		return "audit report has no vulnerability counts";
	for (const key of [...SEVERITIES, "total"])
		if (!isCount(metadata.vulnerabilities[key]))
			return `audit metadata has no ${key} vulnerability count`;
	if (!isPlainObject(metadata.dependencies))
		return "audit report has no dependency counts";
	for (const key of ["prod", "dev", "total"])
		if (!isCount(metadata.dependencies[key]))
			return `audit metadata has no ${key} dependency count`;
	return null;
}

/**
 * @param {Record<string, unknown>[]} entries
 * @param {Record<string, any>} metadata
 * @returns {string | null}
 */
function metadataProblem(entries, metadata) {
	if (metadata.vulnerabilities.total !== entries.length)
		return "vulnerability total does not match the report";
	const counts = Object.fromEntries(
		SEVERITIES.map((severity) => [severity, 0]),
	);
	for (const entry of entries) {
		if (!isPlainObject(entry)) return "finding is not an object";
		if (typeof entry.severity !== "string" || !(entry.severity in counts))
			return "finding has an unknown severity";
		counts[entry.severity] += 1;
	}
	for (const severity of SEVERITIES)
		if (metadata.vulnerabilities[severity] !== counts[severity])
			return `vulnerability ${severity} count does not match the report`;
	return null;
}

/**
 * @param {unknown} report
 * @returns {AuditVerdict}
 */
export function evaluateAuditReport(report) {
	const schemaProblem = reportSchemaProblem(report);
	if (schemaProblem) return rejected("reject_audit_schema", [schemaProblem]);

	const entries = Object.values(report.vulnerabilities);
	const inconsistency = metadataProblem(entries, report.metadata);
	if (inconsistency)
		return rejected("reject_audit_inconsistent", [inconsistency]);
	if (entries.length > 0) {
		const findings = entries.map((entry) => {
			const name =
				typeof entry.name === "string" ? entry.name : "unknown package";
			return `${name} (${entry.severity})`;
		});
		return rejected("reject_audit_findings", [
			`npm audit found ${entries.length} vulnerable package(s): ${findings.join(", ")}`,
		]);
	}
	return { status: "clean", code: "ok_no_findings", reasons: [] };
}

/**
 * @param {string} stdout
 * @returns {AuditVerdict}
 */
export function evaluateAuditOutput(stdout) {
	let report;
	try {
		report = JSON.parse(stdout);
	} catch {
		return rejected("reject_audit_unparseable", [
			"npm audit did not return JSON",
		]);
	}
	if (!isPlainObject(report))
		return rejected("reject_audit_schema", ["audit output is not an object"]);
	if ("error" in report) {
		const code =
			isPlainObject(report.error) && typeof report.error.code === "string"
				? report.error.code
				: "unknown";
		return rejected("reject_audit_error", [
			`npm audit reported an error (${code})`,
		]);
	}
	return evaluateAuditReport(report);
}

/** Runs the full audit, preferring the npm CLI invoked by the surrounding npm script. */
function resolveAuditCommand() {
	const npmEntry = process.env.npm_execpath;
	if (npmEntry?.toLowerCase().endsWith(".js") && existsSync(npmEntry))
		return {
			command: process.execPath,
			args: [npmEntry, "audit", "--json", "--audit-level=low", "--include=dev"],
			windowsVerbatimArguments: false,
		};
	if (process.platform === "win32")
		// cmd.exe parses the constant string even with shell:false; no caller data is interpolated.
		return {
			command: process.env.ComSpec ?? "cmd.exe",
			args: [
				"/d",
				"/s",
				"/c",
				'"npm audit --json --audit-level=low --include=dev"',
			],
			windowsVerbatimArguments: true,
		};
	return {
		command: "npm",
		args: ["audit", "--json", "--audit-level=low", "--include=dev"],
		windowsVerbatimArguments: false,
	};
}

/**
 * @param {string} rootDirectory
 * @returns {AuditVerdict}
 */
export function runLockAuditCheck(rootDirectory = process.cwd()) {
	const launch = resolveAuditCommand();
	const result = spawnSync(launch.command, launch.args, {
		cwd: rootDirectory,
		shell: false,
		windowsVerbatimArguments: launch.windowsVerbatimArguments,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, npm_config_update_notifier: "false" },
	});
	if (result.error) {
		const code =
			typeof result.error.code === "string" ? result.error.code : "unknown";
		return rejected("reject_audit_spawn_failed", [
			`npm audit could not run (${code})`,
		]);
	}
	const verdict = evaluateAuditOutput(result.stdout ?? "");
	if (result.status === 0) return verdict;
	if (verdict.status === "rejected") return verdict;
	return rejected("reject_audit_exit", [
		`npm audit exited with status ${String(result.status)}${result.signal ? ` (${result.signal})` : ""}`,
	]);
}

/**
 * @param {AuditVerdict} verdict
 * @returns {string[]}
 */
export function formatVerdict(verdict) {
	if (verdict.status === "clean")
		return ["lock-audit: no vulnerable packages found"];
	return [
		`lock-audit: rejected (${verdict.code})`,
		...verdict.reasons.map((reason) => `  - ${reason}`),
	];
}

function main() {
	const verdict = runLockAuditCheck();
	const lines = formatVerdict(verdict);
	const stream =
		verdict.status === "rejected" ? process.stderr : process.stdout;
	for (const line of lines) stream.write(`${line}\n`);
	return verdict.status === "rejected" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	process.exitCode = main();
