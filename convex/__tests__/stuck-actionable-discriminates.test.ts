/// <reference types="vite/client" />
/**
 * The stuck-list obligation cannot key on "the list is non-empty" — that
 * list is populated on every cycle where anyone is working (any-age design,
 * proven by stale-age-from-open-segment.test.ts, which this file does not
 * touch). The obligation instead keys on a derived count of entries that
 * satisfy BOTH an age-past-threshold condition AND "no open segment behind
 * the in_progress status" — an OPEN segment means someone is actively on
 * the task right now and must never count, however long it has run; a
 * closed trailing segment or a row that never started is the failure this
 * obligation exists to catch. See stuck-actionable-inverted.test.ts for the
 * full RED/GREEN story on that polarity, including the never-started and
 * closed-trailing-segment cases this file only partially covers.
 *
 * Both stuck signals (stuckInProgress, peersStuckOnYou) share the same
 * discriminator, so both get their own case here — a fix proven on one
 * call site says nothing about the other (this repo has already shipped
 * that exact gap twice).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedThreshold(t: any, ms: number) {
	await t.run(async (ctx: any) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "stuckActionableThresholdMs",
			value: [String(ms)],
			updatedAt: Date.now(),
		});
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seed(
	t: any,
	opts: {
		assignedTo: string;
		createdBy: string;
		title: string;
		startedAtAgeMs: number;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		workSegments?: any[];
	},
): Promise<string> {
	const startedAt = Date.now() - opts.startedAtAgeMs;
	return await t.run(async (ctx: any) => {
		return await ctx.db.insert("tasks", {
			title: opts.title,
			assignedTo: opts.assignedTo,
			priority: "medium" as const,
			status: "in_progress" as const,
			startedAt,
			createdBy: opts.createdBy,
			createdAt: startedAt,
			updatedAt: startedAt,
			...(opts.workSegments ? { workSegments: opts.workSegments } : {}),
		});
	});
}

describe("stuck-list obligation discriminates on age-past-threshold AND open-segment", () => {
	test("stuckInProgress: open segment seconds old, however old the first start -> NOT actionable, still LISTED", async () => {
		const t = convexTest(schema, modules);
		await seedThreshold(t, 10 * MINUTE);
		const now = Date.now();
		const taskId = await seed(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "resumed just now, first start was hours ago",
			startedAtAgeMs: 5 * HOUR,
			workSegments: [
				{ start: now - 5 * HOUR, end: now - 5 * HOUR + 4 * MINUTE },
				{ start: now - 10 * 1000 },
			],
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		// The guard this work must not break: the list still contains it.
		expect(result.stuckInProgress.entries).toHaveLength(1);
		expect(result.stuckInProgress.entries[0].taskId).toBe(taskId);
		// The new discrimination: this entry does not make the obligation fire.
		expect(result.stuckInProgress.actionableStuckCount).toBe(0);
	});

	test("peersStuckOnYou: row created moments ago (no segments) -> NOT actionable, still LISTED", async () => {
		const t = convexTest(schema, modules);
		await seedThreshold(t, 10 * MINUTE);
		const taskId = await seed(t, {
			assignedTo: "eta",
			createdBy: "sigma",
			title: "just created, no segments yet",
			startedAtAgeMs: 5 * 1000,
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.peersStuckOnYou.entries).toHaveLength(1);
		expect(result.peersStuckOnYou.entries[0].taskId).toBe(taskId);
		expect(result.peersStuckOnYou.actionableStuckCount).toBe(0);
	});

	// Rewritten: the predicate inverted (isActionableStuck now requires the
	// ABSENCE of an open segment, not its presence — a status that claims
	// work is underway with nothing backing that claim is the failure this
	// obligation exists to catch). A closed trailing segment past the
	// threshold is exactly that shape, so the expected count flips from 0 to
	// 1; the behaviour under test changed, not just the assertion.
	test("stuckInProgress: last segment is CLOSED, however old -> ACTIONABLE, still LISTED", async () => {
		const t = convexTest(schema, modules);
		await seedThreshold(t, 10 * MINUTE);
		const now = Date.now();
		const taskId = await seed(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "back in progress, trailing segment already closed",
			startedAtAgeMs: 30 * HOUR,
			workSegments: [{ start: now - 30 * HOUR, end: now - 29 * HOUR }],
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.stuckInProgress.entries).toHaveLength(1);
		expect(result.stuckInProgress.entries[0].taskId).toBe(taskId);
		// Age is huge (the fallback reference is 30h old) and there is no OPEN
		// segment backing the in_progress status — this is the paused-without-
		// a-status-change shape, and it must count toward the obligation.
		expect(result.stuckInProgress.actionableStuckCount).toBe(1);
	});

	// Rewritten for the same inversion: an OPEN segment running past the
	// threshold is now the regression case, not the actionable one — someone
	// is actively on this task, however long the segment has run, and that
	// must never fire the obligation. The expected count flips from 1 to 0.
	test("peersStuckOnYou: open segment older than threshold -> NOT actionable, still LISTED", async () => {
		const t = convexTest(schema, modules);
		await seedThreshold(t, 10 * MINUTE);
		const now = Date.now();
		const taskId = await seed(t, {
			assignedTo: "eta",
			createdBy: "sigma",
			title: "open segment untouched for 20 minutes",
			startedAtAgeMs: 20 * MINUTE,
			workSegments: [{ start: now - 20 * MINUTE }],
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.peersStuckOnYou.entries).toHaveLength(1);
		expect(result.peersStuckOnYou.entries[0].taskId).toBe(taskId);
		expect(result.peersStuckOnYou.actionableStuckCount).toBe(0);
	});

	// Rewritten: under the old predicate this row (an OPEN segment) was the
	// one that moved with the threshold. Under the inverted predicate an
	// open segment never counts regardless of threshold (see the two tests
	// above), so an open-segment row can no longer demonstrate the threshold
	// mattering — the row that now moves with the threshold is one with NO
	// open segment. Behaviour changed; the seed shape changes to match.
	test("the threshold is DATA: the same row flips sides when the configured threshold changes", async () => {
		// Threshold ABOVE the row's age -> not actionable.
		const tLow = convexTest(schema, modules);
		await seedThreshold(tLow, 30 * MINUTE);
		await seed(tLow, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "no open segment, 20 minutes old",
			startedAtAgeMs: 20 * MINUTE,
		});
		const resultHighThreshold = await tLow.query(
			api.messages.checkNewMessagesEnvelope,
			{ recipient: "sigma" },
		);
		expect(resultHighThreshold.stuckInProgress.entries).toHaveLength(1);
		expect(resultHighThreshold.stuckInProgress.actionableStuckCount).toBe(0);

		// Threshold BELOW the same 20-minute age -> actionable.
		const tHigh = convexTest(schema, modules);
		await seedThreshold(tHigh, 5 * MINUTE);
		await seed(tHigh, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "no open segment, 20 minutes old",
			startedAtAgeMs: 20 * MINUTE,
		});
		const resultLowThreshold = await tHigh.query(
			api.messages.checkNewMessagesEnvelope,
			{ recipient: "sigma" },
		);
		expect(resultLowThreshold.stuckInProgress.entries).toHaveLength(1);
		expect(resultLowThreshold.stuckInProgress.actionableStuckCount).toBe(1);
	});
});
