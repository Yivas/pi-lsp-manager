import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

/**
 * Ownership seam for the opt-in Python installation gate. The gate refuses to reuse or
 * reset a directory another writer owns: it claims an exclusive, empty root with an
 * O_EXCL marker written only after the interpreter is trusted, and every managed-scope
 * removal re-reads that marker and compares it byte-for-byte with the run that claimed
 * it. The helpers are exported so the deterministic suite can prove those refusals
 * without running pip.
 */

export const GATE_OWNER_MARKER = ".python-install-gate-owner.json";
export const GATE_MANAGED_SCOPES = [
	"ty",
	"ruff",
	"cancel",
	"rollback",
] as const;
export type GateScope = (typeof GATE_MANAGED_SCOPES)[number];

export interface GateOwner {
	pid: number;
	user: string;
	createdAt: string;
}

export interface GateOwnerRecord {
	authority: "python-install-gate";
	formatVersion: 1;
	token: string;
	root: string;
	nonce: string;
	owner: GateOwner;
	scopes: readonly GateScope[];
}

export interface GateClaim {
	root: string;
	marker: string;
	record: GateOwnerRecord;
	markerBytes: string;
}

export function inside(parent: string, child: string): boolean {
	const pathFromParent = relative(parent, child);
	return (
		pathFromParent === "" ||
		(pathFromParent !== ".." &&
			!pathFromParent.startsWith(`..${sep}`) &&
			!isAbsolute(pathFromParent))
	);
}

export function isGateScope(value: string): value is GateScope {
	return (GATE_MANAGED_SCOPES as readonly string[]).includes(value);
}

/** Fails closed on a missing handoff variable before the root is ever touched. */
export function requireGateEnvironment(
	name: string,
	value: string | undefined,
): string {
	if (!value || value.trim().length === 0)
		throw new Error(
			`${name} is required when RUN_REAL_PYTHON_INSTALL=1; the gate fails closed instead of the host PATH or a checkout binary.`,
		);
	return value;
}

function isRecordString(value: unknown, expected?: string): boolean {
	return (
		typeof value === "string" && (expected === undefined || value === expected)
	);
}

/** Strictly parses a marker so a truncated or foreign record cannot pass as ownership. */
export function parseGateOwnerRecord(text: string): GateOwnerRecord {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("The gate owner marker is not valid JSON.");
	}
	if (typeof value !== "object" || value === null)
		throw new Error("The gate owner marker is not an object.");
	const record = value as Record<string, unknown>;
	const owner = record.owner as Record<string, unknown> | undefined;
	if (
		!isRecordString(record.authority, "python-install-gate") ||
		record.formatVersion !== 1 ||
		typeof record.token !== "string" ||
		typeof record.root !== "string" ||
		typeof record.nonce !== "string" ||
		typeof owner !== "object" ||
		owner === null ||
		typeof owner.pid !== "number" ||
		typeof owner.user !== "string" ||
		typeof owner.createdAt !== "string" ||
		!Array.isArray(record.scopes) ||
		!record.scopes.every((scope) => isGateScope(scope as string))
	)
		throw new Error("The gate owner marker is incomplete.");
	return {
		authority: "python-install-gate",
		formatVersion: 1,
		token: record.token,
		root: record.root,
		nonce: record.nonce,
		owner: { pid: owner.pid, user: owner.user, createdAt: owner.createdAt },
		scopes: record.scopes as readonly GateScope[],
	};
}

export function gateOwnerBytes(record: GateOwnerRecord): string {
	return `${JSON.stringify(record)}\n`;
}

export interface InspectedGateRoot {
	root: string;
	existed: boolean;
}

/**
 * Reads the root shape without creating, claiming or deleting anything. An existing root
 * must be an empty directory whose canonical path stays outside the checkout; a missing
 * root only needs a canonical parent outside the checkout, so the caller-created parent is
 * what the later `mkdir` writes into.
 */
