import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { getRecipe } from "../../src/install/catalog.js";
import { createPackageManagerLaunch } from "../../src/install/launch.js";
import { NodePackageManager } from "../../src/install/npm.js";

const recipe = getRecipe("typescript");
if (!recipe) throw new Error("TypeScript recipe is required.");

function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		pid: number;
		stdout: EventEmitter;
		stderr: EventEmitter;
		exitCode: number | null;
		kill(): boolean;
	};
	child.pid = 1;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.exitCode = null;
	child.kill = () => true;
	return child;
}

describe("Node package manager", () => {
	it("uses shell:false with a controlled Windows shim and bounds sanitized streamed output", async () => {
		const calls: unknown[][] = [];
		const child = fakeChild();
		const manager = new NodePackageManager(((...args: unknown[]) => {
			calls.push(args);
			return child;
		}) as never);
		const launch = createPackageManagerLaunch(
			recipe,
			String.raw`C:\managed path\staging`,
			String.raw`C:\safe path\npm.cmd`,
			{
				Path: String.raw`C:\safe`,
				ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
			},
			"win32",
		);
		const running = await manager.start(launch, new AbortController().signal);
		child.stdout.emit("data", "Authorization: Bea");
		child.stdout.emit("data", "rer secret-token");
		child.emit("close", 0);
		const outcome = await running.completed;
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe(String.raw`C:\Windows\System32\cmd.exe`);
		const spawnOptions = calls[0]?.[2] as {
			shell?: boolean;
			windowsVerbatimArguments?: boolean;
		};
		expect(spawnOptions.shell).toBe(false);
		expect(spawnOptions.windowsVerbatimArguments).toBe(true);
		expect(outcome.stdout).not.toContain("secret-token");
	});

	it("rejects an unsafe resolved shim before spawn", async () => {
		let spawned = false;
		const manager = new NodePackageManager((() => {
			spawned = true;
			return fakeChild();
		}) as never);
		const launch = createPackageManagerLaunch(
			recipe,
			String.raw`C:\managed`,
			String.raw`C:\safe\npm.cmd`,
			{ ComSpec: "cmd.exe" },
			"win32",
		);
		const unsafe = { ...launch, args: ["ci", "%EVIL%"] };
		await expect(
			manager.start(unsafe, new AbortController().signal),
		).rejects.toThrow("Unsafe");
		expect(spawned).toBe(false);
	});
});
