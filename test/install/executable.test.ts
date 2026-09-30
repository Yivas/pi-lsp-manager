import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	resolveExecutable,
	type ExecutableFileSystem,
} from "../../src/install/executable.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-lsp-manager-executable-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(async () => {
	for (const path of temporaryDirectories.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
});

type FakeEntry =
	| { kind: "file" | "directory" }
	| { kind: "symbolic-link"; target: string };

const regularFile: FakeEntry = { kind: "file" };
const directory: FakeEntry = { kind: "directory" };

function linkTo(target: string): FakeEntry {
	return { kind: "symbolic-link", target };
}

// Models the two stat flavors the resolver relies on: `lstat` describes the entry
// itself and `stat` follows a link chain, reporting ELOOP on a loop.
function fileSystem(
	entries: Readonly<Record<string, FakeEntry>>,
	executable = true,
): ExecutableFileSystem {
	const read = (path: string): FakeEntry => {
		const key = Object.keys(entries).find(
			(candidate) => candidate.toLowerCase() === path.toLowerCase(),
		);
		const entry = key === undefined ? undefined : entries[key];
		if (!entry) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		return entry;
	};
	const follow = (path: string, seen: readonly string[]): FakeEntry => {
		const entry = read(path);
		if (entry.kind !== "symbolic-link") return entry;
		if (seen.includes(path.toLowerCase()))
			throw Object.assign(new Error("loop"), { code: "ELOOP" });
		return follow(entry.target, [...seen, path.toLowerCase()]);
	};
	return {
		async lstat(path) {
			return { isFile: () => read(path).kind === "file" };
		},
		async stat(path) {
			return { isFile: () => follow(path, []).kind === "file" };
		},
		async access() {
			if (!executable)
				throw Object.assign(new Error("not executable"), { code: "EACCES" });
		},
	};
}

describe("executable resolution", () => {
	it("requires executable permission on Unix", async () => {
		const fs = fileSystem(
			{ "/bin/typescript-language-server": regularFile },
			false,
		);
		expect(
			await resolveExecutable(
				"typescript-language-server",
				{ PATH: "/bin" },
				"linux",
				fs,
			),
		).toBeUndefined();
	});

	it("uses Unix PATH for regular executable files", async () => {
		const fs = fileSystem({ "/bin/typescript-language-server": regularFile });
		expect(
			await resolveExecutable(
				"typescript-language-server",
				{ PATH: "/bin" },
				"linux",
				fs,
			),
		).toBe("/bin/typescript-language-server");
	});

	it("follows a Unix link to a regular executable file", async () => {
		// The official Node install and every `node_modules/.bin` shim are links, so
		// the resolver has to read the target instead of the entry itself.
		const fs = fileSystem({
			"/usr/bin/npm": linkTo("/usr/lib/node_modules/npm/bin/npm-cli.js"),
			"/usr/lib/node_modules/npm/bin/npm-cli.js": regularFile,
		});
		expect(
			await resolveExecutable("npm", { PATH: "/usr/bin" }, "linux", fs),
		).toBe("/usr/bin/npm");
	});

	it("rejects a Unix link to a directory", async () => {
		const fs = fileSystem({
			"/bin/server": linkTo("/bin"),
			"/bin": directory,
		});
		expect(
			await resolveExecutable("server", { PATH: "/bin" }, "linux", fs),
		).toBeUndefined();
	});

	it("rejects a Unix link whose target is missing", async () => {
		const fs = fileSystem({
			"/bin/server": linkTo("/bin/removed"),
		});
		expect(
			await resolveExecutable("server", { PATH: "/bin" }, "linux", fs),
		).toBeUndefined();
	});

	it("rejects a Unix link loop", async () => {
		const fs = fileSystem({
			"/bin/server": linkTo("/bin/alias"),
			"/bin/alias": linkTo("/bin/server"),
		});
		expect(
			await resolveExecutable("server", { PATH: "/bin" }, "linux", fs),
		).toBeUndefined();
	});

	it("rejects a Unix link to a file without execute permission", async () => {
		const fs = fileSystem(
			{
				"/bin/server": linkTo("/opt/server/bin/server.js"),
				"/opt/server/bin/server.js": regularFile,
			},
			false,
		);
		expect(
			await resolveExecutable("server", { PATH: "/bin" }, "linux", fs),
		).toBeUndefined();
	});

	it("uses Windows PATHEXT with case-insensitive Path", async () => {
		const executable = String.raw`C:\bin\typescript-language-server.CMD`;
		const fs = fileSystem({
			[executable]: regularFile,
		});
		const resolved = await resolveExecutable(
			"typescript-language-server",
			{ Path: String.raw`C:\bin`, PATHEXT: ".EXE;.CMD" },
			"win32",
			fs,
		);
		expect(resolved?.toLowerCase()).toBe(executable.toLowerCase());
	});

	it("keeps requiring a plain file for Windows PATHEXT candidates", async () => {
		const shim = String.raw`C:\bin\typescript-language-server.CMD`;
		const real = String.raw`C:\bin\real.cmd`;
		const fs = fileSystem({ [shim]: linkTo(real), [real]: regularFile });
		expect(
			await resolveExecutable(
				"typescript-language-server",
				{ Path: String.raw`C:\bin`, PATHEXT: ".EXE;.CMD" },
				"win32",
				fs,
			),
		).toBeUndefined();
	});

	it("rejects command strings that could be interpreted as a shell program", async () => {
		const fs = fileSystem({ "/bin/server": regularFile });
		expect(
			await resolveExecutable("server\n--bad", { PATH: "/bin" }, "linux", fs),
		).toBeUndefined();
	});

	it("follows a real link in a temporary directory with the production file system", async () => {
		const root = await temporaryDirectory();
		const target = join(root, "npm-cli.js");
		await writeFile(target, "#!/usr/bin/env node\n", {
			encoding: "utf8",
			mode: 0o700,
		});
		const link = join(root, "npm");
		await symlink(target, link);
		expect(await resolveExecutable(link, {}, "linux")).toBe(link);

		const broken = join(root, "broken");
		await symlink(join(root, "removed"), broken);
		expect(await resolveExecutable(broken, {}, "linux")).toBeUndefined();

		const linkedDirectory = join(root, "linked-directory");
		const directoryTarget = join(root, "target-directory");
		await mkdir(directoryTarget);
		await symlink(directoryTarget, linkedDirectory, "dir");
		expect(
			await resolveExecutable(linkedDirectory, {}, "linux"),
		).toBeUndefined();
	});
});
