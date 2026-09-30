import type { EffectiveConfig } from "../contracts.js";
import { getRecipe, type InstallRecipe } from "./catalog.js";

export type InstallOrigin = "tool" | "post-edit" | "explicit";
export type InstallDenyReason =
	| "untrusted_project"
	| "server_missing"
	| "server_disabled"
	| "auto_install_disabled"
	| "offline"
	| "unsupported_platform"
	| "recipe_missing"
	| "recipe_not_admitted"
	| "package_manager_missing";

export type InstallPolicyDecision =
	| { allowed: true; recipe: InstallRecipe }
	| { allowed: false; reason: InstallDenyReason; manualHelp: string };

export interface InstallPolicyInput {
	origin: InstallOrigin;
	serverId: string;
	globalConfig: EffectiveConfig;
	projectConfig?: EffectiveConfig;
	projectTrusted: boolean;
	platform: NodeJS.Platform;
	architecture: NodeJS.Architecture;
	/** Global-only trusted installer interpreter; a Python recipe denies without it. */
	pythonInterpreter?: string;
	/** Test seam over the frozen recipe registry; production uses the real lookup. */
	recipeLookup?: (serverId: string) => InstallRecipe | undefined;
}

const NO_RECIPE_HELP = "No approved automatic recipe exists for this server.";

/** Pure policy gate. Callers must not touch managed state before it permits work. */
export function evaluateInstallPolicy(
	input: InstallPolicyInput,
): InstallPolicyDecision {
	const config =
		input.origin === "explicit"
			? input.globalConfig
			: (input.projectConfig ?? input.globalConfig);
	const server = config.servers[input.serverId];
	if (!server) {
		return {
			allowed: false,
			reason: "server_missing",
			manualHelp: NO_RECIPE_HELP,
		};
	}
	if (!server.enabled) {
		return {
			allowed: false,
			reason: "server_disabled",
			manualHelp: server.manualHelp,
		};
	}
	if (config.network === "offline") {
		return { allowed: false, reason: "offline", manualHelp: server.manualHelp };
	}
	const recipe = (input.recipeLookup ?? getRecipe)(input.serverId);
	if (!recipe) {
		return {
			allowed: false,
			reason: "recipe_missing",
			manualHelp: server.manualHelp,
		};
	}
	if (recipe.admission !== "auto-installable") {
		return {
			allowed: false,
			reason: "recipe_not_admitted",
			manualHelp: server.manualHelp,
		};
	}
	if (
		!recipe.targets.some(
			(target) =>
				target.platform === input.platform &&
				target.architecture === input.architecture,
		)
	) {
		return {
			allowed: false,
			reason: "unsupported_platform",
			manualHelp: server.manualHelp,
		};
	}
	if (input.origin !== "explicit" && !input.projectTrusted) {
		return {
			allowed: false,
			reason: "untrusted_project",
			manualHelp: server.manualHelp,
		};
	}
	if (
		input.origin !== "explicit" &&
		(!config.autoInstall || !server.autoInstall)
	) {
		return {
			allowed: false,
			reason: "auto_install_disabled",
			manualHelp: server.manualHelp,
		};
	}
	// The interpreter is only required once trust and auto-install allow the install, so an
	// untrusted or auto-install-disabled project keeps reporting that primary denial.
	if (recipe.kind === "python" && !input.pythonInterpreter) {
		return {
			allowed: false,
			reason: "package_manager_missing",
			manualHelp: recipe.manualHelp,
		};
	}
	return { allowed: true, recipe };
}
