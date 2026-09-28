import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ServerLaunch } from "./launch.js";

export interface VuePackages {
	typescriptServer: string;
	pluginRoot: string;
}

export class VueIntegrationUnavailableError extends Error {
	public constructor() {
		super("Vue TypeScript integration unavailable.");
		this.name = "VueIntegrationUnavailableError";
	}
}

function inside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return (
		path === "" ||
		(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	);
}

/** Requires the pinned Vue server, plugin and TypeScript SDK in one installation root. */
export async function resolveVuePackages(
	launch: ServerLaunch,
	executablePath?: string,
): Promise<VuePackages | undefined> {
	const script = launch.args.find((arg) =>
		arg
			.replaceAll("\\", "/")
			.endsWith("/@vue/language-server/bin/vue-language-server.js"),
	);
	const path =
		executablePath &&
		/^vue-language-server(?:\.cmd|\.bat)?$/i.test(basename(executablePath))
			? executablePath
			: (script ?? launch.command);
	let modules: string;
	if (basename(dirname(path)) === ".bin") {
		modules = dirname(dirname(path));
	} else {
		const match = path.replaceAll("\\", "/").lastIndexOf("/node_modules/");
		if (match < 0) return undefined;
		modules = path.slice(0, match + "/node_modules".length);
	}
	try {
		const root = await realpath(modules);
		const server = join(root, "@vue", "language-server", "package.json");
		const plugin = join(root, "@vue", "typescript-plugin", "package.json");
		const typescript = join(root, "typescript", "package.json");
		const typescriptServer = join(root, "typescript", "lib", "tsserver.js");
		for (const file of [server, plugin, typescript, typescriptServer]) {
			const actual = await realpath(file);
			if (!inside(root, actual) || !(await stat(actual)).isFile())
				return undefined;
		}
		const versions = await Promise.all(
			[server, plugin, typescript].map(
				async (file) =>
					(JSON.parse(await readFile(file, "utf8")) as { version?: string })
						.version,
			),
		);
		if (
			versions[0] !== "3.3.11" ||
			versions[1] !== "3.3.11" ||
			versions[2] !== "5.9.3"
		)
			return undefined;
		return { typescriptServer, pluginRoot: root };
	} catch {
		return undefined;
	}
}