export async function inspectGateRoot(options: {
	rawRoot: string;
	checkout: string;
}): Promise<InspectedGateRoot> {
	const { rawRoot } = options;
	if (!isAbsolute(rawRoot))
		throw new Error("PYTHON_INSTALL_GATE_ROOT must be an absolute path.");
	const canonicalCheckout = await realpath(options.checkout).catch(
		() => options.checkout,
	);
	const lexical = resolve(rawRoot);
	const existing = await lstat(lexical).then(
		() => true,
		() => false,
	);
	if (existing) {
		// A symlink or junction is resolved before the boundary test, so a root that points
		// into the checkout is refused before anything is created.
		const canonical = await realpath(lexical);
		if (canonical === canonicalCheckout || inside(canonicalCheckout, canonical))
			throw new Error(
				"PYTHON_INSTALL_GATE_ROOT must stay outside the checkout.",
			);
		const metadata = await lstat(canonical);
		if (!metadata.isDirectory())
			throw new Error("PYTHON_INSTALL_GATE_ROOT must be a directory.");
		const entries = await readdir(canonical);
		if (entries.length > 0)
			throw new Error(
				"PYTHON_INSTALL_GATE_ROOT must be empty: the gate refuses to reuse a root another writer owns.",
			);
		return { root: canonical, existed: true };
	}
	if (lexical === canonicalCheckout || inside(canonicalCheckout, lexical))
		throw new Error("PYTHON_INSTALL_GATE_ROOT must stay outside the checkout.");
	const parent = dirname(lexical);
	const canonicalParent = await realpath(parent).catch(() => parent);
	if (
		canonicalParent === canonicalCheckout ||
		inside(canonicalCheckout, canonicalParent)
	)
		throw new Error("PYTHON_INSTALL_GATE_ROOT must stay outside the checkout.");
	return { root: join(canonicalParent, basename(lexical)), existed: false };
}

/**
 * Claims the inspected root with a fresh random token and run nonce. The marker is written
 * with `wx` (O_EXCL) so an existing marker from any other writer is never overwritten; the
 * caller must trust the interpreter before reaching this point so a refused run writes
 * nothing into the root.
 */
export async function claimGateRoot(options: {
	inspected: InspectedGateRoot;
	owner: GateOwner;
	scopes?: readonly GateScope[];
}): Promise<GateClaim> {
	const scopes = options.scopes ?? GATE_MANAGED_SCOPES;
	if (!options.inspected.existed)
		await mkdir(options.inspected.root, { mode: 0o700 });
	const marker = join(options.inspected.root, GATE_OWNER_MARKER);
	const record: GateOwnerRecord = {
		authority: "python-install-gate",
		formatVersion: 1,
		token: randomUUID(),
		root: options.inspected.root,
		nonce: randomUUID(),
		owner: options.owner,
		scopes,
	};
	const markerBytes = gateOwnerBytes(record);
	try {
		await writeFile(marker, markerBytes, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(
				"PYTHON_INSTALL_GATE_ROOT already carries an owner marker; refusing to claim another writer's root.",
			);
		throw error;
	}
	return { root: options.inspected.root, marker, record, markerBytes };
}

export type GateTrustOutcome =
	| { ok: true; reason?: undefined }
	| { ok: false; reason: string };

export interface OwnedGateRootOptions {
	rawRoot: string;
	checkout: string;
	owner: GateOwner;
	scopes?: readonly GateScope[];
	/** Runs before the marker is written; a refusal must leave the root untouched. */
	trust: () => Promise<GateTrustOutcome>;
}

/** Inspects, trusts, then claims: a refused interpreter never reaches the marker write. */
export async function openGateRoot(
	options: OwnedGateRootOptions,
): Promise<GateClaim> {
	const inspected = await inspectGateRoot({
		rawRoot: options.rawRoot,
		checkout: options.checkout,
	});
	const trusted = await options.trust();
	if (!trusted.ok)
		throw new Error(
			`PYTHON_GATE_INTERPRETER was refused before the gate root was claimed: ${trusted.reason}.`,
		);
	const claimOptions: {
		inspected: InspectedGateRoot;
		owner: GateOwner;
		scopes?: readonly GateScope[];
	} = { inspected, owner: options.owner };
	if (options.scopes) claimOptions.scopes = options.scopes;
	return claimGateRoot(claimOptions);
}

/** Resolves the handoff file inside the owned root; nothing outside it is writable. */
export function ownGateOutput(root: string, rawOutput: string): string {
	if (!isAbsolute(rawOutput))
		throw new Error("PYTHON_INSTALL_GATE_OUTPUT must be an absolute path.");
	const output = resolve(rawOutput);
	if (output === root || !inside(root, output))
		throw new Error(
			"PYTHON_INSTALL_GATE_OUTPUT must stay inside the owned gate root.",
		);
	return output;
}

/**
 * Re-reads the marker and proves it is byte-identical to the claim this process wrote,
 * with the same token, run nonce, root and live PID, before any managed path is mutated.
 * Another writer's marker, a replaced marker or a moved root fails closed.
 */
export async function assertGateClaim(
	claim: GateClaim,
): Promise<GateOwnerRecord> {
	let onDisk: string;
	try {
		onDisk = await readFile(claim.marker, "utf8");
	} catch {
		throw new Error(
			"The owned gate marker is missing; refusing to mutate another writer's root.",
		);
	}
	if (onDisk !== claim.markerBytes)
		throw new Error(
			"The owned gate marker changed; refusing to mutate another writer's root.",
		);
	const record = parseGateOwnerRecord(onDisk);
	if (
		record.token !== claim.record.token ||
		record.nonce !== claim.record.nonce ||
		record.root !== claim.root ||
		record.owner.pid !== process.pid
	)
		throw new Error(
			"The owned gate marker does not belong to this run; refusing to mutate another writer's root.",
		);
	const canonical = await realpath(claim.root);
	if (canonical !== claim.root)
		throw new Error(
			"The owned gate root moved; refusing to mutate another writer's root.",
		);
	return record;
}

/** Removes exactly one owned scope under the verified root, never a glob. */
export async function resetGateScope(
	claim: GateClaim,
	scope: GateScope,
): Promise<string> {
	if (!isGateScope(scope))
		throw new Error(
			"Only the owned ty, ruff, cancel and rollback scopes reset.",
		);
	await assertGateClaim(claim);
	const directory = join(claim.root, scope);
	if (directory === claim.root || !inside(claim.root, directory))
		throw new Error("The managed scope escapes the owned gate root.");
	await rm(directory, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 50,
	});
	const managed = join(directory, "managed");
	await mkdir(managed, { recursive: true, mode: 0o700 });
	return managed;
}

