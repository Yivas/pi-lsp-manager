const MAX_OUTPUT_LENGTH = 4_096;
const MAX_RAW_LENGTH = 8_192;
const MAX_CHUNK_LENGTH = 8_192;
const PRIVATE_PATH =
	/(?:[A-Z]:\\Users\\[^\\\s]+|\/(?:home|Users)\/[^/\s]+)(?:[^\s]*)?/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s@/:]+(?::[^\s@/]*)?@/gi;
const BEARER = /\b(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const SECRET_ASSIGNMENT =
	/\b(?:[a-z0-9_-]*?(?:authorization|token|password|secret|api[_-]?key|proxy)[a-z0-9_-]*)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const JSON_SECRET =
	/("(?:authorization|token|password|secret|api[_-]?key|proxy)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

function stripControlCharacters(value: string): string {
	return [...value]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code === 9 || code >= 32;
		})
		.join("");
}

export function truncateOutput(
	value: string,
	limit = MAX_OUTPUT_LENGTH,
): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`;
}

export function sanitizeText(value: string, limit = MAX_OUTPUT_LENGTH): string {
	return truncateOutput(
		stripControlCharacters(value)
			.replace(URL_CREDENTIALS, "$1[redacted]@")
			.replace(BEARER, "[redacted]")
			.replace(JSON_SECRET, '$1"[redacted]"')
			.replace(SECRET_ASSIGNMENT, (match) => {
				const separator = match.includes(":") ? ":" : "=";
				return `${match.split(/[=:]/, 1)[0]}${separator}[redacted]`;
			})
			.replace(PRIVATE_PATH, "[private-path]"),
		limit,
	);
}

/** Bounded raw collector: it retains at most 8 KiB before a single sanitization pass. */
export class BoundedSanitizedOutput {
	private raw = "";
	private dropped = false;

	public append(chunk: string): void {
		const available = Math.max(0, MAX_RAW_LENGTH - this.raw.length);
		const boundedChunk = chunk.slice(0, Math.min(MAX_CHUNK_LENGTH, available));
		if (boundedChunk.length < chunk.length) this.dropped = true;
		this.raw += boundedChunk;
	}

	public value(): string {
		const prefix = this.dropped ? "[output-truncated] " : "";
		return sanitizeText(`${prefix}${this.raw}`);
	}
}

export function sanitizedFailure(
	phase: string,
	kind: string,
	exitCode?: number,
): { phase: string; kind: string; exitCode?: number } {
	return exitCode === undefined ? { phase, kind } : { phase, kind, exitCode };
}
