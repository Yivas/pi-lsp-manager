import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
	chmod,
	link,
	lstat,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	symlink,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	applyValidatedEdits,
	type ApplyFileSystem,
} from "../../src/edits/apply.js";
import type { StatLike } from "../../src/edits/rollback.js";
import { normalizeWorkspaceEdit } from "../../src/edits/normalize.js";
import { validateWorkspaceEdit } from "../../src/edits/validate.js";
import { afterEach, describe, expect, it } from "vitest";

function edit(uri: string, replacement: string) {
	return {
		changes: {
			[uri]: [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					newText: replacement,
				},
			],
		},
	};
}
const baseFileSystem: ApplyFileSystem = {
	lstat,
	stat,
	readFile,
	realpath,
	writeExclusive: (path, data, mode) =>
		writeFile(path, data, { flag: "wx", mode }),
	link,
	chmod,
	rename,
	rm,
};

describe("workspace edit application and rollback", () => {
	let directory: string | undefined;
	afterEach(async () => {
		if (directory) {
			for (let attempt = 0; attempt < 6; attempt += 1) {
				try {
					await rm(directory, { recursive: true, force: true });
					break;
				} catch (error) {
					if (
						!(error instanceof Error) ||
						!("code" in error) ||
						!["EBUSY", "EPERM", "ENOTEMPTY"].includes(
							String((error as NodeJS.ErrnoException).code),
						)
					)
						throw error;
					if (attempt === 5) throw error;
					await new Promise((resolve) =>
						setTimeout(resolve, 25 * (attempt + 1)),
					);
				}
			}
		}
		directory = undefined;
	});

	async function fixture(files = ["alpha\n", "bravo\n"]) {
		directory = await realpath(await mkdtemp(join(tmpdir(), "pi-lsp-apply-")));
		const first = join(directory, "a.ts");
		const second = join(directory, "b.ts");
		await writeFile(first, files[0] ?? "alpha\n");
		await writeFile(second, files[1] ?? "bravo\n");
		const normalized = normalizeWorkspaceEdit({
			changes: {
				[pathToFileURL(second).href]: edit(pathToFileURL(second).href, "B")
					.changes[pathToFileURL(second).href],
				[pathToFileURL(first).href]: edit(pathToFileURL(first).href, "A")
					.changes[pathToFileURL(first).href],
			},
		});
		if (!normalized) throw new Error("Expected edit.");
		const validated = await validateWorkspaceEdit(normalized, {
			workspacePath: directory,
		});
		if (!validated) throw new Error("Expected validation.");
		return { first, second, validated };
	}
	async function artifacts() {
		return directory
			? (await readdir(directory)).filter((name) =>
					name.startsWith(".pi-lsp-manager-"),
				)
			: [];
	}

	it("uses host queues for reversed concurrent inputs without deadlock", async () => {
		const { first, second, validated } = await fixture();
		const reversed = [...validated].reverse();
		const [left, right] = await Promise.race([
			Promise.all([
				applyValidatedEdits(validated),
				applyValidatedEdits(reversed),
			]),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("queue deadlock")), 5_000),
			),
		]);
		expect([left.status, right.status].sort()).toEqual([
			"applied",
			"no_changes",
		]);
		expect(await readFile(first, "utf8")).toBe("Alpha\n");
		expect(await readFile(second, "utf8")).toBe("Bravo\n");
	});

	it("acquires every path in canonical order", async () => {
		const { validated } = await fixture();
		const queues: string[] = [];
		await applyValidatedEdits([...validated].reverse(), {
			queue: async (path, work) => {
				queues.push(path);
				return work();
			},
		});
		expect(queues).toEqual([...queues].sort());
	});

	it("rejects an actual host mutation-queue race with zero mutation writes", async () => {
		const { first, second, validated } = await fixture();
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = withFileMutationQueue(
			first,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
					entered?.();
				}),
		);
		await started;
		const applying = applyValidatedEdits(validated);
		await writeFile(first, "host-won-race\n", "utf8");
		if (!release) throw new Error("Expected host queue holder.");
		release();
		await held;
		const result = await applying;
		expect(result.status).toBe("no_changes");
		expect(await readFile(first, "utf8")).toBe("host-won-race\n");
		expect(await readFile(second, "utf8")).toBe("bravo\n");
		expect(await artifacts()).toEqual([]);
	});

	it("rejects queue-time byte/stat races without writing targets", async () => {
		const { first, second, validated } = await fixture();
		const before = await Promise.all([readFile(first), readFile(second)]);
		let changed = false;
		const result = await applyValidatedEdits(validated, {
			queue: async (_path, work) => {
				if (!changed) {
					changed = true;
					await writeFile(first, "changed-by-host\n");
				}
				return work();
			},
		});
		expect(result.status).toBe("no_changes");
		expect(await readFile(first, "utf8")).toBe("changed-by-host\n");
		expect(await readFile(second)).toEqual(before[1]);
		expect(await artifacts()).toEqual([]);
	});

	it.each([
		["first exclusive temporary write", 1, "write"],
		["first exclusive backup write", 2, "write"],
		["owned temporary identity check", 1, "lstat"],
		["first target chmod", 1, "chmod"],
		["first replacement", 1, "rename"],
		["late replacement", 2, "rename"],
	] as const)(
		"fault injection preserves target bytes at %s",
		async (_name, count, operation) => {
			const { first, second, validated } = await fixture();
			const before = await Promise.all([readFile(first), readFile(second)]);
			let calls = 0;
			const fs: ApplyFileSystem = {
				...baseFileSystem,
				writeExclusive: async (...args) => {
					calls += operation === "write" ? 1 : 0;
					if (operation === "write" && calls === count)
						throw new Error("injected write");
					return baseFileSystem.writeExclusive(...args);
				},
				lstat: async (...args) => {
					calls += operation === "lstat" ? 1 : 0;
					if (operation === "lstat" && calls === count)
						throw new Error("injected lstat");
					return baseFileSystem.lstat(...args);
				},
				chmod: async (...args) => {
					calls += operation === "chmod" ? 1 : 0;
					if (operation === "chmod" && calls === count)
						throw new Error("injected chmod");
					return baseFileSystem.chmod(...args);
				},
				rename: async (...args) => {
					calls += operation === "rename" ? 1 : 0;
					if (operation === "rename" && calls === count)
						throw new Error("injected rename");
					return baseFileSystem.rename(...args);
				},
			};
			const result = await applyValidatedEdits(validated, {
				fileSystem: fs,
				platform: "linux",
			});
			expect(["failed_restored", "rollback_incomplete"]).toContain(
				result.status,
			);
			expect(await Promise.all([readFile(first), readFile(second)])).toEqual(
				before,
			);
			if (result.status === "failed_restored")
				expect(await artifacts()).toEqual([]);
			else {
				expect(
					result.recoveryArtifacts.every((name) => !name.startsWith("..")),
				).toBe(true);
				expect(await artifacts()).toEqual(result.recoveryArtifacts);
			}
		},
	);

	it("rolls back a POSIX replacement that renames then rejects", async () => {
		const { first, second, validated } = await fixture();
		const before = await Promise.all([readFile(first), readFile(second)]);
		let replacementRejected = false;
		const result = await applyValidatedEdits(validated, {
			platform: "linux",
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (!replacementRejected && from.endsWith(".tmp") && to === second) {
						replacementRejected = true;
						await baseFileSystem.rename(from, to);
						throw new Error("rename completed before rejection");
					}
					return baseFileSystem.rename(from, to);
				},
			},
		});
		expect(result.status).toBe("failed_restored");
		expect(await Promise.all([readFile(first), readFile(second)])).toEqual(
			before,
		);
		expect(await artifacts()).toEqual([]);
	});

	it("retains recovery material when a rejected replacement cannot be reconciled", async () => {
		const { first, validated } = await fixture();
		let rejected = false;
		const result = await applyValidatedEdits(validated, {
			platform: "linux",
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (!rejected && from.endsWith(".tmp") && to === first) {
						rejected = true;
						await baseFileSystem.rename(from, to);
						await writeFile(first, "external\n", "utf8");
						throw new Error("replacement outcome was obscured");
					}
					return baseFileSystem.rename(from, to);
				},
			},
		});
		expect(result.status).toBe("rollback_incomplete");
		expect(await readFile(first, "utf8")).toBe("external\n");
		expect(result.files).toEqual(["a.ts"]);
		expect(result.recoveryArtifacts).toHaveLength(1);
		expect(result.recoveryArtifacts[0]).toMatch(/\.bak$/);
		expect(await artifacts()).toEqual(result.recoveryArtifacts);
	});

	it("reconciles a Windows displaced-target rename that rejects late", async () => {
		const { first, validated } = await fixture();
		let rejectedInitialReplace = false;
		let rejectedDisplacement = false;
		const result = await applyValidatedEdits(validated, {
			platform: "win32",
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (
						from.endsWith(".tmp") &&
						to === first &&
						!rejectedInitialReplace
					) {
						rejectedInitialReplace = true;
						throw new Error("cannot replace existing target");
					}
					if (
						from === first &&
						to.includes(".replace-") &&
						!rejectedDisplacement
					) {
						rejectedDisplacement = true;
						await baseFileSystem.rename(from, to);
						throw new Error("displacement completed before rejection");
					}
					return baseFileSystem.rename(from, to);
				},
			},
		});
		expect(result.status).toBe("applied");
		expect(await readFile(first, "utf8")).toBe("Alpha\n");
		expect(await artifacts()).toEqual([]);
		expect(rejectedDisplacement).toBe(true);
	});

	it("rolls back a Windows fallback replacement that renames then rejects", async () => {
		const { first, validated } = await fixture();
		const before = await readFile(first);
		let rejectedInitialReplace = false;
		let rejectedFallbackReplace = false;
		const result = await applyValidatedEdits(validated, {
			platform: "win32",
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (
						from.endsWith(".tmp") &&
						to === first &&
						!rejectedInitialReplace
					) {
						rejectedInitialReplace = true;
						throw new Error("cannot replace existing target");
					}
					if (
						from.endsWith(".tmp") &&
						to === first &&
						!rejectedFallbackReplace
					) {
						rejectedFallbackReplace = true;
						await baseFileSystem.rename(from, to);
						throw new Error("fallback replacement completed before rejection");
					}
					return baseFileSystem.rename(from, to);
				},
			},
		});
		expect(result.status).toBe("failed_restored");
		expect(await readFile(first)).toEqual(before);
		expect(await artifacts()).toEqual([]);
		expect(rejectedFallbackReplace).toBe(true);
	});

	it("never follows a precreated backup symlink", async () => {
		const { first, second, validated } = await fixture();
		const before = await Promise.all([readFile(first), readFile(second)]);
		let planted: string | undefined;
		const result = await applyValidatedEdits(validated, {
			fileSystem: {
				...baseFileSystem,
				writeExclusive: async (path, data, mode) => {
					if (path.endsWith(".bak") && !planted) {
						planted = path;
						await symlink(second, path);
					}
					return baseFileSystem.writeExclusive(path, data, mode);
				},
			},
		});
		expect(result.status).toBe("failed_restored");
		expect(await Promise.all([readFile(first), readFile(second)])).toEqual(
			before,
		);
		expect(result.recoveryArtifacts).toEqual([]);
		// The preexisting symlink is not ours, is never followed, and is not deleted.
		expect(await artifacts()).toHaveLength(1);
		if (planted) await rm(planted, { force: true });
	});

	it("retains only the relative backup that could not be restored or cleaned", async () => {
		const { first, second, validated } = await fixture();
		const before = await Promise.all([readFile(first), readFile(second)]);
		let renameCalls = 0;
		const fs: ApplyFileSystem = {
			...baseFileSystem,
			rename: async (...args) => {
				renameCalls += 1;
				if (renameCalls === 2) throw new Error("late replace");
				return baseFileSystem.rename(...args);
			},
			writeExclusive: async (...args) => {
				if (String(args[0]).includes(".restore-"))
					throw new Error("restore write failed");
				return baseFileSystem.writeExclusive(...args);
			},
		};
		const result = await applyValidatedEdits(validated, {
			fileSystem: fs,
			platform: "linux",
		});
		expect(result.status).toBe("rollback_incomplete");
		expect(result.files).toEqual(["a.ts"]);
		expect(await readFile(second)).toEqual(before[1]);
		expect(result.recoveryArtifacts).toHaveLength(1);
		expect(result.recoveryArtifacts[0]).toMatch(/\.bak$/);
		const entries = await readdir(directory ?? "");
		expect(
			result.recoveryArtifacts.every((name) => entries.includes(name)),
		).toBe(true);
		// The first target was replaced and cannot silently lose its recovery backup.
		expect(await readFile(first, "utf8")).toBe("Alpha\n");
	});

	it("reports a restore artifact whose post-write identity cannot be read", async () => {
		const { first, validated } = await fixture();
		let renameCalls = 0;
		const result = await applyValidatedEdits(validated, {
			platform: "linux",
			fileSystem: {
				...baseFileSystem,
				rename: async (...args) => {
					renameCalls += 1;
					if (renameCalls === 2) throw new Error("late replacement failed");
					return baseFileSystem.rename(...args);
				},
				lstat: async (path) => {
					if (path.includes(".restore-"))
						throw new Error("restore identity unavailable");
					return baseFileSystem.lstat(path);
				},
			},
		});
		expect(result.status).toBe("rollback_incomplete");
		expect(result.files).toEqual(["a.ts"]);
		expect(
			result.recoveryArtifacts.some((name) => name.includes(".restore-")),
		).toBe(true);
		expect(await readFile(first, "utf8")).toBe("Alpha\n");
		expect(await artifacts()).toEqual(result.recoveryArtifacts);
	});

	it("does not overwrite an external target change during rollback", async () => {
		const { first, validated } = await fixture();
		let targetReplaced = false;
		let replacementFailed = false;
		let outputIdentity: StatLike | undefined;
		const result = await applyValidatedEdits(validated, {
			platform: "linux",
			fileSystem: {
				...baseFileSystem,
				lstat: async (path): Promise<StatLike> =>
					path === first && outputIdentity
						? outputIdentity
						: (baseFileSystem.lstat(path) as Promise<StatLike>),
				rename: async (from, to) => {
					if (!targetReplaced && from.endsWith(".tmp") && to === first) {
						targetReplaced = true;
						await baseFileSystem.rename(from, to);
						outputIdentity = (await baseFileSystem.lstat(first)) as StatLike;
						return;
					}
					if (targetReplaced && !replacementFailed && from.endsWith(".tmp")) {
						replacementFailed = true;
						await writeFile(first, "foreign\n", "utf8");
						throw new Error("late replacement failed");
					}
					return baseFileSystem.rename(from, to);
				},
			},
		});
		expect(result.status).toBe("rollback_incomplete");
		expect(await readFile(first, "utf8")).toBe("foreign\n");
		expect(result.recoveryArtifacts).toHaveLength(1);
		expect(result.recoveryArtifacts[0]).toMatch(/\.bak$/);
		const entries = await readdir(directory ?? "");
		expect(
			result.recoveryArtifacts.every((name) => entries.includes(name)),
		).toBe(true);
	});

	it("preserves an external deletion after replacement", async () => {
		const { first, validated } = await fixture();
		let replaced = false;
		let failed = false;
		const result = await applyValidatedEdits(validated, {
			platform: "linux",
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (!replaced && from.endsWith(".tmp") && to === first) {
						replaced = true;
						await baseFileSystem.rename(from, to);
						return;
					}
					if (replaced && !failed && from.endsWith(".tmp")) {
						failed = true;
						await rm(first);
						throw new Error("late replacement failed");
					}
					return baseFileSystem.rename(from, to);
				},
			},
		});
		expect(result.status).toBe("rollback_incomplete");
		await expect(readFile(first)).rejects.toMatchObject({ code: "ENOENT" });
		expect(result.recoveryArtifacts).toHaveLength(1);
		expect(result.recoveryArtifacts[0]).toMatch(/\.bak$/);
		expect(await artifacts()).toEqual(result.recoveryArtifacts);
	});

	it("does not overwrite a target created at the rollback replacement boundary", async () => {
		const { first, validated } = await fixture();
		let replaced = false;
		let failed = false;
		const result = await applyValidatedEdits(validated, {
			platform: "linux",
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (!replaced && from.endsWith(".tmp") && to === first) {
						replaced = true;
						await baseFileSystem.rename(from, to);
						return;
					}
					if (replaced && !failed && from.endsWith(".tmp")) {
						failed = true;
						throw new Error("late replacement failed");
					}
					return baseFileSystem.rename(from, to);
				},
				link: async (source, destination) => {
					if (destination === first)
						await writeFile(first, "external\n", "utf8");
					return link(source, destination);
				},
			},
		});
		expect(result.status).toBe("rollback_incomplete");
		expect(await readFile(first, "utf8")).toBe("external\n");
		expect(result.recoveryArtifacts.length).toBeGreaterThan(1);
		const entries = await readdir(directory ?? "");
		expect(
			result.recoveryArtifacts.every((name) => entries.includes(name)),
		).toBe(true);
	});

	it("retains recovery files when the filesystem cannot create a hard link", async () => {
		const { first, validated } = await fixture();
		let replaced = false;
		let failed = false;
		const result = await applyValidatedEdits(validated, {
			platform: "linux",
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (!replaced && from.endsWith(".tmp") && to === first) {
						replaced = true;
						await baseFileSystem.rename(from, to);
						return;
					}
					if (replaced && !failed && from.endsWith(".tmp")) {
						failed = true;
						throw new Error("late replacement failed");
					}
					return baseFileSystem.rename(from, to);
				},
				link: async () => {
					const error = new Error(
						"hard links unsupported",
					) as NodeJS.ErrnoException;
					error.code = "ENOTSUP";
					throw error;
				},
			},
		});
		expect(result.status).toBe("rollback_incomplete");
		await expect(readFile(first)).rejects.toMatchObject({ code: "ENOENT" });
		expect(result.recoveryArtifacts).toHaveLength(2);
		const entries = await readdir(directory ?? "");
		expect(
			result.recoveryArtifacts.every((name) => entries.includes(name)),
		).toBe(true);
	});

	it("reports the cleanup quarantine when deletion fails", async () => {
		const { validated } = await fixture();
		const result = await applyValidatedEdits(validated, {
			fileSystem: {
				...baseFileSystem,
				rm: async (path, options) => {
					if (path.includes(".cleanup-"))
						throw new Error("quarantine cleanup failed");
					return baseFileSystem.rm(path, options);
				},
			},
		});
		expect(result.status).toBe("manual_recovery");
		const leftovers = await artifacts();
		expect(result.recoveryArtifacts).toEqual(leftovers);
		expect(
			result.recoveryArtifacts.some((name) => name.includes(".cleanup-")),
		).toBe(true);
		for (const name of leftovers)
			await baseFileSystem.rm(join(directory ?? "", name), { force: true });
	});

	it.each(["EACCES", "EIO"] as const)(
		"reports rollback quarantine after lstat returns %s",
		async (code) => {
			const { first, validated } = await fixture();
			let replaced = false;
			let failedCleanupPath: string | undefined;
			const result = await applyValidatedEdits(validated, {
				platform: "linux",
				fileSystem: {
					...baseFileSystem,
					lstat: async (path) => {
						if (path === failedCleanupPath) {
							const error = new Error(
								"quarantine inspection failed",
							) as NodeJS.ErrnoException;
							error.code = code;
							throw error;
						}
						return baseFileSystem.lstat(path);
					},
					rename: async (from, to) => {
						if (!replaced && from.endsWith(".tmp") && to === first) {
							replaced = true;
							await baseFileSystem.rename(from, to);
							return;
						}
						if (replaced && from.endsWith(".tmp"))
							throw new Error("late replacement failed");
						if (from.includes(".rollback-") && to.includes(".cleanup-")) {
							failedCleanupPath = to;
							await baseFileSystem.rename(from, to);
							throw new Error("cleanup rename result unavailable");
						}
						return baseFileSystem.rename(from, to);
					},
				},
			});
			if (!failedCleanupPath) throw new Error("Expected quarantine path.");
			expect(result.status).toBe("rollback_incomplete");
			const entries = await readdir(directory ?? "");
			const survivor = failedCleanupPath.split(/[\\/]/).at(-1) ?? "";
			expect(result.recoveryArtifacts).toContain(survivor);
			expect(entries).toContain(survivor);
			expect(
				result.recoveryArtifacts.every((name) => entries.includes(name)),
			).toBe(true);
		},
	);

	it.each(["EACCES", "EIO"] as const)(
		"reports normal cleanup quarantine after lstat returns %s",
		async (code) => {
			const { validated } = await fixture();
			let failedCleanupPath: string | undefined;
			const movedBackups: Array<{ path: string; bytes: Buffer }> = [];
			const result = await applyValidatedEdits(validated, {
				fileSystem: {
					...baseFileSystem,
					lstat: async (path) => {
						if (path === failedCleanupPath) {
							const error = new Error(
								"quarantine inspection failed",
							) as NodeJS.ErrnoException;
							error.code = code;
							throw error;
						}
						return baseFileSystem.lstat(path);
					},
					rename: async (from, to) => {
						if (from.endsWith(".bak") && to.includes(".cleanup-")) {
							failedCleanupPath = to;
							movedBackups.push({
								path: to,
								bytes: await baseFileSystem.readFile(from),
							});
							await baseFileSystem.rename(from, to);
							throw new Error("cleanup rename result unavailable");
						}
						return baseFileSystem.rename(from, to);
					},
				},
			});
			if (!failedCleanupPath) throw new Error("Expected quarantine path.");
			expect(result.status).toBe("manual_recovery");
			const entries = await readdir(directory ?? "");
			const survivor = failedCleanupPath.split(/[\\/]/).at(-1) ?? "";
			expect(result.recoveryArtifacts).toContain(survivor);
			expect(entries).toContain(survivor);
			expect(
				result.recoveryArtifacts.every((name) => entries.includes(name)),
			).toBe(true);
			for (const backup of movedBackups)
				expect(await readFile(backup.path)).toEqual(backup.bytes);
		},
	);

	it("restores a foreign cleanup replacement from quarantine without deleting it", async () => {
		const { validated } = await fixture();
		let replacedArtifact: string | undefined;
		let quarantinePath: string | undefined;
		const result = await applyValidatedEdits(validated, {
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (
						!replacedArtifact &&
						from.endsWith(".bak") &&
						to.includes(".cleanup-")
					) {
						replacedArtifact = from;
						quarantinePath = to;
						await rm(from);
						await writeFile(from, "foreign backup\n", "utf8");
					}
					return baseFileSystem.rename(from, to);
				},
			},
		});
		if (!replacedArtifact || !quarantinePath)
			throw new Error("Expected a replaced cleanup artifact.");
		expect(result.status).toBe("manual_recovery");
		expect(await readFile(replacedArtifact, "utf8")).toBe("foreign backup\n");
		expect(await readFile(quarantinePath, "utf8")).toBe("foreign backup\n");
		expect(result.recoveryArtifacts).toContain(
			quarantinePath.split(/[\\/]/).at(-1),
		);
		expect(result.recoveryArtifacts).toContain(
			replacedArtifact.split(/[\\/]/).at(-1),
		);
		expect(await artifacts()).toEqual(result.recoveryArtifacts);
	});

	it("keeps both files when a target races the cleanup hard-link restoration", async () => {
		const { validated } = await fixture();
		let replacedArtifact: string | undefined;
		let quarantinePath: string | undefined;
		let racedLink = false;
		const result = await applyValidatedEdits(validated, {
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (
						!replacedArtifact &&
						from.endsWith(".bak") &&
						to.includes(".cleanup-")
					) {
						replacedArtifact = from;
						quarantinePath = to;
						await rm(from);
						await writeFile(from, "foreign backup\n", "utf8");
					}
					return baseFileSystem.rename(from, to);
				},
				link: async (source, destination) => {
					if (destination === replacedArtifact && !racedLink) {
						racedLink = true;
						await writeFile(destination, "concurrent file\n", "utf8");
					}
					return baseFileSystem.link(source, destination);
				},
			},
		});
		if (!replacedArtifact || !quarantinePath)
			throw new Error("Expected a replaced cleanup artifact.");
		expect(result.status).toBe("manual_recovery");
		expect(await readFile(replacedArtifact, "utf8")).toBe("concurrent file\n");
		expect(await readFile(quarantinePath, "utf8")).toBe("foreign backup\n");
		expect(result.recoveryArtifacts).toContain(
			replacedArtifact.split(/[\\/]/).at(-1),
		);
		expect(result.recoveryArtifacts).toContain(
			quarantinePath.split(/[\\/]/).at(-1),
		);
		expect(await artifacts()).toEqual(result.recoveryArtifacts);
	});

	it("reconciles a rollback quarantine moved before rename rejects", async () => {
		const { first, second, validated } = await fixture();
		const before = await Promise.all([readFile(first), readFile(second)]);
		let rejectedReplacement = false;
		let rejectedQuarantine = false;
		const result = await applyValidatedEdits(validated, {
			platform: "linux",
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (!rejectedReplacement && from.endsWith(".tmp") && to === second) {
						rejectedReplacement = true;
						throw new Error("late replacement failed");
					}
					if (
						!rejectedQuarantine &&
						from === first &&
						to.includes(".rollback-")
					) {
						rejectedQuarantine = true;
						await baseFileSystem.rename(from, to);
						throw new Error("rollback quarantine completed before rejection");
					}
					return baseFileSystem.rename(from, to);
				},
			},
		});
		expect(result.status).toBe("failed_restored");
		expect(await Promise.all([readFile(first), readFile(second)])).toEqual(
			before,
		);
		expect(result.recoveryArtifacts).toEqual([]);
		expect(await artifacts()).toEqual([]);
		expect(rejectedQuarantine).toBe(true);
	});

	it("does not report quarantine names after rm deletes before rejecting", async () => {
		const { validated } = await fixture();
		const removedQuarantines: string[] = [];
		const result = await applyValidatedEdits(validated, {
			fileSystem: {
				...baseFileSystem,
				rm: async (path, options) => {
					if (path.includes(".cleanup-")) {
						removedQuarantines.push(path);
						await baseFileSystem.rm(path, options);
						throw new Error("late cleanup failure");
					}
					return baseFileSystem.rm(path, options);
				},
			},
		});
		expect(result.status).toBe("applied");
		expect(result.recoveryArtifacts).toEqual([]);
		const entries = await readdir(directory ?? "");
		for (const path of removedQuarantines)
			expect(entries).not.toContain(path.split(/[\\/]/).at(-1));
	});

	it("does not report removed rollback quarantines after rm rejects late", async () => {
		const { first, second, validated } = await fixture();
		let replaced = false;
		const removedQuarantines: string[] = [];
		const result = await applyValidatedEdits(validated, {
			platform: "linux",
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (!replaced && from.endsWith(".tmp") && to === first) {
						replaced = true;
						await baseFileSystem.rename(from, to);
						return;
					}
					if (replaced && from.endsWith(".tmp") && to === second)
						throw new Error("late replacement failed");
					return baseFileSystem.rename(from, to);
				},
				rm: async (path, options) => {
					if (
						path.includes(".cleanup-") &&
						(path.includes(".restore-") || path.includes(".rollback-"))
					) {
						removedQuarantines.push(path);
						await baseFileSystem.rm(path, options);
						throw new Error("late rollback cleanup failure");
					}
					return baseFileSystem.rm(path, options);
				},
			},
		});
		expect(result.status).toBe("failed_restored");
		expect(result.recoveryArtifacts).toEqual([]);
		const entries = await readdir(directory ?? "");
		for (const path of removedQuarantines)
			expect(entries).not.toContain(path.split(/[\\/]/).at(-1));
	});

	it("reports the quarantine left by standalone cleanup", async () => {
		const { validated } = await fixture();
		const result = await applyValidatedEdits(validated, {
			fileSystem: {
				...baseFileSystem,
				writeExclusive: async (path, data, mode) => {
					if (path.endsWith(".bak")) throw new Error("backup write failed");
					return baseFileSystem.writeExclusive(path, data, mode);
				},
				rm: async (path, options) => {
					if (path.includes(".cleanup-"))
						throw new Error("quarantine cleanup failed");
					return baseFileSystem.rm(path, options);
				},
			},
		});
		expect(result.status).toBe("rollback_incomplete");
		const leftovers = await artifacts();
		expect(result.recoveryArtifacts).toEqual(leftovers);
		expect(
			result.recoveryArtifacts.some((name) => name.includes(".cleanup-")),
		).toBe(true);
		for (const name of leftovers)
			await baseFileSystem.rm(join(directory ?? "", name), { force: true });
	});

	it("preserves recovery material when rollback cannot quarantine its target", async () => {
		const { first, second, validated } = await fixture();
		const before = await Promise.all([readFile(first), readFile(second)]);
		let renameCalls = 0;
		const result = await applyValidatedEdits(validated, {
			platform: "linux",
			fileSystem: {
				...baseFileSystem,
				rename: async (...args) => {
					renameCalls += 1;
					if (renameCalls === 2 || renameCalls === 3)
						throw new Error("replace or restore failed");
					return baseFileSystem.rename(...args);
				},
			},
		});
		expect(result.status).toBe("rollback_incomplete");
		expect(result.files).toEqual(["a.ts"]);
		expect(result.recoveryArtifacts).toHaveLength(1);
		expect(await readFile(first, "utf8")).toBe("Alpha\n");
		expect(await readFile(second)).toEqual(before[1]);
		expect(await artifacts()).toEqual(result.recoveryArtifacts);
	});

	it.each(["realpath", "stat", "readFile"] as const)(
		"treats a queue-boundary %s fault as zero target writes",
		async (operation) => {
			const { first, second, validated } = await fixture();
			const before = await Promise.all([readFile(first), readFile(second)]);
			let injected = false;
			const fs: ApplyFileSystem = {
				...baseFileSystem,
				[operation]: async (...args: [string]) => {
					if (!injected) {
						injected = true;
						throw new Error("queue boundary fault");
					}
					return (
						baseFileSystem[operation] as (path: string) => Promise<unknown>
					)(...args) as never;
				},
			};
			const result = await applyValidatedEdits(validated, { fileSystem: fs });
			expect(result.status).toBe("no_changes");
			expect(await Promise.all([readFile(first), readFile(second)])).toEqual(
				before,
			);
			expect(await artifacts()).toEqual([]);
		},
	);

	it("does not return early when cancellation arrives after commit begins", async () => {
		const { first, second, validated } = await fixture();
		const controller = new AbortController();
		let replacements = 0;
		const result = await applyValidatedEdits(validated, {
			signal: controller.signal,
			fileSystem: {
				...baseFileSystem,
				rename: async (...args) => {
					replacements += 1;
					await baseFileSystem.rename(...args);
					if (replacements === 1) controller.abort();
				},
			},
		});
		expect(result.status).toBe("applied");
		expect(await readFile(first, "utf8")).toBe("Alpha\n");
		expect(await readFile(second, "utf8")).toBe("Bravo\n");
		expect(await artifacts()).toEqual([]);
	});

	it("preserves target permission bits after replacement", async () => {
		const { first } = await fixture();
		await chmod(first, 0o744);
		const normalized = normalizeWorkspaceEdit(
			edit(pathToFileURL(first).href, "A"),
		);
		if (!normalized || !directory) throw new Error("Expected edit fixture.");
		const refreshed = await validateWorkspaceEdit(normalized, {
			workspacePath: directory,
		});
		if (!refreshed) throw new Error("Expected refreshed validation.");
		expect((await applyValidatedEdits(refreshed)).status).toBe("applied");
		const mode = (await stat(first)).mode & 0o777;
		if (process.platform === "win32") expect(mode & 0o200).toBe(0o200);
		else expect(mode).toBe(0o744);
	});

	it("uses the explicit Windows replacement fallback while retaining a backup until cleanup", async () => {
		const { first, second, validated } = await fixture();
		let firstTargetReplacement = true;
		const result = await applyValidatedEdits(validated, {
			platform: "win32",
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (firstTargetReplacement && to === first && from.endsWith(".tmp")) {
						firstTargetReplacement = false;
						throw new Error("windows target exists");
					}
					return baseFileSystem.rename(from, to);
				},
			},
		});
		expect(result.status).toBe("applied");
		expect(await readFile(first, "utf8")).toBe("Alpha\n");
		expect(await readFile(second, "utf8")).toBe("Bravo\n");
		expect(await artifacts()).toEqual([]);
	});

	it("never deletes a foreign replacement raced into cleanup", async () => {
		const { validated } = await fixture();
		let replaced = false;
		const result = await applyValidatedEdits(validated, {
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (!replaced && from.endsWith(".bak") && to.includes(".cleanup-")) {
						replaced = true;
						await rm(from, { force: true });
						await writeFile(from, "foreign file\n", "utf8");
					}
					return baseFileSystem.rename(from, to);
				},
			},
		});
		expect(result.status).toBe("manual_recovery");
		expect(result.files).toEqual(["a.ts", "b.ts"]);
		const leftovers = await artifacts();
		expect(leftovers).toEqual(result.recoveryArtifacts);
		if (!directory) throw new Error("Expected fixture directory.");
		for (const name of leftovers)
			expect(await readFile(join(directory, name), "utf8")).toBe(
				"foreign file\n",
			);
		for (const name of leftovers)
			await rm(join(directory, name), { force: true });
	});

	it("restores an existing target on the Windows rollback path", async () => {
		const { first, second, validated } = await fixture();
		let restoreRenameFailed = false;
		const result = await applyValidatedEdits(validated, {
			platform: "win32",
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (from.endsWith(".tmp") && to === second)
						throw new Error("late replacement failed");
					if (
						!restoreRenameFailed &&
						from.includes(".restore-") &&
						to === first
					) {
						restoreRenameFailed = true;
						throw new Error("windows cannot replace target");
					}
					return baseFileSystem.rename(from, to);
				},
			},
		});
		expect(result.status).toBe("failed_restored");
		expect(await readFile(first, "utf8")).toBe("alpha\n");
		expect(await readFile(second, "utf8")).toBe("bravo\n");
		expect(await artifacts()).toEqual([]);
	});

	it("restores the target if Windows displaced-target inspection fails", async () => {
		const { first, second, validated } = await fixture();
		const before = await Promise.all([readFile(first), readFile(second)]);
		let forceFallback = true;
		let failDisplacedInspection = true;
		const result = await applyValidatedEdits(validated, {
			platform: "win32",
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (forceFallback && from.endsWith(".tmp") && to === first) {
						forceFallback = false;
						throw new Error("windows target exists");
					}
					return baseFileSystem.rename(from, to);
				},
				lstat: async (path) => {
					if (failDisplacedInspection && path.includes(".replace-")) {
						failDisplacedInspection = false;
						throw new Error("displaced identity unavailable");
					}
					return baseFileSystem.lstat(path);
				},
			},
		});
		expect(result.status).toBe("failed_restored");
		expect(await Promise.all([readFile(first), readFile(second)])).toEqual(
			before,
		);
		expect(await artifacts()).toEqual([]);
	});

	it("reports manual recovery on every cleanup failure and does not hide it as applied", async () => {
		const { validated } = await fixture();
		const result = await applyValidatedEdits(validated, {
			fileSystem: {
				...baseFileSystem,
				rm: async () => {
					throw new Error("cleanup denied");
				},
			},
		});
		expect(result.status).toBe("manual_recovery");
		expect(result.files).toEqual(["a.ts", "b.ts"]);
		expect(result.editCount).toBe(2);
		expect(result.recoveryArtifacts.length).toBeGreaterThan(0);
		expect(
			result.recoveryArtifacts.every(
				(name) => !name.includes("/") && !name.includes("\\"),
			),
		).toBe(true);
		if (!directory) throw new Error("Expected fixture directory.");
		for (const name of await artifacts())
			await baseFileSystem.rm(join(directory, name), { force: true });
	});

	it.each(["before preparation", "during preparation", "precommit"] as const)(
		"cancellation %s changes zero target bytes and cleans artifacts",
		async (phase) => {
			const { first, second, validated } = await fixture();
			const before = await Promise.all([readFile(first), readFile(second)]);
			const controller = new AbortController();
			if (phase === "before preparation") controller.abort();
			let writes = 0;
			const fs: ApplyFileSystem = {
				...baseFileSystem,
				writeExclusive: async (...args) => {
					writes += 1;
					await baseFileSystem.writeExclusive(...args);
					if (phase === "during preparation" && writes === 1)
						controller.abort();
				},
			};
			const result = await applyValidatedEdits(validated, {
				signal: controller.signal,
				fileSystem: fs,
				onPhase: (current) => {
					if (phase === "precommit" && current === "prepared")
						controller.abort();
				},
			});
			expect(["no_changes", "manual_recovery"]).toContain(result.status);
			expect(await Promise.all([readFile(first), readFile(second)])).toEqual(
				before,
			);
			if (result.status === "no_changes") expect(await artifacts()).toEqual([]);
		},
	);
});
