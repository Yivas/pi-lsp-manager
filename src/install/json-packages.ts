import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { FORMAT_RECIPES, type InstallRecipe } from "./catalog.js";
import type { InstalledExecutable } from "./verify.js";

/** The only server id that verifies through installed metadata instead of a `--version` probe. */
export const JSON_SERVER_ID = "vscode-json-language-server";

/** The approved frozen recipe. The predicate below accepts nothing that differs from it. */
const APPROVED_JSON_RECIPE = FORMAT_RECIPES[JSON_SERVER_ID];
const APPROVED_JSON_PIN = APPROVED_JSON_RECIPE.packages[0];

/**
 * The entry the approved tarball declares and its SHA-256. Both are constants, so the digest
 * can only match the pinned 4.10.0 artifact. A version probe is impossible here: the entry
 * calls `createConnection()` with no arguments and throws before printing anything.
 */
const JSON_BIN_RELATIVE_PATH = "bin/vscode-json-language-server";
const JSON_BIN_SHA256 =
	"8a9dc4ab378de995aadd8ab25e13450eb8a27b6e0e8dc47fecb41a7b57488c26";

/**
 * SHA-256 of the full npm-generated Windows `.cmd` shim with CRLF normalized to LF. Only a
 * digest is kept, never the npm template. Hashing the whole script binds the launcher to the
 * pinned entry, so an added command or an altered target changes the digest. The pinned
 * template came from npm 11.6.2 (cmd-shim 7.0.0); a different template fails closed.
 */
const JSON_WINDOWS_CMD_SHA256 =
	"84d9ea1c77d128a0925c74c9ea0ae5c55544982c2e7aa12e299c3c0696ed89fd";

// Reject files already larger than these limits before reading them.
const MAX_JSON_MANIFEST_BYTES = 256 * 1024;
const MAX_JSON_ENTRY_BYTES = 4096;
const MAX_JSON_CMD_BYTES = 1024;

function inside(parent: string, child: string): boolean {
	const pathFromParent = relative(parent, child);
	return (
		pathFromParent === "" ||
		(pathFromParent !== ".." &&
			!pathFromParent.startsWith(`..${sep}`) &&
			!isAbsolute(pathFromParent))
	);
}

/** Resolves `join(parent, path)` and requires the canonical result to stay under `parent`. */
async function canonicalWithin(
	parent: string,
	path: string,
): Promise<string | undefined> {
	let canonical: string;
	try {
		canonical = await realpath(join(parent, path));
	} catch {
		return undefined;
	}
	return inside(parent, canonical) ? canonical : undefined;
}

/** Reads a regular file whose reported size fits `maxBytes`; callers check containment. */
async function readBounded(
	path: string,
	maxBytes: number,
): Promise<Buffer | undefined> {
	const status = await stat(path).catch(() => undefined);
	if (!status?.isFile() || status.size > maxBytes) return undefined;
	return readFile(path).catch(() => undefined);
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

interface PackageMetadata {
	name: string;
	version: string;
	bin: Readonly<Record<string, string>>;
}

/** Parses the installed root manifest text; any unexpected shape is refused. */
function parseManifest(text: string): PackageMetadata | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return undefined;
	const { name, version, bin } = parsed as {
		name?: unknown;
		version?: unknown;
		bin?: unknown;
	};
	if (typeof name !== "string" || typeof version !== "string") return undefined;
	if (typeof bin !== "object" || bin === null || Array.isArray(bin))
		return undefined;
	for (const value of Object.values(bin))
		if (typeof value !== "string") return undefined;
	return { name, version, bin: bin as Record<string, string> };
}

/**
 * Closed predicate over the frozen identity fields. A relabelled or edited recipe fails
 * closed instead of reaching the metadata route, and the recipe never comes from project
 * configuration.
 */
export function isApprovedJsonRecipe(recipe: InstallRecipe): boolean {
	if (recipe.kind !== "npm" || recipe.serverId !== JSON_SERVER_ID) return false;
	const pin = recipe.packages[0];
	const approvedPin = APPROVED_JSON_PIN;
	return (
		approvedPin !== undefined &&
		pin !== undefined &&
		recipe.packages.length === 1 &&
		recipe.lockfile === APPROVED_JSON_RECIPE.lockfile &&
		recipe.revision === APPROVED_JSON_RECIPE.revision &&
		recipe.executable === APPROVED_JSON_RECIPE.executable &&
		recipe.expectedVersion === APPROVED_JSON_RECIPE.expectedVersion &&
		recipe.registry === APPROVED_JSON_RECIPE.registry &&
		pin.name === approvedPin.name &&
		pin.version === approvedPin.version &&
		pin.integrity === approvedPin.integrity
	);
}

/**
 * Verifies the pinned JSON entry without starting it. The manifest and the entry must stay
 * under the canonical package root, the manifest must declare the approved name, version and
 * bin path, and the entry must hash to the pinned digest. The launcher stays bound to that
 * entry: on POSIX the resolved `.bin` symlink must be the entry, and on Windows the whole npm
 * `.cmd` shim must hash to the pinned template.
 */
export async function verifyJsonInstallation(
	installationPath: string,
	executablePath: string,
	platform: NodeJS.Platform,
	signal: AbortSignal,
): Promise<InstalledExecutable | undefined> {
	if (signal.aborted) return undefined;
	const approvedPin = APPROVED_JSON_PIN;
	if (!approvedPin) return undefined;
	let root: string;
	try {
		root = await realpath(installationPath);
	} catch {
		return undefined;
	}
	const packageRoot = await canonicalWithin(
		root,
		join("node_modules", approvedPin.name),
	);
	if (!packageRoot) return undefined;
	const manifest = await canonicalWithin(packageRoot, "package.json");
	if (!manifest) return undefined;
	const manifestBytes = await readBounded(manifest, MAX_JSON_MANIFEST_BYTES);
	if (!manifestBytes) return undefined;
	const metadata = parseManifest(manifestBytes.toString("utf8"));
	if (
		!metadata ||
		metadata.name !== approvedPin.name ||
		metadata.version !== approvedPin.version ||
		!Object.hasOwn(metadata.bin, JSON_SERVER_ID) ||
		metadata.bin[JSON_SERVER_ID] !== JSON_BIN_RELATIVE_PATH
	)
		return undefined;
	const entry = await canonicalWithin(packageRoot, JSON_BIN_RELATIVE_PATH);
	if (!entry) return undefined;
	if (platform === "win32") {
		const commandBytes = await readBounded(executablePath, MAX_JSON_CMD_BYTES);
		if (!commandBytes) return undefined;
		const command = commandBytes.toString("utf8").replace(/\r\n/g, "\n");
		if (sha256(Buffer.from(command, "utf8")) !== JSON_WINDOWS_CMD_SHA256)
			return undefined;
	} else if (executablePath !== entry) {
		return undefined;
	}
	const entryBytes = await readBounded(entry, MAX_JSON_ENTRY_BYTES);
	if (!entryBytes || sha256(entryBytes) !== JSON_BIN_SHA256) return undefined;
	if (signal.aborted) return undefined;
	return {
		path: platform === "win32" ? executablePath : entry,
		version: APPROVED_JSON_RECIPE.expectedVersion,
	};
}
