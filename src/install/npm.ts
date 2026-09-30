import { spawn, type ChildProcess } from "node:child_process";
import type {
	PackageManager,
	PackageManagerTermination,
	RunningPackageManager,
} from "./coordinator.js";
import { createCmdShimLaunch, type PackageManagerLaunch } from "./launch.js";
import { BoundedSanitizedOutput, sanitizeText } from "./sanitize.js";

export type SpawnFunction = typeof spawn;

/** Resolves true only when the child reached its close or error event. */
function waitForClose(
	child: ChildProcess,
	milliseconds: number,
): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve(true);
	return new Promise((resolve) => {
		const finish = (closed: boolean) => {
			clearTimeout(timer);
			child.removeListener("close", onClose);
			child.removeListener("error", onError);
			resolve(closed);
		};
		const onClose = () => finish(true);
		const onError = () => finish(true);
		const timer = setTimeout(() => finish(false), milliseconds);
		child.once("close", onClose);
		child.once("error", onError);
	});
}

async function terminateProcessTree(
	child: ChildProcess,
	platform: NodeJS.Platform,
	spawnProcess: SpawnFunction,
): Promise<PackageManagerTermination> {
	if (!child.pid) return { confirmed: true };
	if (platform === "win32") {
		const killer = spawnProcess(
			"taskkill",
			["/pid", String(child.pid), "/t", "/f"],
			{
				shell: false,
				windowsHide: true,
			},
		);
		// `taskkill` exiting only proves the kill command ran. The child's own close event is
		// the proof that the staging directory is no longer held as a working directory.
		await waitForClose(killer, 5_000);
		return { confirmed: await waitForClose(child, 1_000) };
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	if (await waitForClose(child, 2_000)) return { confirmed: true };
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
	return { confirmed: await waitForClose(child, 2_000) };
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
