import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	isEditToolResult,
	isWriteToolResult,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { meetsMinimumNodeVersion } from "../../src/host/version.js";
import {
	createShutdownHandler,
	registerInstallCoordinator,
	default as registerExtension,
} from "../../src/index.js";

describe("Pi host baseline", () => {
	it("compares the exact supported Node baseline", () => {
		expect(meetsMinimumNodeVersion("22.18.99")).toBe(false);
		expect(meetsMinimumNodeVersion("22.19.0")).toBe(true);
		expect(meetsMinimumNodeVersion("v24.9.0")).toBe(true);
		expect(meetsMinimumNodeVersion("invalid")).toBe(false);
	});

	it("imports the approved host APIs and declares the nested extension manifest", async () => {
		const manifest = JSON.parse(
			await readFile(join(process.cwd(), "package.json"), "utf8"),
		) as {
			engines: { node: string };
			pi: { extensions: string[] };
		};
		expect(meetsMinimumNodeVersion(process.versions.node)).toBe(true);
		expect(manifest.engines.node).toBe(">=22.19.0");
		expect(manifest.pi.extensions).toEqual(["./src/index.ts"]);
		expect(typeof getAgentDir).toBe("function");
		expect(typeof CONFIG_DIR_NAME).toBe("string");
		expect(typeof withFileMutationQueue).toBe("function");
		expect(typeof isEditToolResult).toBe("function");
		expect(typeof isWriteToolResult).toBe("function");
		expect(typeof StringEnum).toBe("function");
		expect(typeof Type.Object).toBe("function");
	});

	it("constructs the idle coordinator and registers an awaitable shutdown seam", async () => {
		const handlers = new Map<string, () => Promise<void>>();
		registerExtension({
			on(event: string, handler: () => Promise<void>) {
				handlers.set(event, handler);
			},
		} as never);
		expect([...handlers.keys()]).toEqual(["session_shutdown"]);
		const shutdown = handlers.get("session_shutdown");
		if (!shutdown) throw new Error("Shutdown handler is required.");
		await Promise.all([shutdown(), shutdown()]);
	});

	it("awaits an installed coordinator shutdown exactly once", async () => {
		let calls = 0;
		registerInstallCoordinator({
			shutdown: async () => {
				calls += 1;
			},
		} as never);
		const shutdown = createShutdownHandler();
		await Promise.all([shutdown(), shutdown()]);
		expect(calls).toBe(1);
	});
});
