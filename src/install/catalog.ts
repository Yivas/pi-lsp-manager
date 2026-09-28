import type { ServerAdmission } from "../contracts.js";
import vueLockfile from "./locks/vue-3.3.11.json" with { type: "json" };

export interface PackagePin {
	name: string;
	version: string;
	integrity: string;
	license: string;
	node: string;
}

export interface InstallTarget {
	platform: NodeJS.Platform;
	architecture: NodeJS.Architecture;
}

export interface InstallRecipe {
	serverId: string;
	revision: string;
	targets: readonly InstallTarget[];
	registry: "https://registry.npmjs.org";
	packages: readonly PackagePin[];
	executable: "typescript-language-server" | "vue-language-server";
	expectedVersion: "5.3.0" | "3.3.11";
	lockfile?: Readonly<{
		name: string;
		version: string;
		lockfileVersion: number;
		requires: boolean;
		packages: Readonly<Record<string, unknown>>;
	}>;
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
	targets: [
		{ platform: "win32", architecture: "x64" },
		{ platform: "darwin", architecture: "arm64" },
		{ platform: "linux", architecture: "x64" },
	],
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

export const VUE_RECIPE = deepFreeze<InstallRecipe>({
	serverId: "vue",
	revision:
		"vue-language-server-3.3.11_ts-plugin-3.3.11_typescript-5.9.3_vue-3.5.43_lock-1",
	targets: [
		{ platform: "win32", architecture: "x64" },
		{ platform: "darwin", architecture: "arm64" },
		{ platform: "linux", architecture: "x64" },
	],
	registry: "https://registry.npmjs.org",
	packages: [
		{
			name: "@vue/language-server",
			version: "3.3.11",
			integrity:
				"sha512-5QvJ3bkUTyuRE7R4l0R+6Xl7Cq7INd95Hxm6bz3J0k9v+TjwKJKlnVeaW9X0fxTVrkcVBpSIKLQpAMlIOXeI9w==",
			license: "MIT",
			node: "*",
		},
		{
			name: "@vue/typescript-plugin",
			version: "3.3.11",
			integrity:
				"sha512-sTfyjuZuAClToH59lcBxNMWF+Ede6IBUiYEZI1MgL3Bf9sWV15mtv9P2dfL+4moSQjRf+17O7HX+a8JQdXhLYA==",
			license: "MIT",
			node: "*",
		},
		{
			name: "typescript",
			version: "5.9.3",
			integrity:
				"sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==",
			license: "Apache-2.0",
			node: ">=14.17",
		},
		{
			name: "vue",
			version: "3.5.43",
			integrity:
				"sha512-o5qZoksdnjIKvW1srZ3ab7pcDNYAerBjRe54D0LBLfRdCYFrSgBHVXokMas35czQc0//lmx4/tuY4ZNQ+Rf2Ng==",
			license: "MIT",
			node: "*",
		},
	],
	lockfile: vueLockfile,
	executable: "vue-language-server",
	expectedVersion: "3.3.11",
	admission: "auto-installable",
	manualHelp:
		"Install Vue Language Server 3.3.11, its TypeScript plugin 3.3.11, TypeScript 5.9.3 and Vue 3.5.43 together, then retry.",
});

// Vue remains inactive until the real installation and cross-platform gates pass.
const RECIPES = deepFreeze<Record<string, InstallRecipe>>({
	typescript: TYPESCRIPT_RECIPE,
});

export function getRecipe(serverId: string): InstallRecipe | undefined {
	return RECIPES[serverId];
}

export function getRecipeRevision(serverId: string): string | undefined {
	return getRecipe(serverId)?.revision;
}
