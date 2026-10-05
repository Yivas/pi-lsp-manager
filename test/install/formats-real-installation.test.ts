import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FORMATS_GATE_FLAG,
	FORMATS_INSTALL_HANDOFF_ENV,
	FORMATS_INSTALL_ROOT_ENV,
	FORMATS_SERVER_IDS,
	assertOwnedRoot,
	exportFormatsCliEnvironment,
	type FormatsHandoff,
	type FormatsHandoffServer,
	type FormatsServerId,
	readFormatsGate,
	readFormatsHandoff,
	runFormatsInstallationGate,
} from "../real-servers/formats-installation.js";

// Deterministic guards for the real-format matrix gate plus the opt-in installation entry.
// The guards never start a process or reach the network; the installation only runs when
// the caller sets RUN_REAL_FORMATS_INSTALL=1 with an owned root and a handoff path.

const gate = readFormatsGate(process.env);

const ownedRoots: string[] = [];
async function temporaryRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	ownedRoots.push(root);
	return root;
}
afterEach(async () => {
	for (const root of ownedRoots.splice(0))
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 50,
		});
});

interface RootCase {
	root: string;
	checkout: string;
}
const rootCases: readonly [string, () => Promise<RootCase>][] = [
	[
		"a relative path",
		async () => ({ root: "relative/root", checkout: process.cwd() }),
	],
	[
		"a missing directory",
		async () => ({
			root: join(await temporaryRoot("pi-lsp-formats-missing-"), "absent"),
			checkout: process.cwd(),
		}),
	],
	[
		"a non-empty directory",
		async () => {
			const root = await temporaryRoot("pi-lsp-formats-full-");
			await writeFile(join(root, "keep.txt"), "x", "utf8");
			return { root, checkout: process.cwd() };
		},
	],
	[
		"a directory inside the checkout",
		async () => {
			const checkout = await temporaryRoot("pi-lsp-formats-checkout-");
			const root = join(checkout, "owned");
			await mkdir(root);
			return { root, checkout };
		},
	],
];

async function sha256(text: string): Promise<string> {
	return createHash("sha256").update(text).digest("hex");
}

