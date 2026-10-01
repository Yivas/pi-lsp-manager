import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertGateClaim,
	claimGateRoot,
	type GateHandoffServer,
	type GateManifest,
	gateOwnerBytes,
	type GateOwner,
	type GateOwnerRecord,
	inspectGateRoot,
	openGateRoot,
	ownGateOutput,
	parseGateManifest,
	parseGateOwnerRecord,
	requireGateEnvironment,
	resetGateScope,
	writeGateManifest,
} from "./python-install-gate-ownership.js";

// Deterministic negative coverage for the gate ownership seam. It never runs pip and never
// touches the opt-in gate: each case uses its own scratch root and proves that a foreign,
// non-empty, tampered or refused root is left byte-identical and never claimed.

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const scratchRoots: string[] = [];

async function scratch(prefix = "python-gate-ownership-"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	scratchRoots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of scratchRoots.splice(0))
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 50,
		});
});

function owner(): GateOwner {
	return {
		pid: process.pid,
		user: process.env.USERNAME ?? process.env.USER ?? "unknown",
		createdAt: new Date().toISOString(),
	};
}

/** A stable digest of a whole tree, so an untouched foreign root compares byte-for-byte. */
async function treeDigest(root: string): Promise<string> {
	const hash = createHash("sha256");
	const walk = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true }).catch(
			() => [],
		);
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const path = join(directory, entry.name);
			hash.update(relative(root, path));
			if (entry.isDirectory()) {
				hash.update("/dir");
				await walk(path);
			} else {
				hash.update("/file");
				hash.update(await readFile(path));
			}
		}
	};
	await walk(root);
	return hash.digest("hex");
}

