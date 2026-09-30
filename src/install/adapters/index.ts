import type { InstallRecipe } from "../catalog.js";
import { npmAdapter } from "./npm.js";
import { pythonAdapter } from "./python.js";
import type { RecipeAdapter } from "./types.js";

/** Dispatches the four variant operations while the coordinator keeps the shared phases. */
export function recipeAdapter(recipe: InstallRecipe): RecipeAdapter {
	switch (recipe.kind) {
		case "npm":
			return npmAdapter;
		case "python":
			return pythonAdapter;
		default: {
			// A new recipe kind must be routed explicitly, never fall through to Python.
			const unreachable: never = recipe;
			throw new Error(`Unsupported recipe kind: ${String(unreachable)}`);
		}
	}
}
