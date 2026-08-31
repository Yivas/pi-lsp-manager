import type {
	EffectiveConfig,
	EffectiveServerConfig,
	ResolvedFile,
	SelectionRole,
	ServerSelection,
	ServerSelectionContext,
} from "../contracts.js";

function compareServerIds(left: string, right: string): number {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

function compareServers(
	left: EffectiveServerConfig,
	right: EffectiveServerConfig,
): number {
	return right.priority - left.priority || compareServerIds(left.id, right.id);
}

function supportsRole(
	server: EffectiveServerConfig,
	role: SelectionRole,
): boolean {
	if (role === "diagnostics") {
		return server.roles.includes("diagnostics");
	}
	if (role === "mutation") {
		return server.roles.includes("mutation");
	}
	return server.roles.includes("semantic");
}

function supportsFile(
	server: EffectiveServerConfig,
	file: ResolvedFile,
): boolean {
	return (
		server.extensions.includes(file.extension) &&
		server.languageIds.includes(file.languageId)
	);
}

function canInstall(
	config: EffectiveConfig,
	server: EffectiveServerConfig,
	context: ServerSelectionContext,
): boolean {
	return (
		context.projectTrusted &&
		config.network === "auto" &&
		config.autoInstall &&
		server.autoInstall &&
		server.admission === "auto-installable" &&
		!context.availableServerIds.has(server.id)
	);
}

export function selectServers(
	config: EffectiveConfig,
	file: ResolvedFile,
	role: SelectionRole,
	context: ServerSelectionContext,
): ServerSelection {
	if (!context.projectTrusted) {
		return { auxiliaries: [] };
	}
	const candidates = Object.values(config.servers)
		.filter(
			(server) =>
				server.enabled &&
				supportsRole(server, role) &&
				supportsFile(server, file),
		)
		.sort(compareServers);
	const [primary, ...remaining] = candidates;
	if (!primary) {
		return { auxiliaries: [] };
	}
	const auxiliaries =
		role === "diagnostics"
			? remaining.filter((server) => context.availableServerIds.has(server.id))
			: [];
	return {
		primary,
		auxiliaries,
		...(canInstall(config, primary, context)
			? { installCandidate: primary }
			: {}),
	};
}
