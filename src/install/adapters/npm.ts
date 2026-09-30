import type { InstallRecipe } from "../catalog.js";
import {
	createPackageManagerLaunch,
	type ControlledNpmFiles,
	prepareControlledNpmFiles,
	readControlledNpmFiles,
	validateControlledNpmFiles,
} from "../launch.js";
import type { RecipeAdapter } from "./types.js";

/** npm keeps its exact previous behavior; the adapter only names the variant boundary. */
export const npmAdapter: RecipeAdapter = {
	preflight: () => ({ ok: true }),
	prepareStaging: (stagingPath, recipe) =>
		prepareControlledNpmFiles(stagingPath, recipe),
	readStaging: (stagingPath) => readControlledNpmFiles(stagingPath),
	validate: (recipe, files) =>
		validateControlledNpmFiles(recipe, files as ControlledNpmFiles),
	resolveManager: ({ command, environment, context, resolve }) =>
		resolve(command, environment, context.platform),
	createLaunch: (recipe, stagingPath, managerPath, environment, platform) =>
		createPackageManagerLaunch(
			recipe as Extract<InstallRecipe, { kind: "npm" }>,
			stagingPath,
			managerPath,
			environment,
			platform,
		),
};
