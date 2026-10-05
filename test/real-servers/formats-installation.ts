import { createHash } from "node:crypto";
import {
	appendFile,
	lstat,
	readFile,
	readdir,
	realpath,
	rename,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
	getRecipe,
	INACTIVE_FORMAT_RECIPES,
	type NpmInstallRecipe,
} from "../../src/install/catalog.js";
import { InstallCoordinator } from "../../src/install/coordinator.js";
import {
	NodePackageManager,
	type SpawnFunction,
} from "../../src/install/npm.js";
import { createNodeInstallationVerifier } from "../../src/install/verify.js";

/**
 * Shared gate for the opt-in real-format matrix. It installs the two inactive JSON and
 * YAML recipes through the production coordinator (real npm `ci`, the frozen lock and the
 * pinned SRI) and writes a small JSON handoff the fixture step consumes. It is skipped
 * unless `RUN_REAL_FORMATS_INSTALL=1`, so the deterministic suite starts no process and
 * creates no directory. Everything here is test-only: no product module imports it.
 */

export const FORMATS_GATE_FLAG = "RUN_REAL_FORMATS_INSTALL";
export const FORMATS_INSTALL_ROOT_ENV = "FORMATS_INSTALL_ROOT";
export const FORMATS_INSTALL_HANDOFF_ENV = "FORMATS_INSTALL_HANDOFF";

export const FORMATS_SERVER_IDS = [
	"vscode-json-language-server",
	"yaml-language-server",
] as const;
export type FormatsServerId = (typeof FORMATS_SERVER_IDS)[number];

function isFormatsServerId(value: string): value is FormatsServerId {
	return (FORMATS_SERVER_IDS as readonly string[]).includes(value);
}

// A real `npm ci` runs once per closure. The bound stays above the product default of two
// minutes so a slow runner reaches the coordinator's own `timed_out` result instead of
// vitest's test timeout.
const INSTALL_TIMEOUT_MS = 600_000;

export interface FormatsGateConfig {
	readonly root: string;
	readonly handoff: string;
}

export interface FormatsHandoffServer {
	readonly id: FormatsServerId;
	readonly entry: string;
	readonly version: string;
	readonly sha256: string;
}

export interface FormatsHandoff {
	readonly version: 1;
	readonly root: string;
	readonly servers: readonly FormatsHandoffServer[];
}

/**
 * Reads the opt-in configuration. It returns `undefined` unless the flag is exactly `"1"`,
 * so the default suite never touches a directory, starts npm or writes a file. With the
 * flag set, both the owned root and the handoff file are required and the gate fails closed.
 */
export function readFormatsGate(
	environment: NodeJS.ProcessEnv,
): FormatsGateConfig | undefined {
	if (environment[FORMATS_GATE_FLAG] !== "1") return undefined;
	const root = environment[FORMATS_INSTALL_ROOT_ENV];
	const handoff = environment[FORMATS_INSTALL_HANDOFF_ENV];
	if (!root)
		throw new Error(
			`${FORMATS_INSTALL_ROOT_ENV} is required when ${FORMATS_GATE_FLAG}=1.`,
		);
	if (!handoff)
		throw new Error(
			`${FORMATS_INSTALL_HANDOFF_ENV} is required when ${FORMATS_GATE_FLAG}=1.`,
		);
	return { root, handoff };
}

function inside(parent: string, child: string): boolean {
	const pathFromParent = relative(parent, child);
	return (
		pathFromParent === "" ||
		(pathFromParent !== ".." &&
			!pathFromParent.startsWith(`..${sep}`) &&
			!isAbsolute(pathFromParent))
	);
}

/**
 * Security barrier that runs before any network or process. The caller hands the gate a
 * directory it owns and can remove: an absolute, existing, empty directory outside the
 * checkout. The canonical realpath is returned so later boundaries compare canonical paths
 * on every platform (Windows short names, the `/var` alias on macOS).
 */
