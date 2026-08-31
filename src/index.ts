import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InstallCoordinator } from "./install/coordinator.js";
import { NodePackageManager } from "./install/npm.js";
import { createNodeInstallationVerifier } from "./install/verify.js";

let coordinator: InstallCoordinator | undefined;

/** Exposed for the later tool layer; construction performs no I/O or process startup. */
export function getInstallCoordinator(): InstallCoordinator | undefined {
	return coordinator;
}

export function registerInstallCoordinator(
	value: InstallCoordinator | undefined,
): void {
	coordinator = value;
}

export function createShutdownHandler(): () => Promise<void> {
	let shutdown: Promise<void> | undefined;
	return () => {
		shutdown ??= (async () => {
			const active = coordinator;
			coordinator = undefined;
			await active?.shutdown();
		})();
		return shutdown;
	};
}

export default function registerExtension(pi: ExtensionAPI): void {
	coordinator = new InstallCoordinator({
		packageManager: new NodePackageManager(),
		verifier: createNodeInstallationVerifier(),
	});
	pi.on("session_shutdown", createShutdownHandler());
}
