#!/usr/bin/env node
// Full lock audit gate.
//
// Runs `npm audit --json --audit-level=low --include=dev` over the whole dependency tree and fails
// closed: output that cannot be read, parsed, or validated as a v2 audit report is a rejection,
// never a pass. Forcing `--include=dev` keeps an `omit=dev`, `NODE_ENV=production`, or
// `production=true` npm configuration from hiding the development tree and returning a false clean.
//
// Exactly one development-only finding is tolerated while it matches DEV_AUDIT_EXCEPTION, including
// the lockfile entry, the installed manifests, and the nested upstream shrinkwrap that forces it. The
// exception never hides the real installed version and is not a remediation: any other package, path,
// version, advisory, or production exposure is rejected until a human reviews the exception. A clean
// report only counts as stale when the pinned vulnerable version is really gone from the lock, the
// installed tree, and the shrinkwrap; a clean report while it is still present is rejected.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {{ id: string, severity: string }} AuditAdvisory
 * @typedef {{ version: string | null, dev: boolean, resolved: string | null, integrity: string | null }} LockEntry
 * @typedef {{ errors: string[], lockBrace: LockEntry | null, lockParent: LockEntry | null, installedBraceVersion: string | null, installedParentVersion: string | null, shrinkwrapPresent: boolean, shrinkwrapBraceVersion: string | null, hiddenLockBrace: LockEntry | null }} AuditEvidence
 * @typedef {{ status: "accepted" | "clean" | "rejected", code: string, reasons: string[], advisories: AuditAdvisory[], pin: { version: string, parent: string, nodePath: string } | null }} AuditVerdict
 */

/** The single bounded exception the owner accepted for the development-only tree. */
export const DEV_AUDIT_EXCEPTION = Object.freeze({
	packageName: "brace-expansion",
	nodePath:
		"node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
	installedVersion: "5.0.9",
	parentName: "@earendil-works/pi-coding-agent",
	parentNodePath: "node_modules/@earendil-works/pi-coding-agent",
	parentVersion: "0.87.1",
	shrinkwrapBracePath: "node_modules/brace-expansion",
	lockResolved:
		"https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz",
	lockIntegrity:
		"sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==",
	advisories: Object.freeze([
		Object.freeze({ id: "GHSA-q2hr-2g5m-vwhr", severity: "moderate" }),
		Object.freeze({ id: "GHSA-qhr7-859c-m2p7", severity: "high" }),
		Object.freeze({ id: "GHSA-6j4f-fj2g-mc7p", severity: "high" }),
	]),
	upstreamIssues: Object.freeze([
		"https://github.com/earendil-works/pi/issues/5653",
		"https://github.com/earendil-works/pi/issues/7628",
	]),
});

const SEVERITY_ORDER = Object.freeze({
	info: 0,
	low: 1,
	moderate: 2,
	high: 3,
	critical: 4,
});
const ADVISORY_URL = /^https:\/\/github\.com\/advisories\/(GHSA-[0-9a-z-]+)$/;

/**
 * @param {string} code
 * @param {string[]} reasons
 * @returns {AuditVerdict}
 */
function rejected(code, reasons) {
	return { status: "rejected", code, reasons, advisories: [], pin: null };
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
	for (const key of ["info", "low", "moderate", "high", "critical", "total"])
		if (!isCount(metadata.vulnerabilities?.[key]))
			return `audit metadata has no ${key} vulnerability count`;
	if (!isPlainObject(metadata.dependencies))
		return "audit metadata has no dependency counts";
	for (const key of ["prod", "dev", "total"])
		if (!isCount(metadata.dependencies?.[key]))
			return `audit metadata has no ${key} dependency count`;
	return null;
}

/**
 * @param {unknown} entry
 * @returns {{ entry: Record<string, unknown>, problem: string | null }}
 */