export async function assertOwnedRoot(
	root: string,
	checkout: string,
): Promise<string> {
	if (!isAbsolute(root))
		throw new Error("FORMATS_INSTALL_ROOT must be an absolute path.");
	const metadata = await lstat(root).catch(() => undefined);
	if (!metadata) throw new Error("FORMATS_INSTALL_ROOT must already exist.");
	if (!metadata.isDirectory())
		throw new Error("FORMATS_INSTALL_ROOT must be a directory.");
	const canonical = await realpath(root);
	const canonicalCheckout = await realpath(checkout);
	if (canonical === canonicalCheckout || inside(canonicalCheckout, canonical))
		throw new Error("FORMATS_INSTALL_ROOT must stay outside the checkout.");
	if ((await readdir(canonical)).length > 0)
		throw new Error(
			"FORMATS_INSTALL_ROOT must be empty: the gate refuses to reuse another writer's root.",
		);
	return canonical;
}

/** The pinned JS entry the real fixture runs with `node <entry> --stdio`. */
function formatEntryPath(recipe: NpmInstallRecipe, target: string): string {
	const pin = recipe.packages[0];
	const locked = recipe.lockfile?.packages[`node_modules/${pin?.name ?? ""}`] as
		| { bin?: Record<string, string> }
		| undefined;
	const relativeEntry = locked?.bin?.[recipe.executable];
	if (!pin || !relativeEntry)
		throw new Error(
			`The ${recipe.serverId} lock does not pin the ${recipe.executable} entry.`,
		);
	return join(target, "node_modules", pin.name, relativeEntry);
}