function canCreateDirectorySymlink(): boolean {
	try {
		const parent = mkdtempSync(join(tmpdir(), "python-gate-symlink-"));
		try {
			symlinkSync(
				CHECKOUT,
				join(parent, "link"),
				process.platform === "win32" ? "junction" : "dir",
			);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
		return true;
	} catch {
		return false;
	}
}

const symlinkSupported = canCreateDirectorySymlink();

function readyServer(id: "ty" | "ruff", root: string): GateHandoffServer {
	const revision = `${id}-0.0.1_pip-target_lock-1`;
	return {
		serverId: id,
		revision,
		executable: {
			path: join(
				root,
				id,
				"managed",
				"servers",
				id,
				revision,
				"bin",
				process.platform === "win32" ? `${id}.exe` : id,
			),
			version: "0.0.1",
			sha256: "a".repeat(64),
		},
		requirementsSha256: "b".repeat(64),
		wheel: { fileName: `${id}-0.0.1-py3-none-any.whl`, sha256: "c".repeat(64) },
		nativeOutput: `${id} 0.0.1`,
		phase: "ready",
	};
}

function completeManifest(
	claim: { root: string; marker: string; record: GateOwnerRecord },
	overrides: Partial<GateManifest> = {},
): GateManifest {
	return {
		gate: "python-install-gate",
		formatVersion: 1,
		status: "complete",
		createdAt: new Date().toISOString(),
		root: claim.root,
		marker: claim.marker,
		owner: claim.record.owner,
		token: claim.record.token,
		nonce: claim.record.nonce,
		interpreter: {
			path: join(tmpdir(), "python"),
			pythonVersion: "0.0.0",
			pipVersion: "0.0.0",
			provenance: "test",
		},
		platform: process.platform,
		architecture: process.arch,
		checkout: CHECKOUT,
		cases: {
			inactivePolicy: true,
			cancel: true,
			rollback: true,
			ty: true,
			ruff: true,
		},
		servers: {
			ty: readyServer("ty", claim.root),
			ruff: readyServer("ruff", claim.root),
		},
		retention: "read-only",
		ciBaseline: "test",
		...overrides,
	};
}

describe("Python installation gate ownership", () => {
	it("refuses a missing root inside the checkout before creating it", async () => {
		const rawRoot = join(
			CHECKOUT,
			`python-install-gate-refused-${randomUUID()}`,
		);
		await expect(
			inspectGateRoot({ rawRoot, checkout: CHECKOUT }),
		).rejects.toThrow(/outside the checkout/);
		await expect(access(rawRoot)).rejects.toThrow();
	});

	it("refuses a non-empty root and leaves the foreign tree byte-identical", async () => {
		const root = await scratch();
		await mkdir(join(root, "foreign"), { recursive: true });
		await writeFile(join(root, "foreign", "keep.txt"), "keep\n", "utf8");
		const before = await treeDigest(root);
		await expect(
			inspectGateRoot({ rawRoot: root, checkout: CHECKOUT }),
		).rejects.toThrow(/must be empty/);
		expect(await treeDigest(root)).toBe(before);
		await expect(
			access(join(root, ".python-install-gate-owner.json")),
		).rejects.toThrow();
	});

	it("refuses an untrusted interpreter before writing any marker or directory", async () => {
		const parent = await scratch();
		const rawRoot = join(parent, "gate");
		await expect(
			openGateRoot({
				rawRoot,
				checkout: CHECKOUT,
				owner: owner(),
				trust: async () => ({ ok: false, reason: "unsafe" }),
			}),
		).rejects.toThrow(/refused before the gate root was claimed/);
		await expect(access(rawRoot)).rejects.toThrow();
		expect(await readdir(parent)).toEqual([]);
	});

	it("fails closed on a missing handoff variable without creating the root", async () => {
		const parent = await scratch();
		const rawRoot = join(parent, "gate");
		expect(() =>
			requireGateEnvironment("PYTHON_INSTALL_GATE_ROOT", undefined),
		).toThrow(/is required when RUN_REAL_PYTHON_INSTALL=1/);
		expect(() =>
			requireGateEnvironment("PYTHON_GATE_INTERPRETER", "  "),
		).toThrow(/is required/);
		await expect(access(rawRoot)).rejects.toThrow();
		expect(await readdir(parent)).toEqual([]);
	});

	it("claims an empty caller-owned root and resets only the named scope", async () => {
		const root = await scratch();
		const inspected = await inspectGateRoot({
			rawRoot: root,
			checkout: CHECKOUT,
		});
		expect(inspected.existed).toBe(true);
		const claim = await claimGateRoot({ inspected, owner: owner() });
		const onDisk = parseGateOwnerRecord(await readFile(claim.marker, "utf8"));
		expect(onDisk.root).toBe(await realpath(root));
		expect(onDisk.token).toBe(claim.record.token);
		expect(onDisk.nonce).toBe(claim.record.nonce);
		await writeFile(join(root, "sentinel.txt"), "keep\n", "utf8");
		const managed = await resetGateScope(claim, "ty");
		expect(
			await readFile(join(managed, "..", "..", "sentinel.txt"), "utf8"),
		).toBe("keep\n");
		expect((await readdir(root)).sort()).toEqual(
			[".python-install-gate-owner.json", "sentinel.txt", "ty"].sort(),
		);
		await assertGateClaim(claim);
	});

	it("refuses to reset when the marker was replaced", async () => {
		const root = await scratch();
		const claim = await claimGateRoot({
			inspected: await inspectGateRoot({ rawRoot: root, checkout: CHECKOUT }),
			owner: owner(),
		});
		await mkdir(join(root, "cancel"), { recursive: true });
		await writeFile(join(root, "cancel", "sentinel.txt"), "keep\n", "utf8");
		const replaced: GateOwnerRecord = {
			...claim.record,
			token: randomUUID(),
			nonce: randomUUID(),
		};
		await writeFile(claim.marker, gateOwnerBytes(replaced), "utf8");
		await expect(resetGateScope(claim, "cancel")).rejects.toThrow(
			/marker changed/,
		);
		expect(await readFile(join(root, "cancel", "sentinel.txt"), "utf8")).toBe(
			"keep\n",
		);
	});

	it("refuses a marker that names another root", async () => {
		const root = await scratch();
		const claim = await claimGateRoot({
			inspected: await inspectGateRoot({ rawRoot: root, checkout: CHECKOUT }),
			owner: owner(),
		});
		const foreign: GateOwnerRecord = {
			...claim.record,
			token: randomUUID(),
			nonce: randomUUID(),
			root: join(root, "other"),
		};
		await writeFile(claim.marker, gateOwnerBytes(foreign), "utf8");
		await expect(resetGateScope(claim, "ruff")).rejects.toThrow(
			/refusing to mutate another writer's root/,
		);
	});

	it("refuses a second exclusive claim on the same root", async () => {
		const root = await scratch();
		const inspected = await inspectGateRoot({
			rawRoot: root,
			checkout: CHECKOUT,
		});
		const first = await claimGateRoot({ inspected, owner: owner() });
		await expect(claimGateRoot({ inspected, owner: owner() })).rejects.toThrow(
			/already carries an owner marker/,
		);
		expect(await readFile(first.marker, "utf8")).toBe(first.markerBytes);
	});

	it.skipIf(!symlinkSupported)(
		"refuses a root that is a symlink into the checkout before creating anything",
		async () => {
			const parent = await scratch();
			const link = join(parent, "link");
			await symlink(
				CHECKOUT,
				link,
				process.platform === "win32" ? "junction" : "dir",
			);
			await expect(
				inspectGateRoot({ rawRoot: link, checkout: CHECKOUT }),
			).rejects.toThrow(/outside the checkout/);
		},
	);

	it("refuses an output that escapes the owned root", async () => {
		const root = await scratch();
		const elsewhere = await scratch();
		expect(() => ownGateOutput(root, join(elsewhere, "handoff.json"))).toThrow(
			/inside the owned gate root/,
		);
		expect(() => ownGateOutput(root, root)).toThrow(
			/inside the owned gate root/,
		);
		expect(() => ownGateOutput(root, "relative/handoff.json")).toThrow(
			/absolute path/,
		);
		// `ownGateOutput` compares lexically, so the caller must pass the canonical root a
		// claim carries: a raw `tmpdir()` path is the 8.3 short name on Windows and `/var`
		// on macOS, where no join can equal the canonical path.
		const canonical = await realpath(root);
		expect(ownGateOutput(canonical, join(canonical, "handoff.json"))).toBe(
			join(canonical, "handoff.json"),
		);
	});

	it("rejects a partial, failed or out-of-root manifest", async () => {
		const root = await scratch();
		const claim = await claimGateRoot({
			inspected: await inspectGateRoot({ rawRoot: root, checkout: CHECKOUT }),
			owner: owner(),
		});
		const manifest = completeManifest(claim);
		// The claim root is canonical, so the owned output is the one joined to `claim.root`;
		// a raw `tmpdir()` root is its alias and would be refused as an escape.
		await writeGateManifest(claim, join(claim.root, "handoff.json"), manifest);
		const text = await readFile(join(claim.root, "handoff.json"), "utf8");
		expect(
			parseGateManifest(text, {
				root: claim.root,
				versions: { ty: "0.0.1", ruff: "0.0.1" },
			}).status,
		).toBe("complete");

		const partial = completeManifest(claim, {
			servers: { ty: readyServer("ty", claim.root) },
		});
		expect(() => parseGateManifest(JSON.stringify(partial))).toThrow(
			/missing the ready ruff/,
		);

		const failed = completeManifest(claim, { status: "failed" });
		expect(() => parseGateManifest(JSON.stringify(failed))).toThrow(
			/not complete/,
		);

		const wrongVersion = completeManifest(claim);
		const tyServer = wrongVersion.servers.ty;
		if (!tyServer) throw new Error("The fixture must carry a ty server.");
		tyServer.executable.version = "9.9.9";
		expect(() =>
			parseGateManifest(JSON.stringify(wrongVersion), {
				versions: { ty: "0.0.1" },
			}),
		).toThrow(/unexpected version/);

		const escaped = completeManifest(claim);
		const escapedRuff = escaped.servers.ruff;
		if (!escapedRuff) throw new Error("The fixture must carry a ruff server.");
		escapedRuff.executable.path = join(tmpdir(), "escaped");
		expect(() => parseGateManifest(JSON.stringify(escaped))).toThrow(
			/escapes the owned gate root/,
		);
	});

	it("refuses to write the manifest outside the verified root", async () => {
		const root = await scratch();
		const elsewhere = await scratch();
		const claim = await claimGateRoot({
			inspected: await inspectGateRoot({ rawRoot: root, checkout: CHECKOUT }),
			owner: owner(),
		});
		const manifest = completeManifest(claim);
		await expect(
			writeGateManifest(claim, join(elsewhere, "handoff.json"), manifest),
		).rejects.toThrow(/inside the owned gate root/);
		expect(await readdir(elsewhere)).toEqual([]);
	});
});
