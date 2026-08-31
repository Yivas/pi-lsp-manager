const MINIMUM_NODE_VERSION = [22, 19, 0] as const;

export function meetsMinimumNodeVersion(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.replace(/^v/, ""));
	if (!match) {
		return false;
	}
	const parsed = match.slice(1).map(Number);
	for (const [index, minimum] of MINIMUM_NODE_VERSION.entries()) {
		const part = parsed[index] ?? 0;
		if (part !== minimum) {
			return part > minimum;
		}
	}
	return true;
}
