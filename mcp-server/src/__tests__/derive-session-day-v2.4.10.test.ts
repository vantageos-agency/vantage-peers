// Unit tests for deriveSessionDay (A.7 helper).
// Eta minor PR #571 capitalize: "pure function begging for it".
//
// Anchor: VP Day 1 = 2026-03-06 UTC. Day 88 = 2026-06-01 UTC (Pi anchor memory
// k178tqgzhbhzg1h4vbgn4kwdm987vntn).
//
// All assertions use explicit Date.UTC(...) timestamps — no Date.now() in the
// test body, so the suite is hermetic and time-frozen.

import { describe, expect, test } from "bun:test";
import { deriveSessionDay } from "../tools";

describe("deriveSessionDay (A.7)", () => {
	test("returns 1 at the epoch (2026-03-06 00:00:00 UTC)", () => {
		const epoch = Date.UTC(2026, 2, 6); // March 6 2026 UTC
		expect(deriveSessionDay(epoch)).toBe(1);
	});

	test("returns 1 at the very end of Day 1 (2026-03-06 23:59:59.999 UTC)", () => {
		const endOfDay1 = Date.UTC(2026, 2, 6, 23, 59, 59, 999);
		expect(deriveSessionDay(endOfDay1)).toBe(1);
	});

	test("returns 2 at the start of Day 2 (2026-03-07 00:00:00 UTC)", () => {
		const startOfDay2 = Date.UTC(2026, 2, 7);
		expect(deriveSessionDay(startOfDay2)).toBe(2);
	});

	test("returns 88 on 2026-06-01 UTC (Pi anchor Day 88)", () => {
		const day88 = Date.UTC(2026, 5, 1); // June 1 2026 UTC
		expect(deriveSessionDay(day88)).toBe(88);
	});

	test("returns 88 at the very end of Day 88 (2026-06-01 23:59:59.999 UTC)", () => {
		const endOfDay88 = Date.UTC(2026, 5, 1, 23, 59, 59, 999);
		expect(deriveSessionDay(endOfDay88)).toBe(88);
	});

	test("returns 89 at the start of Day 89 (2026-06-02 00:00:00 UTC)", () => {
		const startOfDay89 = Date.UTC(2026, 5, 2);
		expect(deriveSessionDay(startOfDay89)).toBe(89);
	});

	test("clamps to 1 for timestamps before the epoch (defensive Math.max)", () => {
		const beforeEpoch = Date.UTC(2026, 2, 5, 12, 0, 0); // 12h before Day 1
		expect(deriveSessionDay(beforeEpoch)).toBe(1);
		const wayBefore = Date.UTC(2025, 0, 1); // a full year before
		expect(deriveSessionDay(wayBefore)).toBe(1);
		expect(deriveSessionDay(0)).toBe(1); // Unix epoch
	});

	test("increments by 1 per UTC day across a multi-day span", () => {
		// Day 1 .. Day 10, walk one day at a time.
		const MS_PER_DAY = 86_400_000;
		const epoch = Date.UTC(2026, 2, 6);
		for (let i = 0; i < 10; i++) {
			expect(deriveSessionDay(epoch + i * MS_PER_DAY)).toBe(i + 1);
		}
	});

	test("default argument resolves to Date.now() (smoke — bound check only)", () => {
		// Cannot assert exact value without freezing time, but the result must be
		// a positive integer ≥ 1. Day 88 was 2026-06-01; tests run on or after.
		const day = deriveSessionDay();
		expect(Number.isInteger(day)).toBe(true);
		expect(day).toBeGreaterThanOrEqual(1);
	});
});