describe("formats installation gate guards", () => {
	it("stays off and starts no process without the opt-in flag", async () => {
		expect(readFormatsGate({})).toBeUndefined();
		expect(readFormatsGate({ [FORMATS_GATE_FLAG]: "0" })).toBeUndefined();
		let spawns = 0;
		const result = await runFormatsInstallationGate({
			environment: {},
			checkout: process.cwd(),
			spawnProcess: (() => {
				spawns += 1;
				throw new Error("The gate must stay idle while disabled.");
			}) as never,
		});
		expect(result).toBeUndefined();
		expect(spawns).toBe(0);
	});

	it("requires the owned root and the handoff file when enabled", () => {
		expect(() => readFormatsGate({ [FORMATS_GATE_FLAG]: "1" })).toThrow(
			FORMATS_INSTALL_ROOT_ENV,
		);
		expect(() =>
			readFormatsGate({
				[FORMATS_GATE_FLAG]: "1",
				[FORMATS_INSTALL_ROOT_ENV]: "/owned",
			}),
		).toThrow(FORMATS_INSTALL_HANDOFF_ENV);
	});

	it.each(rootCases)(
		"rejects %s as the owned root",
		async (_name, makeCase) => {
			const { root, checkout } = await makeCase();
			await expect(assertOwnedRoot(root, checkout)).rejects.toThrow();
		},
	);

	it("accepts an empty owned directory outside the checkout", async () => {
		const checkout = await temporaryRoot("pi-lsp-formats-checkout-");
		const root = await temporaryRoot("pi-lsp-formats-owned-");
		await expect(assertOwnedRoot(root, checkout)).resolves.toBe(
			await realpath(root),
		);
	});

	it("exports the validated CLI entries and refuses a multi-line value", async () => {
		const envFile = join(await temporaryRoot("pi-lsp-formats-env-"), "env.txt");
		const server = (
			id: FormatsServerId,
			entry: string,
			version: string,
		): FormatsHandoffServer => ({ id, entry, version, sha256: "0".repeat(64) });
		const handoff = (jsonEntry: string): FormatsHandoff => ({
			version: 1,
			root: "/owned",
			servers: [
				server(FORMATS_SERVER_IDS[0], jsonEntry, "4.10.0"),
				server(FORMATS_SERVER_IDS[1], "/owned/yaml-cli", "1.24.0"),
			],
		});
		await exportFormatsCliEnvironment(handoff("/owned/json-cli"), {
			GITHUB_ENV: envFile,
		});
		expect(await readFile(envFile, "utf8")).toBe(
			"JSON_LSP_CLI=/owned/json-cli\nYAML_LSP_CLI=/owned/yaml-cli\n",
		);
		// No CI file: nothing is written anywhere.
		await exportFormatsCliEnvironment(handoff("/owned/json-cli"), {});
		await expect(
			exportFormatsCliEnvironment(handoff("/owned/json\nINJECTED=1"), {
				GITHUB_ENV: envFile,
			}),
		).rejects.toThrow(/single line/);
	});

	describe("handoff reader", () => {
		let parent: string;
		let root: string;
		let altRoot: string;
		let handoffPath: string;
		let servers: {
			id: string;
			entry: string;
			version: string;
			sha256: string;
		}[];

		beforeEach(async () => {
			parent = await temporaryRoot("pi-lsp-formats-handoff-");
			root = join(parent, "owned");
			altRoot = join(parent, "other");
			await mkdir(root);
			await mkdir(altRoot);
			const entry = join(root, "cli.js");
			await writeFile(entry, "console.log('cli');\n", "utf8");
			const digest = await sha256("console.log('cli');\n");
			servers = [
				{ id: FORMATS_SERVER_IDS[0], entry, version: "4.10.0", sha256: digest },
				{ id: FORMATS_SERVER_IDS[1], entry, version: "1.24.0", sha256: digest },
			];
			handoffPath = join(parent, "handoff.json");
		});

		it("accepts a handoff that matches the owned root", async () => {
			await writeFile(
				handoffPath,
				`${JSON.stringify({ version: 1, root, servers })}\n`,
				"utf8",
			);
			await expect(
				readFormatsHandoff(handoffPath, root),
			).resolves.toMatchObject({ version: 1, root: await realpath(root) });
		});

		const cases: readonly [string, () => unknown][] = [
			[
				"a repeated server id",
				() => ({ version: 1, root, servers: [servers[0], servers[0]] }),
			],
			[
				"a version that is not the pinned recipe",
				() => ({
					version: 1,
					root,
					servers: [{ ...servers[0], version: "9.9.9" }, servers[1]],
				}),
			],
			[
				"a CLI hash that does not match",
				() => ({
					version: 1,
					root,
					servers: [{ ...servers[0], sha256: "0".repeat(64) }, servers[1]],
				}),
			],
			[
				"a root that is not the expected root",
				() => ({ version: 1, root: altRoot, servers }),
			],
			["a non-JSON body", () => "not json"],
		];
		it.each(cases)("rejects %s", async (_name, build) => {
			const value = build();
			await writeFile(
				handoffPath,
				typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
				"utf8",
			);
			await expect(readFormatsHandoff(handoffPath, root)).rejects.toThrow();
		});
	});
});

const TEST_TIMEOUT_MS = 720_000;

describe.runIf(gate)("formats real installation gate", () => {
	it(
		"installs both pinned format closures under the owned root and writes the handoff",
		async () => {
			if (!gate) throw new Error("The gate configuration is required.");
			const handoff = await runFormatsInstallationGate({
				environment: process.env,
				checkout: process.cwd(),
			});
			if (!handoff) throw new Error("The enabled gate must produce a handoff.");
			expect(handoff.servers.map((server) => server.id)).toEqual([
				...FORMATS_SERVER_IDS,
			]);
			expect(handoff.servers.map((server) => server.version)).toEqual([
				"4.10.0",
				"1.24.0",
			]);
			await expect(
				readFormatsHandoff(gate.handoff, handoff.root),
			).resolves.toEqual(handoff);
		},
		TEST_TIMEOUT_MS,
	);
});
