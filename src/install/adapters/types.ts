import type { InstallRecipe } from "../catalog.js";
import type { PackageManagerLaunch } from "../launch.js";

/** Reasons the adapter can refuse a recipe before the coordinator touches managed state. */
export type AdapterDenyReason =
	| "unsupported_platform"
	| "package_manager_missing";

export type AdapterPreflight =
	| { ok: true }
	| { ok: false; reason: AdapterDenyReason };

/** Host facts an installation needs beyond the frozen recipe. */
export interface InstallPlatformContext {
	platform: NodeJS.Platform;
	architecture: NodeJS.Architecture;
	/** Absolute path from the global configuration; only Python recipes consume it. */
	pythonInterpreter?: string;
}

export type ResolveManagerCommand = (
	command: string,
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
) => Promise<string | undefined>;

export interface ManagerResolution {
	recipe: InstallRecipe;
	context: InstallPlatformContext;
	/** npm resolves this command name; Python ignores it and uses the interpreter path. */
	command: string;
	environment: NodeJS.ProcessEnv;
	resolve: ResolveManagerCommand;
}

/**
 * The per-variant half of the coordinator. Policy, locking, staging, audit, cancellation,
 * quarantine and verification stay in the coordinator and are shared by every variant.
 */
export interface RecipeAdapter {
	/** Runs before any managed directory, lock or audit record exists. */
	preflight(
		recipe: InstallRecipe,
		context: InstallPlatformContext,
	): AdapterPreflight;
	prepareStaging(
		stagingPath: string,
		recipe: InstallRecipe,
		context: InstallPlatformContext,
	): Promise<unknown>;
	readStaging(stagingPath: string): Promise<unknown>;
	validate(
		recipe: InstallRecipe,
		files: unknown,
		context: InstallPlatformContext,
	): boolean;
	resolveManager(resolution: ManagerResolution): Promise<string | undefined>;
	createLaunch(
		recipe: InstallRecipe,
		stagingPath: string,
		managerPath: string,
		environment: NodeJS.ProcessEnv,
		platform: NodeJS.Platform,
	): PackageManagerLaunch;
}
