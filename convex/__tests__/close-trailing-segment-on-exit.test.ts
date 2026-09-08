/// <reference types="vite/client" />
/**
 * The derivation every exit site now depends on, tested directly.
 *
 * The sibling suite asserts that each site CALLS this function. That leaves the
 * function itself uncovered: mutating it — returning only the closed segment
 * instead of slicing the history, or dropping the same-status guard — left the
 * whole suite green while destroying prior segments on every non-done exit.
 */

import { describe, expect, test } from "vitest";
import { closeTrailingSegmentOnExit } from "../lib/taskClosureGate";

const NOW = 5_000_000;

describe("closeTrailingSegmentOnExit", () => {
	test("history is preserved: three segments in, three out, the first two untouched", () => {
		const earlier = [
			{ start: 100, end: 200 },
			{ start: 300, end: 400 },
			{ start: 500 },
		];

		const closed = closeTrailingSegmentOnExit(
			{ workSegments: earlier },
			"in_progress",
			"todo",
			NOW,
		);

		expect(closed).toEqual([
			{ start: 100, end: 200 },
			{ start: 300, end: 400 },
			{ start: 500, end: NOW },
		]);
		// Returning only the closed segment would satisfy "the trailing one is
		// closed" and silently drop every minute worked before it.
		expect(closed).toHaveLength(3);
	});

	test("staying in_progress closes nothing", () => {
		expect(
			closeTrailingSegmentOnExit(
				{ workSegments: [{ start: 500 }] },
				"in_progress",
				"in_progress",
				NOW,
			),
		).toBeUndefined();
	});

	test("a row with no segments has nothing to close", () => {
		expect(
			closeTrailingSegmentOnExit({}, "in_progress", "todo", NOW),
		).toBeUndefined();
		expect(
			closeTrailingSegmentOnExit(
				{ workSegments: [] },
				"in_progress",
				"todo",
				NOW,
			),
		).toBeUndefined();
	});

	test("an already-closed trailing segment is not reopened or re-stamped", () => {
		expect(
			closeTrailingSegmentOnExit(
				{ workSegments: [{ start: 100, end: 200 }] },
				"in_progress",
				"todo",
				NOW,
			),
		).toBeUndefined();
	});

	test("a row that was not in_progress is left alone", () => {
		expect(
			closeTrailingSegmentOnExit(
				{ workSegments: [{ start: 500 }] },
				"todo",
				"cancelled",
				NOW,
			),
		).toBeUndefined();
	});

	test("the input array is not mutated", () => {
		const segments = [{ start: 500 }];
		closeTrailingSegmentOnExit({ workSegments: segments }, "in_progress", "todo", NOW);
		expect(segments).toEqual([{ start: 500 }]);
	});
});
