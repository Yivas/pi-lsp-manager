import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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
		signalCode: NodeJS.Signals | null;
		kill(): boolean;
	};
	child.pid = 1;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.exitCode = null;
	child.signalCode = null;
	child.kill = () => true;
	return child;
}

/** Dispatches the package-manager spawn and the Windows kill command separately. */
function terminatingSpawn(child: EventEmitter, killer: EventEmitter) {
	return ((...args: unknown[]) =>
		String(args[0]) === "taskkill" ? killer : child) as never;
}

const unixLaunch = () =>
	createPackageManagerLaunch(
		recipe,
		"/tmp/managed/staging",
		"npm",
		{},
		"linux",
	);

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

	it("confirms termination only after the child closes, not when the kill command exits", async () => {
		const child = fakeChild();
		const killer = fakeChild();
		killer.pid = 2;
		const manager = new NodePackageManager(terminatingSpawn(child, killer));
		const launch = createPackageManagerLaunch(
			recipe,
			String.raw`C:\managed\staging`,
			"npm",
			{},
			"win32",
		);
		const running = await manager.start(launch, new AbortController().signal);
		const termination = running.terminate();
		let settled = false;
		void termination.then(() => {
			settled = true;
		});
		// `taskkill` finished while the child is still alive, so termination stays open.
		killer.emit("close", 0);
		await Promise.resolve();
		expect(settled).toBe(false);
		child.exitCode = 143;
		child.emit("close", 143);
		await expect(termination).resolves.toEqual({ confirmed: true });
	});

	it("reports an unconfirmed termination when the child never closes", async () => {
		const child = fakeChild();
		const killer = fakeChild();
		killer.pid = 2;
		const manager = new NodePackageManager(terminatingSpawn(child, killer));
		const launch = createPackageManagerLaunch(
			recipe,
			String.raw`C:\managed\staging`,
			"npm",
			{},
			"win32",
		);
		const running = await manager.start(launch, new AbortController().signal);
		const termination = running.terminate();
		killer.emit("close", 0);
		await expect(termination).resolves.toEqual({ confirmed: false });
	});

	it("confirms termination on Unix once the child closes after SIGTERM", async () => {
		const child = fakeChild();
		const manager = new NodePackageManager((() => child) as never);
		const signals: Array<string | number | undefined> = [];
		const kill = vi
			.spyOn(process, "kill")
			.mockImplementation((_pid, signal) => {
				signals.push(signal);
				if (signal === "SIGTERM")
					queueMicrotask(() => child.emit("close", 143));
				return true;
			});
		try {
			const running = await manager.start(
				unixLaunch(),
				new AbortController().signal,
			);
			await expect(running.terminate()).resolves.toEqual({ confirmed: true });
			expect(signals).toEqual(["SIGTERM"]);
		} finally {
			kill.mockRestore();
		}
	});

	it("escalates to SIGKILL on Unix and confirms the close it observes", async () => {
		const child = fakeChild();
		const manager = new NodePackageManager((() => child) as never);
		const signals: string[] = [];
		const kill = vi
			.spyOn(process, "kill")
			.mockImplementation((_pid, signal) => {
				signals.push(String(signal));
				if (signal === "SIGKILL")
					queueMicrotask(() => child.emit("close", 137));
				return true;
			});
		vi.useFakeTimers();
		try {
			const running = await manager.start(
				unixLaunch(),
				new AbortController().signal,
			);
			const termination = running.terminate();
			await vi.advanceTimersByTimeAsync(2_000);
			await expect(termination).resolves.toEqual({ confirmed: true });
			expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		} finally {
			vi.useRealTimers();
			kill.mockRestore();
		}
	});

	it("reports an unconfirmed termination on Unix when the child never closes", async () => {
		const child = fakeChild();
		const manager = new NodePackageManager((() => child) as never);
		const signals: string[] = [];
		const kill = vi
			.spyOn(process, "kill")
			.mockImplementation((_pid, signal) => {
				signals.push(String(signal));
				return true;
			});
		vi.useFakeTimers();
		try {
			const running = await manager.start(
				unixLaunch(),
				new AbortController().signal,
			);
			const termination = running.terminate();
			await vi.advanceTimersByTimeAsync(4_000);
			await expect(termination).resolves.toEqual({ confirmed: false });
			expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		} finally {
			vi.useRealTimers();
			kill.mockRestore();
		}
	});
});
