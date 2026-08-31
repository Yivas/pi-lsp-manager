import { spawn, type ChildProcess } from "node:child_process";
import type { PackageManager, RunningPackageManager } from "./coordinator.js";
import { createCmdShimLaunch, type PackageManagerLaunch } from "./launch.js";
import { BoundedSanitizedOutput, sanitizeText } from "./sanitize.js";

export type SpawnFunction = typeof spawn;

function waitForClose(
	child: ChildProcess,
	milliseconds: number,
): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
		child.once("error", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function terminateProcessTree(
	child: ChildProcess,
	platform: NodeJS.Platform,
	spawnProcess: SpawnFunction,
): Promise<void> {
	if (!child.pid) return;
	if (platform === "win32") {
		const killer = spawnProcess(
			"taskkill",
			["/pid", String(child.pid), "/t", "/f"],
			{
				shell: false,
				windowsHide: true,
			},
		);
		await waitForClose(killer, 5_000);
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	await waitForClose(child, 2_000);
	if (child.exitCode === null) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
		await waitForClose(child, 2_000);
	}
}

/** Production adapter. It accepts only launch descriptions built from a controlled recipe. */
export class NodePackageManager implements PackageManager {
	public constructor(private readonly spawnProcess: SpawnFunction = spawn) {}

	public async start(
		launch: PackageManagerLaunch,
		_signal: AbortSignal,
	): Promise<RunningPackageManager> {
		const lowerCommand = launch.command.toLowerCase();
		const command =
			launch.platform === "win32" &&
			(lowerCommand.endsWith(".cmd") || lowerCommand.endsWith(".bat"))
				? createCmdShimLaunch(
						launch.command,
						launch.args,
						launch.env.ComSpec ?? "cmd.exe",
					)
				: { command: launch.command, args: launch.args, shell: false as const };
		if (!command) throw new Error("Unsafe package manager shim.");
		const child = this.spawnProcess(command.command, [...command.args], {
			cwd: launch.cwd,
			env: launch.env,
			shell: false,
			windowsHide: true,
			windowsVerbatimArguments: command.windowsVerbatimArguments,
			detached: launch.platform !== "win32",
		});
		const stdout = new BoundedSanitizedOutput();
		const stderr = new BoundedSanitizedOutput();
		child.stdout?.on("data", (chunk: Buffer | string) =>
			stdout.append(String(chunk)),
		);
		child.stderr?.on("data", (chunk: Buffer | string) =>
			stderr.append(String(chunk)),
		);
		const completed = new Promise<{
			exitCode: number;
			stdout: string;
			stderr: string;
		}>((resolve) => {
			child.once("error", (error: Error) =>
				resolve({
					exitCode: 1,
					stdout: stdout.value(),
					stderr: sanitizeText(`${stderr.value()}${error.message}`),
				}),
			);
			child.once("close", (code) =>
				resolve({
					exitCode: code ?? 1,
					stdout: stdout.value(),
					stderr: stderr.value(),
				}),
			);
		});
		return {
			completed,
			terminate: () =>
				terminateProcessTree(child, launch.platform, this.spawnProcess),
		};
	}
}