export const GATE_MANIFEST_FORMAT_VERSION = 1;

export interface GateHandoffExecutable {
	path: string;
	version: string;
	sha256: string;
}

export interface GateHandoffServer {
	serverId: string;
	revision: string;
	executable: GateHandoffExecutable;
	requirementsSha256: string;
	wheel: { fileName: string; sha256: string };
	nativeOutput: string;
	phase: "ready";
}

export interface GateCaseResults {
	inactivePolicy: boolean;
	cancel: boolean;
	rollback: boolean;
	ty: boolean;
	ruff: boolean;
}

export interface GateManifest {
	gate: "python-install-gate";
	formatVersion: number;
	status: "complete" | "failed";
	createdAt: string;
	root: string;
	marker: string;
	owner: GateOwner;
	token: string;
	nonce: string;
	interpreter: {
		path: string;
		pythonVersion: string;
		pipVersion: string;
		provenance: string;
	};
	platform: NodeJS.Platform;
	architecture: NodeJS.Architecture;
	checkout: string;
	cases: GateCaseResults;
	servers: { ty?: GateHandoffServer; ruff?: GateHandoffServer };
	retention: string;
	ciBaseline: string;
}

/** Writes the manifest atomically inside the verified owned root. */
export async function writeGateManifest(
	claim: GateClaim,
	outputFile: string,
	manifest: GateManifest,
): Promise<void> {
	const output = ownGateOutput(claim.root, outputFile);
	if (manifest.root !== claim.root)
		throw new Error("The manifest root does not match the owned gate root.");
	await assertGateClaim(claim);
	const temporary = `${output}.partial-${randomUUID()}`;
	await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporary, output);
}

export interface GateManifestExpectations {
	root?: string;
	versions?: Partial<Record<"ty" | "ruff", string>>;
}

/**
 * Consumer-side validation: only a `complete` manifest with both `ready` servers whose
 * executables live inside the recorded root, at the expected versions, is accepted.
 */
export function parseGateManifest(
	text: string,
	expectations: GateManifestExpectations = {},
): GateManifest {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("The gate manifest is not valid JSON.");
	}
	if (typeof value !== "object" || value === null)
		throw new Error("The gate manifest is not an object.");
	const manifest = value as GateManifest;
	if (manifest.gate !== "python-install-gate")
		throw new Error("The gate manifest has the wrong kind.");
	if (manifest.formatVersion !== GATE_MANIFEST_FORMAT_VERSION)
		throw new Error("The gate manifest has an unsupported format version.");
	if (manifest.status !== "complete")
		throw new Error(
			`The gate manifest is not complete (status: ${manifest.status}).`,
		);
	if (typeof manifest.root !== "string" || manifest.root.length === 0)
		throw new Error("The gate manifest has no owned root.");
	if (expectations.root !== undefined && manifest.root !== expectations.root)
		throw new Error("The gate manifest root does not match the expected root.");
	for (const id of ["ty", "ruff"] as const) {
		const server = manifest.servers?.[id];
		if (!server || server.phase !== "ready")
			throw new Error(`The gate manifest is missing the ready ${id} server.`);
		if (
			typeof server.executable?.path !== "string" ||
			!inside(manifest.root, server.executable.path)
		)
			throw new Error(`The ${id} executable escapes the owned gate root.`);
		const expectedVersion = expectations.versions?.[id];
		if (
			expectedVersion !== undefined &&
			server.executable.version !== expectedVersion
		)
			throw new Error(`The ${id} executable has an unexpected version.`);
	}
	return manifest;
}
