export type RetryOperation =
	| "diagnostics"
	| "definition"
	| "references"
	| "symbols"
	| "prepareRename"
	| "codeActionsPreview"
	| "rename"
	| "applyCodeAction";

/** Only failures proving that the owned transport/process disappeared are retryable. */
export class TransientRuntimeError extends Error {
	public constructor(message = "runtime_transport_lost") {
		super(message);
		this.name = "TransientRuntimeError";
	}
}

export function mayRetry(operation: RetryOperation): boolean {
	return [
		"diagnostics",
		"definition",
		"references",
		"symbols",
		"prepareRename",
		"codeActionsPreview",
	].includes(operation);
}

export async function retryOnce<T>(
	operation: RetryOperation,
	work: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (
			!mayRetry(operation) ||
			signal?.aborted ||
			!(error instanceof TransientRuntimeError)
		)
			throw error;
		return work();
	}
}
