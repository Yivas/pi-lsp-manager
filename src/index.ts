import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function createShutdownHandler(): () => void {
	let closed = false;
	return () => {
		if (closed) {
			return;
		}
		closed = true;
	};
}

export default function registerExtension(pi: ExtensionAPI): void {
	const shutdown = createShutdownHandler();
	pi.on("session_shutdown", shutdown);
}
