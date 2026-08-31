import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InstallCoordinator } from "./install/coordinator.js";
import { NodePackageManager } from "./install/npm.js";
import { createNodeInstallationVerifier } from "./install/verify.js";
import { RuntimePool } from "./runtime/pool.js";
import { RuntimeReaper } from "./runtime/reaper.js";

let coordinator: InstallCoordinator | undefined;
let runtimePool: RuntimePool | undefined;
let runtimeReaper: RuntimeReaper | undefined;

/** Exposed for the later tool layer; construction performs no I/O or process startup. */
export function getInstallCoordinator(): InstallCoordinator | undefined {
	return coordinator;
}

export function registerInstallCoordinator(
	value: InstallCoordinator | undefined,
): void {
	coordinator = value;
}

export function getRuntimePool(): RuntimePool | undefined {
	return runtimePool;
}

export function registerRuntimePool(value: RuntimePool | undefined): void {
	runtimePool = value;
}

export function createShutdownHandler(): (_event?: unknown) => Promise<void> {
	let shutdown: Promise<void> | undefined;
	return () => {
		shutdown ??= (async () => {
			const active = coordinator;
			const pool = runtimePool;
			const reaper = runtimeReaper;
			coordinator = undefined;
			runtimePool = undefined;
			runtimeReaper = undefined;
			await Promise.all([active?.shutdown(), reaper?.stop(), pool?.shutdown()]);
		})();
		return shutdown;
	};
}

export default function registerExtension(pi: ExtensionAPI): void {
	coordinator = new InstallCoordinator({
		packageManager: new NodePackageManager(),
		verifier: createNodeInstallationVerifier(),
	});
	// Constructing the reaper creates no interval. The pool starts it only on the
	// first real acquisition, never while Pi loads the extension factory.
	runtimePool = new RuntimePool({ onActive: () => runtimeReaper?.start() });
	runtimeReaper = new RuntimeReaper(runtimePool);
	pi.on("session_shutdown", createShutdownHandler());
}
