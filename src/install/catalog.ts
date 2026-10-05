import type { ServerAdmission } from "../contracts.js";
import pythonWheelLock from "./locks/python-wheels.json" with { type: "json" };
import vueLockfile from "./locks/vue-3.3.11.json" with { type: "json" };
import jsonLanguageServerLockfile from "./locks/vscode-langservers-extracted-4.10.0.json" with {
	type: "json",
};
import yamlLockfile from "./locks/yaml-language-server-1.24.0.json" with {
	type: "json",
};

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

export interface NpmInstallRecipe {
	kind: "npm";
	serverId: string;
	revision: string;
	targets: readonly InstallTarget[];
	registry: "https://registry.npmjs.org";
	packages: readonly PackagePin[];
	executable:
		| "typescript-language-server"
		| "vue-language-server"
		| "yaml-language-server"
		| "vscode-json-language-server";
	expectedVersion: "5.3.0" | "3.3.11" | "1.24.0" | "4.10.0";
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

/** One wheel of the frozen Python lock. pip receives exactly one of these per installation. */
export interface PythonWheelEntry {
	platform: NodeJS.Platform;
	architecture: NodeJS.Architecture;
	url: string;
	sha256: string;
}

/**
 * A Python recipe installs one wheel with a direct URL and its own hash into the managed
 * staging directory. It is inactive until the activation gate admits it.
 */
export interface PythonInstallRecipe {
	kind: "python";
	serverId: string;
	revision: string;
	targets: readonly InstallTarget[];
	entries: readonly PythonWheelEntry[];
	executable: string;
	expectedVersion: string;
	admission: Extract<ServerAdmission, "auto-installable">;
	manualHelp: string;
}

export type InstallRecipe = NpmInstallRecipe | PythonInstallRecipe;

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child);
		}
	}
	return value;
}

