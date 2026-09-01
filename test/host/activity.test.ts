import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	LSP_ACTIVITY_STATUS_KEY,
	LspActivity,
} from "../../src/host/activity.js";

function context(hasUI = true) {
	const setStatus = vi.fn();
	return {
		hasUI,
		ui: { setStatus },
	} as unknown as ExtensionContext & { ui: { setStatus: typeof setStatus } };
}

describe("LSP activity", () => {
	it("keeps one generic status for overlapping operations", () => {
		const activity = new LspActivity();
		const ctx = context();
		activity.start("one", ctx);
		activity.start("two", ctx);
		activity.end("one", ctx);
		expect(activity.activeCount).toBe(1);
		expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
		activity.end("two", ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
			LSP_ACTIVITY_STATUS_KEY,
			undefined,
		);
	});

	it("ignores duplicate completion and non-UI contexts", () => {
		const activity = new LspActivity();
		const ctx = context(false);
		activity.start("one", ctx);
		activity.end("one", ctx);
		activity.end("one", ctx);
		expect(activity.activeCount).toBe(0);
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
	});

	it("shows status when a UI operation overlaps earlier headless work", () => {
		const activity = new LspActivity();
		const headless = context(false);
		const interactive = context();
		activity.start("headless", headless);
		activity.start("interactive", interactive);
		expect(interactive.ui.setStatus).toHaveBeenCalledWith(
			LSP_ACTIVITY_STATUS_KEY,
			"LSP working",
		);
		activity.end("headless", headless);
		activity.end("interactive", interactive);
		expect(interactive.ui.setStatus).toHaveBeenLastCalledWith(
			LSP_ACTIVITY_STATUS_KEY,
			undefined,
		);
	});

	it("clears active work on shutdown", () => {
		const activity = new LspActivity();
		const ctx = context();
		activity.start("one", ctx);
		activity.clear(ctx);
		expect(activity.activeCount).toBe(0);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
			LSP_ACTIVITY_STATUS_KEY,
			undefined,
		);
	});
});
