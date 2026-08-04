import { describe, expect, it } from "vitest";
import { renderPendingOnYouBlock } from "../src/renderPendingOnYou.js";

describe("renderPendingOnYouBlock — deploy-skew tolerance (hotfix/check-messages-envelope-skew)", () => {
	it("does not throw on a skew/old envelope missing the new fields, returns a graceful string", () => {
		const oldEnvelope = {
			messages: [],
			truncated: false,
			nextSince: null,
		};
		expect(() => renderPendingOnYouBlock(oldEnvelope)).not.toThrow();
		expect(renderPendingOnYouBlock(oldEnvelope)).toBe("");
	});

	it("renders the summary for a new envelope with totals + top-N capped list", () => {
		const top = Array.from({ length: 10 }, (_, i) => ({
			taskId: `k${i}`,
			title: `Task ${i}`,
			assignee: "sigma",
			age: i,
			cyclesWaiting: 10 - i,
			slaBreached: true,
		}));
		const newEnvelope = {
			pendingOnYouTotal: 12,
			slaBreachedTotal: 12,
			slaBreachedTop: top,
		};
		const block = renderPendingOnYouBlock(newEnvelope);
		expect(block).toContain("12 total");
		expect(block).toContain("top 10 shown");
		expect(block).toContain("(+2 more not shown)");
	});

	it("returns '' for an empty new envelope", () => {
		const emptyEnvelope = {
			pendingOnYouTotal: 0,
			slaBreachedTotal: 0,
			slaBreachedTop: [],
		};
		expect(renderPendingOnYouBlock(emptyEnvelope)).toBe("");
	});
});