const TYPESCRIPT_RECIPE = deepFreeze<NpmInstallRecipe>({
	kind: "npm",
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

export const VUE_RECIPE = deepFreeze<NpmInstallRecipe>({
	kind: "npm",
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

const PLATFORMS: readonly NodeJS.Platform[] = [
	"aix",
	"darwin",
	"freebsd",
	"linux",
	"openbsd",
	"sunos",
	"win32",
];
const ARCHITECTURES: readonly NodeJS.Architecture[] = [
	"arm",
	"arm64",
	"ia32",
	"loong64",
	"mips",
	"mipsel",
	"ppc64",
	"riscv64",
	"s390x",
	"x64",
];

function isPlatform(value: string): value is NodeJS.Platform {
	return PLATFORMS.includes(value as NodeJS.Platform);
}

function isArchitecture(value: string): value is NodeJS.Architecture {
	return ARCHITECTURES.includes(value as NodeJS.Architecture);
}

/**
 * Reads the frozen Python lock. The URL must be the canonical `files.pythonhosted.org`
 * wheel and the hash a full SHA-256, so a lock edit cannot smuggle another host or a
 * truncated digest into the requirements file.
 */
function projectPythonEntries(
	serverId: keyof typeof pythonWheelLock.servers,
): readonly PythonWheelEntry[] {
	return pythonWheelLock.servers[serverId].map((entry) => {
		// Validate the raw string that is later emitted, not the parsed path: the WHATWG
		// parser resolves percent-encoded dot segments out of `pathname`, so a `%` guard on
		// it would miss `%2e%2e`/`%2e`/`%2E%2E`. The frozen official URLs are canonical and
		// contain no `%`, backslash or NUL, so rejecting them cannot refuse a real wheel.
		if (
			entry.url.includes("%") ||
			entry.url.includes("\\") ||
			entry.url.includes("\0")
		) {
			throw new Error("Python wheel lock contains an unpinned wheel.");
		}
		let url: URL;
		try {
			url = new URL(entry.url);
		} catch {
			throw new Error("Python wheel lock contains an invalid URL.");
		}
		const path = url.pathname;
		if (
			url.protocol !== "https:" ||
			url.hostname !== "files.pythonhosted.org" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			path.includes("//") ||
			!path.endsWith(".whl") ||
			!isPlatform(entry.platform) ||
			!isArchitecture(entry.architecture) ||
			!/^[0-9a-f]{64}$/.test(entry.sha256)
		) {
			throw new Error("Python wheel lock contains an unpinned wheel.");
		}
		return {
			platform: entry.platform,
			architecture: entry.architecture,
			url: entry.url,
			sha256: entry.sha256,
		};
	});
}

function pythonRecipe(
	serverId: "ty" | "ruff",
	executable: string,
	expectedVersion: string,
	manualHelp: string,
): PythonInstallRecipe {
	const entries = projectPythonEntries(serverId);
	return {
		kind: "python",
		serverId,
		revision: `${serverId}-${expectedVersion}_${pythonWheelLock.revision}`,
		targets: entries.map(({ platform, architecture }) => ({
			platform,
			architecture,
		})),
		entries,
		executable,
		expectedVersion,
		admission: "auto-installable",
		manualHelp,
	};
}

/**
 * Python recipes stay out of `RECIPES` until the activation gate admits them. They are
 * exported so the deterministic suite can exercise the adapter with an injected decision,
 * while the real policy keeps answering `recipe_missing` for `ty` and `ruff`.
 */
export const INACTIVE_PYTHON_RECIPES = deepFreeze<
	Record<"ty" | "ruff", PythonInstallRecipe>
>({
	ty: pythonRecipe(
		"ty",
		"ty",
		"0.0.84",
		"Install ty 0.0.84 manually, set the trusted installer interpreter, then retry.",
	),
	ruff: pythonRecipe(
		"ruff",
		"ruff",
		"0.16.9",
		"Install ruff 0.16.9 manually, set the trusted installer interpreter, then retry.",
	),
});

export const INACTIVE_FORMAT_RECIPES = deepFreeze<
	Record<
		"vscode-json-language-server" | "yaml-language-server",
		NpmInstallRecipe
	>
>({
	"vscode-json-language-server": {
		kind: "npm",
		serverId: "vscode-json-language-server",
		revision: "vscode-langservers-extracted-4.10.0_core-js-3.50.0_lock-1",
		targets: [
			{ platform: "win32", architecture: "x64" },
			{ platform: "darwin", architecture: "arm64" },
			{ platform: "linux", architecture: "x64" },
		],
		registry: "https://registry.npmjs.org",
		packages: [
			{
				name: "vscode-langservers-extracted",
				version: "4.10.0",
				integrity:
					"sha512-EFf9uQI4dAKbzMQFjDvVm1xJq1DXAQvBEuEfPGrK/xzfsL5xWTfIuRr90NgfmqwO+IEt6vLZm9EOj6R66xIifg==",
				license: "MIT",
				node: "*",
			},
		],
		lockfile: jsonLanguageServerLockfile,
		executable: "vscode-json-language-server",
		expectedVersion: "4.10.0",
		admission: "auto-installable",
		manualHelp:
			"Install vscode-langservers-extracted 4.10.0 manually, then retry.",
	},
	"yaml-language-server": {
		kind: "npm",
		serverId: "yaml-language-server",
		revision: "yaml-language-server-1.24.0_lock-1",
		targets: [
			{ platform: "win32", architecture: "x64" },
			{ platform: "darwin", architecture: "arm64" },
			{ platform: "linux", architecture: "x64" },
		],
		registry: "https://registry.npmjs.org",
		packages: [
			{
				name: "yaml-language-server",
				version: "1.24.0",
				integrity:
					"sha512-+HGcwu4M7IC+UDhDZScTZR8qsl2MMj/X1E5e83QcWzWn2pctj0fv8HHdrHHcbc1KB3CuRPJ4gc1Nm36D0iCu0g==",
				license: "MIT",
				node: "*",
			},
		],
		lockfile: yamlLockfile,
		executable: "yaml-language-server",
		expectedVersion: "1.24.0",
		admission: "auto-installable",
		manualHelp: "Install YAML Language Server 1.24.0 manually, then retry.",
	},
});

/** Selects the single wheel pip receives for a host platform and architecture. */
export function selectPythonEntry(
	recipe: PythonInstallRecipe,
	platform: NodeJS.Platform,
	architecture: NodeJS.Architecture,
): PythonWheelEntry | undefined {
	return recipe.entries.find(
		(entry) =>
			entry.platform === platform && entry.architecture === architecture,
	);
}

const RECIPES = deepFreeze<Record<string, NpmInstallRecipe>>({
	typescript: TYPESCRIPT_RECIPE,
	vue: VUE_RECIPE,
});

export function getRecipe(serverId: string): InstallRecipe | undefined {
	return RECIPES[serverId];
}

export function getRecipeRevision(serverId: string): string | undefined {
	return getRecipe(serverId)?.revision;
}