function matchExceptionEntry(entry) {
	if (!isPlainObject(entry))
		return { entry: {}, problem: "finding is not an object" };
	const exception = DEV_AUDIT_EXCEPTION;
	if (entry.name !== exception.packageName)
		return { entry, problem: `unexpected package ${String(entry.name)}` };
	if (entry.isDirect !== false)
		return { entry, problem: "finding is reported as a direct dependency" };
	const nodes = entry.nodes;
	if (
		!Array.isArray(nodes) ||
		nodes.length !== 1 ||
		nodes[0] !== exception.nodePath
	)
		return { entry, problem: "finding is not the pinned nested node path" };
	const effects = entry.effects;
	if (!Array.isArray(effects) || effects.length !== 0)
		return { entry, problem: "finding affects other packages" };
	const via = entry.via;
	if (!Array.isArray(via) || via.length === 0)
		return { entry, problem: "finding has no advisory entries" };

	const known = new Map(
		exception.advisories.map((advisory) => [advisory.id, advisory.severity]),
	);
	const seen = new Set();
	for (const reference of via) {
		if (typeof reference === "string")
			return {
				entry,
				problem: "advisory reference is an unresolved string link",
			};
		if (!isPlainObject(reference))
			return { entry, problem: "advisory entry is not an object" };
		if (
			reference.name !== exception.packageName ||
			reference.dependency !== exception.packageName
		)
			return { entry, problem: "advisory entry names another package" };
		if (
			typeof reference.source !== "number" ||
			!Number.isInteger(reference.source) ||
			reference.source <= 0
		)
			return { entry, problem: "advisory entry has no numeric source id" };
		// The GHSA URL is the stable identifier; npm's numeric source id is only required to be present.
		if (typeof reference.url !== "string")
			return { entry, problem: "advisory entry has no URL" };
		const match = ADVISORY_URL.exec(reference.url);
		const advisoryId = match?.[1];
		if (!advisoryId || !known.has(advisoryId))
			return {
				entry,
				problem: `unknown advisory ${advisoryId ?? reference.url}`,
			};
		if (reference.severity !== known.get(advisoryId))
			return { entry, problem: `severity changed for ${advisoryId}` };
		seen.add(advisoryId);
	}
	if (seen.size !== known.size)
		return { entry, problem: "advisory set changed; review the exception" };

	const expectedSeverity = exception.advisories.reduce(
		(highest, advisory) =>
			SEVERITY_ORDER[advisory.severity] > SEVERITY_ORDER[highest]
				? advisory.severity
				: highest,
		"low",
	);
	if (entry.severity !== expectedSeverity)
		return { entry, problem: "combined severity changed" };
	if (typeof entry.range !== "string" || entry.range.length === 0)
		return { entry, problem: "finding has no vulnerable range" };
	return { entry, problem: null };
}

/**
 * @param {Record<string, unknown>[]} entries
 * @param {Record<string, unknown>} metadata
 * @returns {string | null}
 */
