import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Regression oracles for the raw write error that `vscode-jsonrpc@9.0.2` rethrows from the
 * unobserved `async` executor of `sendRequest` after already reporting the failure to the caller.
 *
 * Every scenario runs in its own subprocess started with `--unhandled-rejections=strict`, so an
 * orphan rejection is a non-zero exit instead of a warning a harness could swallow. The fixture
 * prints one marker per observation, and these tests assert the markers together with the exit code:
 * a subprocess that aborts before the deferred write is dispatched fails the expectation on the
 * missing marker rather than passing on an early exit.
 */

const root = process.cwd();
const cache = join(
	root,
	"node_modules",
	".cache",
	"pi-lsp-manager",
	"request-write-failure",
);
const compiledFixture = join(
	cache,
	"out",
	"test",
	"fixtures",
	"protocol",
	"request-write-failure.js",
);

interface ScenarioRun {
	code: number | null;
	markers: Map<string, string>;
	log: string;
}

/** Node cannot strip the `./x.js` specifiers this repository uses, so the fixture is compiled. */
function compileFixture(): void {
	rmSync(cache, { recursive: true, force: true });
	mkdirSync(join(cache, "out"), { recursive: true });
	const compiled = spawnSync(
		process.execPath,
		[
			join(root, "node_modules", "typescript", "bin", "tsc"),
			"test/fixtures/protocol/request-write-failure.ts",
			"src/protocol/connection.ts",
			"--outDir",
			join(cache, "out"),
			"--rootDir",
			root,
			"--module",
			"nodenext",
			"--moduleResolution",
			"nodenext",
			"--target",
			"es2024",
			"--strict",
			"--skipLibCheck",
		],
		// ~1.3 s here; the bound makes a hung compiler the failing assertion instead of the hook timeout.
		{ cwd: root, encoding: "utf8", timeout: 60_000 },
	);
	if (compiled.error || compiled.signal !== null || compiled.status !== 0) {
		const reason =
			compiled.error?.message ??
			(compiled.signal !== null
				? `killed by ${compiled.signal}`
				: `exit status ${compiled.status}`);
		throw new Error(
			`fixture compilation failed (${reason}):\n${compiled.stdout}${compiled.stderr}`,
		);
	}
	writeFileSync(join(cache, "out", "package.json"), '{"type":"module"}\n');
}

function scenario(name: string): ScenarioRun {
	const result = spawnSync(
		process.execPath,
		["--unhandled-rejections=strict", compiledFixture, name],
		{ cwd: root, encoding: "utf8", timeout: 60_000 },
	);
	const stdout = result.stdout ?? "";
	const markers = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("MARK ")) continue;
		const separator = line.indexOf("=", 5);
		if (separator === -1) markers.set(line.slice(5), "");
		else markers.set(line.slice(5, separator), line.slice(separator + 1));
	}
	return {
		code: result.status,
		markers,
		log: `${stdout}${result.stderr ?? ""}`,
	};
}

function markerJson(run: ScenarioRun, key: string): unknown {
	return JSON.parse(run.markers.get(key) ?? "null");
}

const jsonrpcDependency = (
	JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		dependencies: Record<string, string>;
	}
).dependencies["vscode-jsonrpc"];

describe("request write failure", () => {
	beforeAll(compileFixture, 120_000);
	afterAll(() => rmSync(cache, { recursive: true, force: true }));

	it("settles a disposed in-flight request before its deferred write fails", () => {
		const run = scenario("dispose");
		expect(run.code, run.log).toBe(0);
		expect(run.markers.get("request"), run.log).toBe(
			'{"ok":false,"code":"closed"}',
		);
		// The accepted write reached the pipe and was rejected there: without this marker an early
		// exit would look identical to a healthy run.
		expect(run.markers.get("write-failure"), run.log).toBe(
			"ERR_STREAM_DESTROYED",
		);
		expect(run.markers.get("writes-failed"), run.log).toBe("1");
		expect(run.markers.get("exit"), run.log).toBe("clean");
	}, 30_000);

	it("fails closed when an accepted write breaks without a caller abort", () => {
		const run = scenario("unexpected");
		expect(run.code, run.log).toBe(0);
		expect(run.markers.get("request"), run.log).toBe(
			'{"ok":false,"code":"closed"}',
		);
		expect(run.markers.get("write-failure"), run.log).toBe(
			"ERR_STREAM_DESTROYED",
		);
		expect(run.markers.get("reuse"), run.log).toBe(
			'{"ok":false,"code":"closed"}',
		);
		// The peer is really gone before the last request: the connection must not recover.
		expect(run.markers.get("peer-exit"), run.log).toBe("confirmed");
		expect(run.markers.get("after-eof"), run.log).toBe(
			'{"ok":false,"code":"closed"}',
		);
		expect(run.markers.get("exit"), run.log).toBe("clean");
	}, 30_000);

	it("answers a healthy request from the resolved root jsonrpc package", () => {
		const run = scenario("healthy");
		expect(run.code, run.log).toBe(0);
		expect(markerJson(run, "request"), run.log).toEqual({
			ok: true,
			value: { capabilities: { definitionProvider: true } },
		});
		expect(run.markers.get("notify"), run.log).toBe("resolved");
		// The counted notification proves the peer answered the same connection the fault cases use.
		expect(markerJson(run, "probe"), run.log).toEqual({
			ok: true,
			value: { value: "peer-value", initialized: 1 },
		});
		expect(run.markers.get("writes-failed"), run.log).toBe("0");
		expect(run.markers.get("resolved-jsonrpc"), run.log).toBe(
			jsonrpcDependency,
		);
		expect(run.markers.get("exit"), run.log).toBe("clean");
	}, 30_000);
});
