import type { LspConnection } from "./connection.js";

export interface Diagnostic {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	message: string;
	severity?: number;
	source?: string;
	code?: string | number;
}
export interface DiagnosticOptions {
	pushDiagnosticsGraceMs: number;
	diagnosticsSettleMs: number;
	pullDiagnosticsGraceMs: number;
	maxUris?: number;
	maxUriLength?: number;
	maxDiagnosticsPerUri?: number;
}
export interface DiagnosticTiming {
	now?: () => number;
	sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}
interface PublishedDiagnostics {
	version: number | undefined;
	diagnostics: readonly Diagnostic[];
	at: number;
	generation: number;
}
const DEFAULT_MAX_URIS = 256;
const DEFAULT_MAX_URI_LENGTH = 4_096;
const DEFAULT_MAX_DIAGNOSTICS = 1_000;
function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
function normalize(
	diagnostics: Diagnostic[],
	max: number,
): readonly Diagnostic[] {
	const seen = new Set<string>();
	const normalized: Diagnostic[] = [];
	for (const diagnostic of diagnostics) {
		if (normalized.length >= max) break;
		const key = JSON.stringify(diagnostic);
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(diagnostic);
	}
	return normalized;
}

export class DiagnosticCollector {
	private readonly published = new Map<string, PublishedDiagnostics>();
	private readonly now: () => number;
	private readonly sleep: (
		milliseconds: number,
		signal?: AbortSignal,
	) => Promise<void>;
	private generation = 0;
	private readonly maxUris: number;
	private readonly maxUriLength: number;
	private readonly maxDiagnostics: number;

	public constructor(
		private readonly connection: LspConnection,
		private readonly options: DiagnosticOptions,
		timing: DiagnosticTiming = {},
	) {
		this.now = timing.now ?? Date.now;
		this.sleep = timing.sleep ?? sleep;
		this.maxUris = options.maxUris ?? DEFAULT_MAX_URIS;
		this.maxUriLength = options.maxUriLength ?? DEFAULT_MAX_URI_LENGTH;
		this.maxDiagnostics =
			options.maxDiagnosticsPerUri ?? DEFAULT_MAX_DIAGNOSTICS;
		connection.onNotification("textDocument/publishDiagnostics", (params) => {
			const value = params as {
				uri?: string;
				version?: number;
				diagnostics?: Diagnostic[];
			};
			if (
				!value.uri ||
				value.uri.length > this.maxUriLength ||
				!Array.isArray(value.diagnostics)
			)
				return;
			const current = this.published.get(value.uri);
			// Versioned publications never regress. Unversioned messages are tracked by
			// receive generation instead of pretending they belong to version zero.
			if (
				current &&
				value.version !== undefined &&
				current.version !== undefined &&
				value.version < current.version
			)
				return;
			if (!current && this.published.size >= this.maxUris)
				this.published.delete(this.published.keys().next().value as string);
			this.published.set(value.uri, {
				version: value.version,
				diagnostics: normalize(value.diagnostics, this.maxDiagnostics),
				at: this.now(),
				generation: ++this.generation,
			});
		});
	}

	private eligible(
		uri: string,
		version: number,
		minimumGeneration: number,
	): PublishedDiagnostics | undefined {
		const published = this.published.get(uri);
		if (!published) return undefined;
		if (published.version !== undefined)
			return published.version >= version ? published : undefined;
		return published.generation > minimumGeneration ? published : undefined;
	}

	private async waitForPush(
		uri: string,
		version: number,
		graceMs: number,
		minimumGeneration: number,
		signal?: AbortSignal,
	): Promise<PublishedDiagnostics | undefined> {
		const started = this.now();
		for (;;) {
			if (signal?.aborted) return undefined;
			const current = this.eligible(uri, version, minimumGeneration);
			if (
				current &&
				(current.diagnostics.length === 0
					? this.now() - started >= graceMs
					: this.now() - current.at >= this.options.diagnosticsSettleMs)
			)
				return current;
			if (this.now() - started >= graceMs)
				return this.eligible(uri, version, minimumGeneration);
			await this.sleep(
				Math.min(10, Math.max(1, graceMs - (this.now() - started))),
				signal,
			);
		}
	}

	public async collect(
		uri: string,
		version: number,
		supportsPull: boolean,
		signal?: AbortSignal,
	): Promise<
		| { ok: true; diagnostics: readonly Diagnostic[] }
		| { ok: false; code: string }
	> {
		const generation = this.generation;
		if (supportsPull) {
			const pull = await this.connection.request<{ items?: Diagnostic[] }>(
				"textDocument/diagnostic",
				{ textDocument: { uri } },
				signal,
			);
			if (!pull.ok) return { ok: false, code: pull.code };
			const pullDiagnostics = normalize(
				pull.value.items ?? [],
				this.maxDiagnostics,
			);
			// A nonempty pull result is authoritative and needs no push grace delay.
			if (pullDiagnostics.length > 0)
				return { ok: true, diagnostics: pullDiagnostics };
			const pushed = await this.waitForPush(
				uri,
				version,
				this.options.pullDiagnosticsGraceMs,
				generation,
				signal,
			);
			if (signal?.aborted) return { ok: false, code: "cancelled" };
			return {
				ok: true,
				diagnostics: pushed?.diagnostics ?? pullDiagnostics,
			};
		}
		const pushed = await this.waitForPush(
			uri,
			version,
			this.options.pushDiagnosticsGraceMs,
			generation,
			signal,
		);
		if (signal?.aborted) return { ok: false, code: "cancelled" };
		return pushed
			? { ok: true, diagnostics: pushed.diagnostics }
			: { ok: false, code: "diagnostics_timed_out" };
	}
}
