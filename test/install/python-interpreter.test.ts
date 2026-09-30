import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type PythonInterpreterFileSystem,
	resolveTrustedPythonInterpreter,
} from "../../src/install/adapters/python.js";

const WORKSPACE = "/work/project";
const CWD = "/work/project";

interface FakeOptions {
	files: readonly string[];
	realpaths?: Record<string, string>;
	/** Paths whose execute bit is refused; every other regular file is executable. */
	nonExecutable?: readonly string[];
	/** Records every execute-bit probe so a platform can prove it never consults it. */
	accessLog?: string[];
}

function fakeFileSystem(options: FakeOptions): PythonInterpreterFileSystem {
	const regular = new Set(options.files);
	const nonExecutable = new Set(options.nonExecutable ?? []);
	return {
		realpath: async (path) => {
			const resolved = options.realpaths?.[path];
			if (resolved) return resolved;
			if (regular.has(path)) return path;
			throw new Error("ENOENT");
		},
		lstat: async (path) => {
			if (regular.has(path)) return { isFile: () => true };
			throw new Error("ENOENT");
		},
		stat: async (path) => {
			if (regular.has(path)) return { isFile: () => true };
			throw new Error("ENOENT");
		},
		access: async (path) => {
			options.accessLog?.push(path);
			if (nonExecutable.has(path)) throw new Error("EACCES");
		},
	};
}

function resolve(
	configured: string | undefined,
	options: FakeOptions,
	platform: NodeJS.Platform = "linux",
): ReturnType<typeof resolveTrustedPythonInterpreter> {
	return resolveTrustedPythonInterpreter(configured, {
		workspacePath: WORKSPACE,
		cwd: CWD,
		platform,
		fileSystem: fakeFileSystem(options),
	});
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true, maxRetries: 10 });
	}
});

describe("trusted installer interpreter", () => {
	it("reports a missing key as the manual fallback", async () => {
		for (const value of [undefined, "", "   "]) {
			expect(await resolve(value, { files: [] })).toEqual({
				ok: false,
				reason: "missing",
			});
		}
	});

	it.each([
		["relative path", "python3"],
		["drive-relative path", "C:python.exe"],
		["parent escape", "C:/tools/../project/python.exe"],
		["posix parent escape", "/work/project/../project/.venv/bin/python3"],
		["shell syntax", "/tools/python&calc.exe"],
		["quoted path", '/tools/"python.exe"'],
		["py launcher", "C:/Windows/py.exe"],
		["cmd shim", "C:/tools/python.cmd"],
	])("refuses the %s before any process exists", async (_label, configured) => {
		expect(
			await resolve(configured, { files: [configured.replace("\\", "/")] }),
		).toEqual({
			ok: false,
			reason: "unsafe",
		});
	});

	it("refuses a missing target, a directory and a virtual environment", async () => {
		expect(await resolve("/tools/missing/python3", { files: [] })).toEqual({
			ok: false,
			reason: "unsafe",
		});
		expect(await resolve("/tools/directory/python3", { files: [] })).toEqual({
			ok: false,
			reason: "unsafe",
		});
		const venv = join("/work", "venv", "bin", "python3");
		expect(
			await resolve(venv, {
				files: [venv, join("/work", "venv", "pyvenv.cfg")],
			}),
		).toEqual({ ok: false, reason: "unsafe" });
	});

	it("refuses an interpreter inside the workspace or the working directory", async () => {
		const insideWorkspace = join(WORKSPACE, ".venv", "bin", "python3");
		expect(
			await resolve(insideWorkspace, { files: [insideWorkspace] }),
		).toEqual({ ok: false, reason: "unsafe" });
		const insideCwd = "/work/project/tools/python3";
		expect(await resolve(insideCwd, { files: [insideCwd] })).toEqual({
			ok: false,
			reason: "unsafe",
		});
	});

	it("refuses a non-executable POSIX interpreter before any process exists", async () => {
		expect(
			await resolve("/tools/python3", {
				files: ["/tools/python3"],
				nonExecutable: ["/tools/python3"],
			}),
		).toEqual({ ok: false, reason: "unsafe" });
	});

	it("does not consult the execute bit on Windows", async () => {
		const accessLog: string[] = [];
		const configured = "C:/Tools/Python312/python.exe";
		const resolution = await resolveTrustedPythonInterpreter(configured, {
			workspacePath: WORKSPACE,
			cwd: CWD,
			platform: "win32",
			fileSystem: fakeFileSystem({
				files: [configured],
				nonExecutable: [configured],
				accessLog,
			}),
		});
		expect(resolution).toEqual({ ok: true, path: configured });
		expect(accessLog).toEqual([]);
	});

	it("refuses a symlink whose real target lands inside the workspace", async () => {
		const configured = join("/tools", "python3");
		const insideWorkspace = join(
			"/work",
			"project",
			".venv",
			"bin",
			"python3.12",
		);
		expect(
			await resolve(configured, {
				files: [insideWorkspace],
				realpaths: { [configured]: insideWorkspace },
			}),
		).toEqual({ ok: false, reason: "unsafe" });
	});

	it("does not disqualify a global interpreter for a pyvenv.cfg far above it", async () => {
		const interpreter = join("/opt", "python", "bin", "python3");
		// `/opt/pyvenv.cfg` sits two directories above the interpreter directory, so it is
		// never a virtual environment root for that interpreter.
		expect(
			await resolve(interpreter, {
				files: [interpreter, join("/opt", "pyvenv.cfg")],
			}),
		).toEqual({ ok: true, path: interpreter });
	});

	it("rejects a virtual environment marker at the interpreter directory or its parent", async () => {
		const interpreter = join("/work", "venv", "bin", "python3");
		for (const marker of [
			join("/work", "venv", "bin", "pyvenv.cfg"),
			join("/work", "venv", "pyvenv.cfg"),
		])
			expect(
				await resolve(interpreter, { files: [interpreter, marker] }),
				marker,
			).toEqual({ ok: false, reason: "unsafe" });
	});

	it("accepts a canonical system symlink whose real target is a global regular file", async () => {
		expect(
			await resolve("/usr/bin/python3", {
				files: ["/usr/bin/python3.12"],
				realpaths: { "/usr/bin/python3": "/usr/bin/python3.12" },
			}),
		).toEqual({ ok: true, path: "/usr/bin/python3.12" });
	});

	it.skipIf(process.platform === "win32")(
		"resolves a real POSIX symlink to its target",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-lsp-python-interpreter-"));
			temporaryDirectories.push(root);
			const target = join(root, "python3.12");
			// The trust layer probes `X_OK` on POSIX, so the real target must carry an
			// execute bit or the resolution is refused as unsafe.
			await writeFile(target, "", { encoding: "utf8", mode: 0o755 });
			await mkdir(join(root, "bin"), { recursive: true });
			const link = join(root, "bin", "python3");
			await symlink(target, link);
			const resolution = await resolveTrustedPythonInterpreter(link, {
				workspacePath: join(root, "workspace"),
				cwd: join(root, "workspace"),
				platform: "linux",
			});
			expect(resolution).toEqual({ ok: true, path: await realpath(target) });
		},
	);
});
