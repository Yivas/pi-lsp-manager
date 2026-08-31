import { describe, expect, it } from "vitest";
import {
	resolveExecutable,
	type ExecutableFileSystem,
} from "../../src/install/executable.js";

function fileSystem(
	files: readonly string[],
	executable = true,
): ExecutableFileSystem {
	return {
		async lstat(path) {
			if (!files.some((file) => file.toLowerCase() === path.toLowerCase()))
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return { isFile: () => true };
		},
		async access() {
			if (!executable)
				throw Object.assign(new Error("not executable"), { code: "EACCES" });
		},
	};
}

describe("executable resolution", () => {
	it("requires executable permission on Unix", async () => {
		const fs = fileSystem(["/bin/typescript-language-server"], false);
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
		const fs = fileSystem(["/bin/typescript-language-server"]);
		expect(
			await resolveExecutable(
				"typescript-language-server",
				{ PATH: "/bin" },
				"linux",
				fs,
			),
		).toBe("/bin/typescript-language-server");
	});

	it("uses Windows PATHEXT with case-insensitive Path", async () => {
		const executable = String.raw`C:\bin\typescript-language-server.CMD`;
		const fs = fileSystem([executable]);
		const resolved = await resolveExecutable(
			"typescript-language-server",
			{ Path: String.raw`C:\bin`, PATHEXT: ".EXE;.CMD" },
			"win32",
			fs,
		);
		expect(resolved?.toLowerCase()).toBe(executable.toLowerCase());
	});

	it("rejects command strings that could be interpreted as a shell program", async () => {
		const fs = fileSystem(["/bin/server"]);
		expect(
			await resolveExecutable("server\n--bad", { PATH: "/bin" }, "linux", fs),
		).toBeUndefined();
	});
});