function metadataProblems(entries, metadata) {
	if (metadata.vulnerabilities.total !== entries.length)
		return "vulnerability total does not match the report";
	const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
	for (const entry of entries) {
		const severity = entry?.severity;
		if (typeof severity !== "string" || !(severity in counts))
			return "finding has an unknown severity";
		counts[severity] += 1;
	}
	for (const key of Object.keys(counts))
		if (metadata.vulnerabilities[key] !== counts[key])
			return `vulnerability ${key} count does not match the report`;
	return null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function packageVersion(value) {
	if (!isPlainObject(value) || typeof value.version !== "string") return null;
	return value.version;
}

/**
 * The exception is dev-only only if the lock, the installed manifests, and the upstream shrinkwrap
 * that forces the pin all agree.
 * @param {AuditEvidence} evidence
 * @returns {{ code: string, reason: string } | null}
 */
function devEvidenceProblem(evidence) {
	const exception = DEV_AUDIT_EXCEPTION;
	const lockBrace = evidence.lockBrace;
	if (!lockBrace)
		return {
			code: "reject_evidence_missing",
			reason: "package-lock.json has no entry for the pinned node",
		};
	if (lockBrace.version !== exception.installedVersion)
		return {
			code: "reject_version_changed",
			reason: `package-lock.json pins ${String(lockBrace.version)}, not ${exception.installedVersion}`,
		};
	if (lockBrace.dev !== true)
		return {
			code: "reject_dev_evidence_mismatch",
			reason: "the vulnerable node is not a development-only dependency",
		};
	if (lockBrace.resolved !== exception.lockResolved)
		return {
			code: "reject_dev_evidence_mismatch",
			reason: "the pinned node resolves from an unexpected URL",
		};
	if (lockBrace.integrity !== exception.lockIntegrity)
		return {
			code: "reject_dev_evidence_mismatch",
			reason: "the pinned node has an unexpected integrity hash",
		};
	const lockParent = evidence.lockParent;
	if (
		lockParent?.version !== exception.parentVersion ||
		lockParent.dev !== true
	)
		return {
			code: "reject_dev_evidence_mismatch",
			reason: `the parent package is not ${exception.parentVersion} (dev)`,
		};
	if (evidence.installedParentVersion !== exception.parentVersion)
		return {
			code: "reject_dev_evidence_mismatch",
			reason: "the installed parent package differs from the pin",
		};
	if (evidence.installedBraceVersion !== exception.installedVersion)
		return {
			code: "reject_version_changed",
			reason: `the installed tree holds ${String(evidence.installedBraceVersion)}, not ${exception.installedVersion}`,
		};
	if (
		!evidence.shrinkwrapPresent ||
		evidence.shrinkwrapBraceVersion !== exception.installedVersion
	)
		return {
			code: "reject_shrinkwrap_mismatch",
			reason:
				"the installed upstream shrinkwrap no longer pins the vulnerable version; review the exception",
		};
	if (
		evidence.hiddenLockBrace &&
		(evidence.hiddenLockBrace.version !== exception.installedVersion ||
			evidence.hiddenLockBrace.dev !== true)
	)
		return {
			code: "reject_dev_evidence_mismatch",
			reason: "the installed hidden lock disagrees with the pin",
		};
	return null;
}

/**
 * A clean report only means the exception is stale if the vulnerable pin is really gone. npm can
 * hide the dev tree (omit=dev, NODE_ENV=production, production=true); the fallback command forces
 * `--include=dev`, so this catches any remaining path that still returns a clean report while the
 * lock, the installed tree, or the upstream shrinkwrap pin the vulnerable version.
 * @param {AuditEvidence} evidence
 * @returns {string | null}
 */
function cleanEvidenceProblem(evidence) {
	const exception = DEV_AUDIT_EXCEPTION;
	const pinStillPresent =
		evidence.lockBrace?.version === exception.installedVersion ||
		evidence.installedBraceVersion === exception.installedVersion ||
		evidence.shrinkwrapBraceVersion === exception.installedVersion;
	if (pinStillPresent)
		return `the audit reported no findings while ${exception.packageName}@${exception.installedVersion} is still pinned by the lock, the installed tree, or the upstream shrinkwrap`;
	return null;
}

/**
 * @param {AuditVerdict} verdict
 * @returns {string[]}
 */
export function formatVerdict(verdict) {
	if (verdict.status === "accepted") {
		const exception = DEV_AUDIT_EXCEPTION;
		const advisories = verdict.advisories
			.map((advisory) => `${advisory.id} (${advisory.severity})`)
			.join(", ");
		return [
			"lock-audit: accepted the documented development-only exception",
			`  package: ${exception.packageName}@${exception.installedVersion} (dev-only)`,
			`  parent: ${exception.parentName}@${exception.parentVersion} (dev-only)`,
			`  node: ${exception.nodePath}`,
			`  advisories: ${advisories}`,
			`  upstream: ${exception.upstreamIssues.join(" ")}`,
			"  note: the installed tree still contains this vulnerable version; the exception is not a remediation",
			"  removal: drop the exception when an upstream pi release installs brace-expansion >= 5.0.12 in both the lock and the installed tree",
		];
	}
	if (verdict.status === "clean")
		return [
			"lock-audit: no vulnerable packages found",
			"  the pinned development exception is no longer needed; remove it and its documentation",
		];
	return [
		`lock-audit: rejected (${verdict.code})`,
		...verdict.reasons.map((reason) => `  - ${reason}`),
	];
}

/**
 * @param {unknown} report
 * @param {AuditEvidence} evidence
 * @returns {AuditVerdict}
 */
export function evaluateAuditReport(report, evidence) {
	const schemaProblem = reportSchemaProblem(report);
	if (schemaProblem) return rejected("reject_audit_schema", [schemaProblem]);
	if (evidence.errors.length > 0)
		return rejected("reject_evidence_unreadable", evidence.errors);

	const entries = Object.values(report.vulnerabilities);
	const metadataProblem = metadataProblems(entries, report.metadata);
	if (metadataProblem)
		return rejected("reject_audit_inconsistent", [metadataProblem]);
	if (entries.length === 0) {
		const cleanProblem = cleanEvidenceProblem(evidence);
		if (cleanProblem)
			return rejected("reject_audit_inconsistent", [cleanProblem]);
		return {
			status: "clean",
			code: "ok_no_findings",
			reasons: [],
			advisories: [],
			pin: null,
		};
	}
	if (entries.length !== 1)
		return rejected("reject_unexpected_finding", [
			`expected exactly one vulnerable package, found ${entries.length}`,
		]);

	const { problem } = matchExceptionEntry(entries[0]);
	if (problem) return rejected("reject_unexpected_finding", [problem]);
	const evidenceProblem = devEvidenceProblem(evidence);
	if (evidenceProblem)
		return rejected(evidenceProblem.code, [evidenceProblem.reason]);

	return {
		status: "accepted",
		code: "ok_known_dev_exception",
		reasons: [],
		advisories: DEV_AUDIT_EXCEPTION.advisories.map((advisory) => ({
			id: advisory.id,
			severity: advisory.severity,
		})),
		pin: {
			version: DEV_AUDIT_EXCEPTION.installedVersion,
			parent: DEV_AUDIT_EXCEPTION.parentVersion,
			nodePath: DEV_AUDIT_EXCEPTION.nodePath,
		},
	};
}

/**
 * @param {string} stdout
 * @param {AuditEvidence} evidence
 * @returns {AuditVerdict}
 */
export function evaluateAuditOutput(stdout, evidence) {
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
	return evaluateAuditReport(report, evidence);
}

/**
 * @param {string} file
 * @returns {{ state: "missing" | "invalid" | "present", value: unknown }}
 */
function readJsonFile(file) {
	if (!existsSync(file)) return { state: "missing", value: null };
	try {
		return { state: "present", value: JSON.parse(readFileSync(file, "utf8")) };
	} catch {
		return { state: "invalid", value: null };
	}
}

/**
 * @param {unknown} packages
 * @param {string} key
 * @returns {LockEntry | null}
 */
function readLockEntry(packages, key) {
	if (!isPlainObject(packages)) return null;
	const entry = packages[key];
	if (!isPlainObject(entry)) return null;
	return {
		version: typeof entry.version === "string" ? entry.version : null,
		dev: entry.dev === true,
		resolved: typeof entry.resolved === "string" ? entry.resolved : null,
		integrity: typeof entry.integrity === "string" ? entry.integrity : null,
	};
}

/**
 * Reads only the files the exception needs: the committed lock, the installed package manifests, the
 * installed upstream shrinkwrap, and the hidden lock. Missing installed files stay null so the caller
 * decides; a missing or corrupt lock is an error.
 * @param {string} rootDirectory
 * @returns {AuditEvidence}
 */
export function readEvidence(rootDirectory) {
	const errors = [];
	const exception = DEV_AUDIT_EXCEPTION;
	const lock = readJsonFile(join(rootDirectory, "package-lock.json"));
	if (lock.state === "missing") errors.push("package-lock.json is missing");
	else if (lock.state === "invalid")
		errors.push("package-lock.json is not valid JSON");
	const lockPackages =
		lock.state === "present" && isPlainObject(lock.value)
			? lock.value.packages
			: undefined;

	const shrinkwrap = readJsonFile(
		join(rootDirectory, exception.parentNodePath, "npm-shrinkwrap.json"),
	);
	const shrinkwrapPackages =
		shrinkwrap.state === "present" && isPlainObject(shrinkwrap.value)
			? shrinkwrap.value.packages
			: undefined;
	const hiddenLock = readJsonFile(
		join(rootDirectory, "node_modules", ".package-lock.json"),
	);
	const hiddenLockPackages =
		hiddenLock.state === "present" && isPlainObject(hiddenLock.value)
			? hiddenLock.value.packages
			: undefined;

	return {
		errors,
		lockBrace: readLockEntry(lockPackages, exception.nodePath),
		lockParent: readLockEntry(lockPackages, exception.parentNodePath),
		installedBraceVersion: packageVersion(
			readJsonFile(join(rootDirectory, exception.nodePath, "package.json"))
				.value,
		),
		installedParentVersion: packageVersion(
			readJsonFile(
				join(rootDirectory, exception.parentNodePath, "package.json"),
			).value,
		),
		shrinkwrapPresent: shrinkwrap.state === "present",
		shrinkwrapBraceVersion:
			readLockEntry(shrinkwrapPackages, exception.shrinkwrapBracePath)
				?.version ?? null,
		hiddenLockBrace: readLockEntry(hiddenLockPackages, exception.nodePath),
	};
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
	const evidence = readEvidence(rootDirectory);
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
	return evaluateAuditOutput(result.stdout ?? "", evidence);
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