async function fileSha256(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

export interface FormatsInstallOptions {
	readonly root: string;
	readonly spawnProcess?: SpawnFunction;
}

/**
 * Installs both inactive format closures through the production coordinator. The decision
 * injects the frozen `INACTIVE_FORMAT_RECIPES` entry directly; the gate asserts `getRecipe`
 * stays undefined first, so the candidate can never leak into the active registry.
 */
export async function installFormatServers(
	options: FormatsInstallOptions,
): Promise<FormatsHandoff> {
	for (const id of FORMATS_SERVER_IDS) {
		if (getRecipe(id))
			throw new Error(
				`The ${id} recipe must stay inactive while the format matrix gate runs.`,
			);
	}
	const managed = join(options.root, "managed");
	const coordinator = new InstallCoordinator({
		packageManager: new NodePackageManager(options.spawnProcess),
		verifier: createNodeInstallationVerifier(
			process.platform,
			options.spawnProcess,
		),
		installTimeoutMs: INSTALL_TIMEOUT_MS,
	});
	const servers: FormatsHandoffServer[] = [];
	try {
		for (const id of FORMATS_SERVER_IDS) {
			const recipe = INACTIVE_FORMAT_RECIPES[id];
			const result = await coordinator.install({
				decision: { allowed: true, recipe },
				managedStatePath: managed,
			});
			if (result.status !== "ready")
				throw new Error(
					`The ${id} install did not become ready: ${result.reason ?? "unknown"}.`,
				);
			const entry = await realpath(
				formatEntryPath(recipe, join(managed, "servers", id, recipe.revision)),
			);
			if (!inside(options.root, entry))
				throw new Error(`The ${id} entry escaped the owned root.`);
			servers.push({
				id,
				entry,
				version: recipe.expectedVersion,
				sha256: await fileSha256(entry),
			});
		}
	} finally {
		await coordinator.shutdown();
	}
	return { version: 1, root: options.root, servers };
}

export interface FormatsGateRun {
	readonly environment: NodeJS.ProcessEnv;
	readonly checkout: string;
	readonly spawnProcess?: SpawnFunction;
}

/**
 * Runs the opt-in gate. With the flag off it returns `undefined` before constructing a
 * package manager, so the default suite is a zero-child, zero-directory skip. With the
 * flag on it validates the caller-owned root, installs both closures and writes the handoff.
 */
export async function runFormatsInstallationGate(
	run: FormatsGateRun,
): Promise<FormatsHandoff | undefined> {
	const config = readFormatsGate(run.environment);
	if (!config) return undefined;
	const root = await assertOwnedRoot(config.root, run.checkout);
	const installed = await installFormatServers({
		root,
		...(run.spawnProcess ? { spawnProcess: run.spawnProcess } : {}),
	});
	await writeFormatsHandoff(config.handoff, installed);
	// The producer consumes its own artifact through the validated reader, so the exported
	// environment carries only canonical, contained, SHA-checked paths.
	const trusted = await readFormatsHandoff(config.handoff, root);
	await exportFormatsCliEnvironment(trusted, run.environment);
	return trusted;
}

export async function writeFormatsHandoff(
	handoffPath: string,
	handoff: FormatsHandoff,
): Promise<void> {
	// Atomic hand-off: a partial read can never see a half-written body.
	const temporary = `${handoffPath}.partial`;
	await writeFile(temporary, `${JSON.stringify(handoff)}\n`, "utf8");
	await rename(temporary, handoffPath);
}

const FORMATS_CLI_ENV: Readonly<Record<FormatsServerId, string>> = {
	"vscode-json-language-server": "JSON_LSP_CLI",
	"yaml-language-server": "YAML_LSP_CLI",
};

/**
 * Appends the validated CLI entries to the runner's `GITHUB_ENV` file when one exists, so the
 * fixture step consumes the reader's canonical, root-confined, SHA-checked paths instead of a
 * hand-parsed copy. Nothing is written outside CI, and a newline in any value is refused so a
 * handoff cannot inject another environment variable.
 */
export async function exportFormatsCliEnvironment(
	handoff: FormatsHandoff,
	environment: NodeJS.ProcessEnv,
): Promise<void> {
	const envFile = environment.GITHUB_ENV;
	if (!envFile) return;
	const lines = handoff.servers.map((server) => {
		if (/[\r\n]/.test(server.entry))
			throw new Error("The formats handoff entry is not a single line.");
		return `${FORMATS_CLI_ENV[server.id]}=${server.entry}`;
	});
	await appendFile(envFile, `${lines.join("\n")}\n`, "utf8");
}

/**
 * Reads the handoff as data. It never imports or executes it: the JSON is schema checked,
 * the recorded root must canonicalize to the expected root, the two server ids must be
 * distinct (exactly the known pair), each version must match the internal recipe pin (the
 * version is never trusted from the file) and every entry must canonicalize inside the root
 * with a matching SHA-256, so a swapped CLI cannot be handed to the fixture.
 */
export async function readFormatsHandoff(
	handoffPath: string,
	expectedRoot: string,
): Promise<FormatsHandoff> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(handoffPath, "utf8"));
	} catch {
		throw new Error("The formats handoff is not valid JSON.");
	}
	if (typeof parsed !== "object" || parsed === null)
		throw new Error("The formats handoff is not an object.");
	const {
		version,
		root: recordedRoot,
		servers,
	} = parsed as {
		version?: unknown;
		root?: unknown;
		servers?: unknown;
	};
	if (version !== 1) throw new Error("Unsupported formats handoff version.");
	if (typeof recordedRoot !== "string" || !isAbsolute(recordedRoot))
		throw new Error("The formats handoff root is not an absolute path.");
	const canonicalRoot = await realpath(expectedRoot).catch(() => undefined);
	if (!canonicalRoot)
		throw new Error("The expected formats root does not exist.");
	const canonicalRecorded = await realpath(recordedRoot).catch(() => undefined);
	if (!canonicalRecorded || canonicalRecorded !== canonicalRoot)
		throw new Error(
			"The formats handoff root does not match the expected root.",
		);
	if (!Array.isArray(servers) || servers.length !== FORMATS_SERVER_IDS.length)
		throw new Error("The formats handoff does not list both servers.");
	const seen = new Set<FormatsServerId>();
	const validated: FormatsHandoffServer[] = [];
	for (const raw of servers) {
		const entry = raw as Partial<FormatsHandoffServer>;
		if (typeof entry.id !== "string" || !isFormatsServerId(entry.id))
			throw new Error("The formats handoff entry has an unknown id.");
		if (seen.has(entry.id))
			throw new Error("The formats handoff repeats a server id.");
		seen.add(entry.id);
		const expectedVersion = INACTIVE_FORMAT_RECIPES[entry.id].expectedVersion;
		const version = entry.version;
		if (
			typeof entry.entry !== "string" ||
			typeof version !== "string" ||
			version !== expectedVersion ||
			typeof entry.sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(entry.sha256)
		)
			throw new Error("The formats handoff entry is malformed.");
		const canonical = await realpath(entry.entry).catch(() => undefined);
		if (!canonical || !inside(canonicalRoot, canonical))
			throw new Error("The formats handoff entry escaped the owned root.");
		if ((await fileSha256(canonical)) !== entry.sha256)
			throw new Error("The formats handoff CLI hash does not match.");
		validated.push({
			id: entry.id,
			entry: canonical,
			version,
			sha256: entry.sha256,
		});
	}
	return { version: 1, root: canonicalRoot, servers: validated };
}
