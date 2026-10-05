import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFormatsHandoff } from "./formats-installation.js";
import { describe, expect, it } from "vitest";

// Opt-in SDK gate. RUN_REAL_FORMATS_SDK enables this one case; without it the file
// only declares a skipped suite, so the default run creates no directory, imports no
// SDK and starts no child. The previous RUN_REAL_FORMATS flag covers the native
// fixtures alone and never reaches this file.
const runSdk = process.env.RUN_REAL_FORMATS_SDK === "1";
if (runSdk && !process.env.FORMATS_INSTALL_ROOT)
	throw new Error(
		"FORMATS_INSTALL_ROOT is required when RUN_REAL_FORMATS_SDK=1.",
	);

const RUNNER_PATH = fileURLToPath(
	new URL("./formats-pi-sdk-runner.mjs", import.meta.url),
);
// One bounded deadline for the whole child. A timeout fails and preserves the owned
// root; it never stands in for evidence of closure.
const SCENARIO_DEADLINE_MS = 240_000;

type ChildClose = { code: number | null; signal: string | null };

/**
 * Builds the child environment from an explicit allowlist. Only the search path and
 * the two Windows essentials are inherited, and HOME/USERPROFILE point at the owned
 * directory, so no personal path, credential, proxy or npm variable crosses the
 * boundary. The SDK reads its model/auth/settings files from PI_CODING_AGENT_DIR,
 * which is the owned agent directory from the first statement of the child.
 */
function childEnvironment(options: {
	root: string;
	agentDir: string;
	homeDir: string;
	jsonCli: string;
	yamlCli: string;
}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		PI_CODING_AGENT_DIR: options.agentDir,
		FORMATS_SDK_ROOT: options.root,
		JSON_LSP_CLI: options.jsonCli,
		YAML_LSP_CLI: options.yamlCli,
		HOME: options.homeDir,
		USERPROFILE: options.homeDir,
		NODE_DISABLE_COMPILE_CACHE: "1",
	};
	// Windows carries the search path as `Path`; the present spelling is copied as is.
	const searchPath = process.env.PATH ?? process.env.Path;
	if (searchPath) {
		environment.PATH = searchPath;
		if (!process.env.PATH) environment.Path = searchPath;
	}
	for (const name of ["SystemRoot", "ComSpec"]) {
		const value = process.env[name];
		if (value) environment[name] = value;
	}
	return environment;
}

describe.runIf(runSdk)("Pi SDK format integration", () => {
	it("drives JSON and YAML diagnostics through the real extension on a synthetic preloaded session", async () => {
		const installRoot = process.env.FORMATS_INSTALL_ROOT;
		if (!installRoot) throw new Error("Missing FORMATS_INSTALL_ROOT.");
		// The handoff is read as data through the validated reader: canonical root,
		// known pins and matching SHA-256, never a hand-parsed copy.
		const handoff = await readFormatsHandoff(
			join(installRoot, "handoff.json"),
			installRoot,
		);
		const jsonServer = handoff.servers.find(
			(server) => server.id === "vscode-json-language-server",
		);
		const yamlServer = handoff.servers.find(
			(server) => server.id === "yaml-language-server",
		);
		if (!jsonServer || !yamlServer)
			throw new Error("The formats handoff does not list both servers.");

		// The owned root lives outside the checkout and is the only thing this case
		// removes; its canonical form is what the child asserts against getAgentDir().
		const created = await mkdtemp(join(tmpdir(), "pi-lsp-formats-sdk-"));
		const owned = await realpath(created);
		const childRoot = join(owned, "sdk");
		const agentDir = join(childRoot, "agent");
		const homeDir = join(childRoot, "home");
		const workspace = join(childRoot, "workspace");
		await mkdir(agentDir, { recursive: true });
		await mkdir(homeDir, { recursive: true });
		await mkdir(workspace, { recursive: true });

		const child = spawn(process.execPath, [RUNNER_PATH], {
			cwd: childRoot,
			env: childEnvironment({
				root: childRoot,
				agentDir,
				homeDir,
				jsonCli: jsonServer.entry,
				yamlCli: yamlServer.entry,
			}),
			stdio: "ignore",
			windowsHide: true,
		});

		let succeeded = false;
		let childFailure: Error | undefined;
		child.once("error", (error) => {
			// Recorded before the close wait so a spawn failure becomes a named guard
			// instead of an unhandled event; its raw message is never surfaced.
			childFailure = error;
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const closed = new Promise<ChildClose>((settle) => {
				child.once("close", (code, signal) => settle({ code, signal }));
			});
			let outcome: ChildClose | "timeout";
			try {
				outcome = await Promise.race([
					closed,
					new Promise<"timeout">((settle) => {
						timer = setTimeout(() => settle("timeout"), SCENARIO_DEADLINE_MS);
					}),
				]);
			} finally {
				// The deadline is cleared on every path that leaves the race.
				if (timer) clearTimeout(timer);
			}
			if (outcome === "timeout") {
				// Only the owned child handle is killed; no tree or global cleanup runs.
				child.kill("SIGKILL");
				await closed;
				throw new Error(
					"The SDK scenario timed out; preserving the owned root.",
				);
			}
			if (childFailure)
				throw new Error("The SDK scenario child process reported an error.");
			expect(outcome.signal).toBe(null);
			expect(outcome.code).toBe(0);

			// The child already bounds its sidecar; reject an over-long buffer before
			// parsing instead of failing inside JSON.parse.
			const resultBytes = await readFile(join(childRoot, "result.json"));
			if (resultBytes.byteLength > 8_192)
				throw new Error(
					"The SDK scenario result exceeds the bounded metadata size.",
				);
			const result = JSON.parse(resultBytes.toString("utf8"));
			expect(result.ok).toBe(true);
			expect(result.tools).toBe(10);
			expect(result.lspCommand).toBe(true);
			expect(result.agentDirOwned).toBe(true);
			expect(result.trusted).toBe(true);
			expect(result.json).toMatchObject({
				invalid: { line: 3, character: 10 },
				clean: true,
				cancelled: "cancelled",
				withheldAtCancel: true,
				replacementInvalid: { line: 3, character: 10 },
				replacementClean: true,
			});
			expect(result.yaml).toMatchObject({
				invalid: { line: 1, character: 6 },
				clean: true,
			});
			expect(result.evictedBeforeReplacement).toBe(true);
			expect(result.liveBeforeShutdown).toBe(2);
			expect(result.spawns).toMatchObject({
				json: 2,
				yaml: 1,
				unexpected: 0,
			});
			// Closure is proved by the child after the real runtime shutdown; the root
			// is only removed once the SDK child has closed and this record is true.
			expect(result.allChildrenClosed).toBe(true);
			expect(result.httpClosed).toBe(true);
			succeeded = true;
		} finally {
			if (succeeded)
				await rm(owned, {
					recursive: true,
					force: true,
					maxRetries: 10,
					retryDelay: 50,
				});
		}
	}, 300_000);
});
