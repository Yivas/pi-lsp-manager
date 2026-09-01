import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ToolError } from "./shared.js";

const MAX_TEXT = 12_000;
const MAX_ITEMS = 100;

export function bounded<T>(
	values: readonly T[],
	limit = MAX_ITEMS,
): readonly T[] {
	return values.slice(0, Math.max(1, Math.min(limit, MAX_ITEMS)));
}

export function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function stable<T>(
	values: readonly T[],
	key: (value: T) => string,
): readonly T[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const valueKey = key(value);
		if (seen.has(valueKey)) return false;
		seen.add(valueKey);
		return true;
	});
}

function clean(value: string): string {
	let result = value;
	for (const privateRoot of [process.env.HOME, process.env.USERPROFILE]) {
		if (privateRoot) result = result.replaceAll(privateRoot, "<path>");
	}
	return result
		.replaceAll(/file:\/\/[^\s"',}\]]+/gi, "<path>")
		.replaceAll(/\\\\[^\\\s"',}\]]+\\[^\s"',}\]]+/g, "<path>")
		.replaceAll(/[A-Za-z]:[\\/][^\s"',}\]]+/g, "<path>")
		.replaceAll(/(^|[\s("'])\/(?:[^/\s"',}\]]+\/?)+/g, "$1<path>")
		.replaceAll(/[\r\n]+/g, " ");
}

function sanitize(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return clean(value);
	if (value === null || typeof value !== "object") return value;
	if (depth >= 8) return "<truncated>";
	if (Array.isArray(value))
		return value.map((item) => sanitize(item, depth + 1));
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			clean(key),
			sanitize(item, depth + 1),
		]),
	);
}

export function success(
	value: unknown,
): AgentToolResult<{ code: "ok"; truncated?: true }> {
	let text = JSON.stringify(sanitize(value));
	let truncated = false;
	if (text.length > MAX_TEXT) {
		truncated = true;
		text = JSON.stringify({
			truncated: true,
			preview: text.slice(0, Math.floor(MAX_TEXT / 3)),
		});
	}
	return {
		content: [{ type: "text", text }],
		details: { code: "ok", ...(truncated ? { truncated: true as const } : {}) },
	};
}

export function failure(
	error: ToolError,
): AgentToolResult<{ code: string; action: string }> {
	return {
		content: [{ type: "text", text: `${error.code}: ${clean(error.action)}` }],
		details: { code: error.code, action: clean(error.action) },
	} as AgentToolResult<{ code: string; action: string }>;
}

export function relativeLocation(
	uri: string,
	rootUri: string,
	position: { line: number; character: number },
): { path: string; line: number; character: number } {
	let path = uri;
	try {
		const url = new URL(uri);
		const root = new URL(rootUri);
		const sameAuthority =
			url.protocol === root.protocol &&
			url.username === root.username &&
			url.password === root.password &&
			url.hostname.toLowerCase() === root.hostname.toLowerCase() &&
			url.port === root.port;
		path =
			sameAuthority && url.pathname.startsWith(root.pathname)
				? decodeURIComponent(url.pathname.slice(root.pathname.length)).replace(
						/^\//,
						"",
					)
				: "<external>";
	} catch {
		path = "<external>";
	}
	return {
		path: path || ".",
		line: position.line + 1,
		character: position.character,
	};
}
