import type { ServerAdmission } from "../contracts.js";

export interface PackagePin {
	name: string;
	version: string;
	integrity: string;
	license: string;
	node: string;
}

export interface InstallRecipe {
	serverId: string;
	revision: string;
	platforms: readonly NodeJS.Platform[];
	registry: "https://registry.npmjs.org";
	packages: readonly PackagePin[];
	executable: "typescript-language-server";
	expectedVersion: "5.3.0";
	admission: Extract<ServerAdmission, "auto-installable">;
	manualHelp: string;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child);
		}
	}
	return value;
}

const TYPESCRIPT_RECIPE = deepFreeze<InstallRecipe>({
	serverId: "typescript",
	revision: "typescript-language-server-5.3.0_typescript-5.9.3",
	platforms: ["win32", "darwin", "linux"],
	registry: "https://registry.npmjs.org",
	packages: [
		{
			name: "typescript-language-server",
			version: "5.3.0",
			integrity:
				"sha512-5puofxZHgFdAYtfNpmwCAvgtaYgg8wrUnH30m7Ze3QuguId5RNRadKASpOpyDxTyUdAF51FjhTdjntLw/EuWcQ==",
			license: "Apache-2.0",
			node: ">=20",
		},
		{
			name: "typescript",
			version: "5.9.3",
			integrity:
				"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==",
			license: "Apache-2.0",
			node: ">=14.17",
		},
	],
	executable: "typescript-language-server",
	expectedVersion: "5.3.0",
	admission: "auto-installable",
	manualHelp:
		"Install typescript-language-server 5.3.0 and typescript 5.9.3, then retry.",
});

const RECIPES = deepFreeze<Record<string, InstallRecipe>>({
	typescript: TYPESCRIPT_RECIPE,
});

export function getRecipe(serverId: string): InstallRecipe | undefined {
	return RECIPES[serverId];
}

export function getRecipeRevision(serverId: string): string | undefined {
	return getRecipe(serverId)?.revision;
}
