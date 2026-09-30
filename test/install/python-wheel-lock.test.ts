import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// The frozen lock is validated while the catalog module initialises, so the negative
// cases inject mutated metadata through the module graph instead of exporting a new seam.
const LOCK_SPECIFIER = "../../src/install/locks/python-wheels.json";
const LOCK_FILE = fileURLToPath(new URL(LOCK_SPECIFIER, import.meta.url));

interface RawWheel {
	platform: string;
	architecture: string;
	url: string;
	sha256: string;
}

interface RawLock {
	revision: string;
	servers: Record<"ty" | "ruff", RawWheel[]>;
}

async function rawLock(): Promise<RawLock> {
	return JSON.parse(await readFile(LOCK_FILE, "utf8")) as RawLock;
}

async function mutate(mutate: (wheel: RawWheel) => void): Promise<RawLock> {
	const lock = await rawLock();
	const wheel = lock.servers.ty[0];
	if (!wheel) throw new Error("The committed lock has no Windows ty wheel.");
	mutate(wheel);
	return lock;
}

async function importCatalogWith(lock: unknown): Promise<unknown> {
	vi.resetModules();
	vi.doMock(LOCK_SPECIFIER, () => ({ default: lock }));
	return import("../../src/install/catalog.js");
}

describe("frozen Python wheel lock validation", () => {
	it("accepts the committed lock unchanged", async () => {
		const catalog = (await importCatalogWith(await rawLock())) as {
			INACTIVE_PYTHON_RECIPES: unknown;
		};
		expect(catalog.INACTIVE_PYTHON_RECIPES).toBeDefined();
	});

	it.each([
		[
			"a percent-encoded traversal segment",
			(wheel: RawWheel) => {
				wheel.url =
					"https://files.pythonhosted.org/packages/%2e%2e/x/ty-0.0.84-py3-none-win_amd64.whl";
			},
		],
		[
			"an uppercase percent-encoded traversal segment",
			(wheel: RawWheel) => {
				wheel.url =
					"https://files.pythonhosted.org/packages/%2E%2E/x/ty-0.0.84-py3-none-win_amd64.whl";
			},
		],
		[
			"a percent-encoded single dot segment",
			(wheel: RawWheel) => {
				wheel.url =
					"https://files.pythonhosted.org/packages/%2e/ty-0.0.84-py3-none-win_amd64.whl";
			},
		],
		[
			"a raw backslash the URL parser would fold into a separator",
			(wheel: RawWheel) => {
				wheel.url =
					"https://files.pythonhosted.org/packages/x\\ty-0.0.84-py3-none-win_amd64.whl";
			},
		],
		[
			"a doubly percent-encoded traversal segment",
			(wheel: RawWheel) => {
				wheel.url =
					"https://files.pythonhosted.org/packages/%252e%252e/x/ty-0.0.84-py3-none-win_amd64.whl";
			},
		],
		[
			"a percent-encoded separator",
			(wheel: RawWheel) => {
				wheel.url =
					"https://files.pythonhosted.org/packages/%2f/ty-0.0.84-py3-none-win_amd64.whl";
			},
		],
		[
			"a percent-encoded NUL",
			(wheel: RawWheel) => {
				wheel.url =
					"https://files.pythonhosted.org/packages/%00/ty-0.0.84-py3-none-win_amd64.whl";
			},
		],
		[
			"a doubled slash in the path",
			(wheel: RawWheel) => {
				wheel.url =
					"https://files.pythonhosted.org/packages//ty-0.0.84-py3-none-win_amd64.whl";
			},
		],
		[
			"a non-canonical host",
			(wheel: RawWheel) => {
				wheel.url =
					"https://files.pythonhosted.org.evil.invalid/packages/x/ty-0.0.84-py3-none-win_amd64.whl";
			},
		],
		[
			"embedded credentials",
			(wheel: RawWheel) => {
				wheel.url =
					"https://user:pass@files.pythonhosted.org/packages/x/ty-0.0.84-py3-none-win_amd64.whl";
			},
		],
		[
			"a query string",
			(wheel: RawWheel) => {
				wheel.url =
					"https://files.pythonhosted.org/packages/x/ty-0.0.84-py3-none-win_amd64.whl?x=1";
			},
		],
		[
			"a fragment",
			(wheel: RawWheel) => {
				wheel.url =
					"https://files.pythonhosted.org/packages/x/ty-0.0.84-py3-none-win_amd64.whl#sha256=00";
			},
		],
		[
			"a truncated digest",
			(wheel: RawWheel) => {
				wheel.sha256 = wheel.sha256.slice(0, 32);
			},
		],
		[
			"an uppercase digest",
			(wheel: RawWheel) => {
				wheel.sha256 = wheel.sha256.toUpperCase();
			},
		],
		[
			"a non-wheel suffix",
			(wheel: RawWheel) => {
				wheel.url =
					"https://files.pythonhosted.org/packages/x/ty-0.0.84-py3-none-win_amd64.tar.gz";
			},
		],
	] as const)("rejects %s", async (_label, mutateWheel) => {
		await expect(
			importCatalogWith(await mutate(mutateWheel)),
		).rejects.toThrow();
	});
});
