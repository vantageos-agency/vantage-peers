/// <reference types="vite/client" />
/**
 * The actionable-stuck discriminator keys on an in_progress row's ABSENCE of
 * an open work segment, not its presence. An open segment means someone is
 * actively on the task right now — however long that segment has run, it is
 * not the failure mode this obligation exists to catch. The failure mode is
 * a status that claims work is underway while no segment backs that claim:
 * never started, or started and paused without the status ever reverting.
 *
 * Companion to stuck-actionable-discriminates.test.ts, which pins the
 * still-LISTED guard on the any-age entries/total/truncated contract; this
 * file pins actionableStuckCount's polarity, which that file's own
 * open-segment cases got backwards before this change.
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
		// When omitted, the row carries neither startedAt nor workSegments —
		// the never-started shape measured on the live fleet — but its age
		// cannot be aged this way in this harness: convex-test stamps
		// `_creationTime` at insert time, so an omitted startedAtAgeMs
		// produces a row whose staleAge fallback (startedAt ?? _creationTime)
		// reads ~0, not days old. Use a closed workSegments trailing entry
		// (see the "closed trailing segment" test) to get an aged
		// no-open-segment row instead.
		startedAtAgeMs?: number;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		workSegments?: any[];
	},
): Promise<string> {
	const hasStartedAt = opts.startedAtAgeMs !== undefined;
	const createdAt = Date.now() - (opts.startedAtAgeMs ?? 0);
	return await t.run(async (ctx: any) => {
		return await ctx.db.insert("tasks", {
			title: opts.title,
			assignedTo: opts.assignedTo,
			priority: "medium" as const,
			status: "in_progress" as const,
			createdBy: opts.createdBy,
			createdAt,
			updatedAt: createdAt,
			...(hasStartedAt ? { startedAt: createdAt } : {}),
			...(opts.workSegments ? { workSegments: opts.workSegments } : {}),
		});
	});
}

describe("actionable-stuck count fires on the ABSENCE of an open segment, not its presence", () => {
	test("regression: worked continuously well past the threshold, open segment -> NOT actionable", async () => {
		const t = convexTest(schema, modules);
		await seedThreshold(t, 15 * MINUTE);
		const now = Date.now();
		// Modeled on a real task: 121 of 136 minutes into continuous work.
		const taskId = await seed(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "actively worked, open segment 121 minutes in",
			startedAtAgeMs: 136 * MINUTE,
			workSegments: [{ start: now - 121 * MINUTE }],
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.stuckInProgress.entries).toHaveLength(1);
		expect(result.stuckInProgress.entries[0].taskId).toBe(taskId);
		expect(result.stuckInProgress.actionableStuckCount).toBe(0);
	});

	// PR #1282: this seeds startedAt (via startedAtAgeMs) and no
	// workSegments — NOT the true never-started shape (no startedAt, aged
	// off _creationTime). The production never-started shape is untestable
	// in this harness: convex-test stamps `_creationTime` at insert, so a
	// row seeded with no startedAt always reads age ~0 regardless of when
	// the test intends it to have been created.
	test("no open segment, startedAt days old, no workSegments -> ACTIONABLE", async () => {
		const t = convexTest(schema, modules);
		await seedThreshold(t, 15 * MINUTE);
		const taskId = await seed(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "marked in_progress, started days ago, no segment",
			startedAtAgeMs: 6 * 24 * HOUR,
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.stuckInProgress.entries).toHaveLength(1);
		expect(result.stuckInProgress.entries[0].taskId).toBe(taskId);
		expect(result.stuckInProgress.actionableStuckCount).toBe(1);
	});

	// Live-fleet shape measured for PR #1282.
	test("closed trailing segment: worked then paused without a status change -> ACTIONABLE", async () => {
		const t = convexTest(schema, modules);
		await seedThreshold(t, 15 * MINUTE);
		const now = Date.now();
		const taskId = await seed(t, {
			assignedTo: "eta",
			createdBy: "sigma",
			title: "worked, segment closed, status still in_progress",
			startedAtAgeMs: 30 * HOUR,
			workSegments: [{ start: now - 30 * HOUR, end: now - 29 * HOUR }],
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.peersStuckOnYou.entries).toHaveLength(1);
		expect(result.peersStuckOnYou.entries[0].taskId).toBe(taskId);
		expect(result.peersStuckOnYou.actionableStuckCount).toBe(1);
	});

	// Boundary/wiring control, PR #1282.
	test("transient: no open segment but younger than the threshold -> NOT actionable", async () => {
		const t = convexTest(schema, modules);
		await seedThreshold(t, 15 * MINUTE);
		const taskId = await seed(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "just flipped to in_progress, no segment opened yet",
			startedAtAgeMs: 30 * 1000,
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.stuckInProgress.entries).toHaveLength(1);
		expect(result.stuckInProgress.entries[0].taskId).toBe(taskId);
		expect(result.stuckInProgress.actionableStuckCount).toBe(0);
	});

	// Boundary/wiring control, PR #1282.
	test("the threshold is DATA on the no-open-segment path too: the same row flips sides when it changes", async () => {
		const now = Date.now();

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

describe("wiring pole: disabling the condition at ONE call site only reddens that signal alone", () => {
	// Boundary/wiring control, PR #1282.
	test("stuckInProgress actionableStuckCount is independently wired from peersStuckOnYou", async () => {
		// Both signals share computeStuckList/isActionableStuck; this seeds one
		// never-started row visible on EACH signal separately and asserts each
		// count independently, so a wiring break at one call site (e.g. one
		// site still passing the old predicate) reddens only that assertion
		// rather than both moving together for an unrelated reason.
		const t = convexTest(schema, modules);
		await seedThreshold(t, 15 * MINUTE);

		const mineTaskId = await seed(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "assigned to sigma, never started",
			startedAtAgeMs: 2 * HOUR,
		});
		const peerTaskId = await seed(t, {
			assignedTo: "eta",
			createdBy: "sigma",
			title: "sigma created, assigned to eta, never started",
			startedAtAgeMs: 2 * HOUR,
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.stuckInProgress.entries.map((e) => e.taskId)).toContain(
			mineTaskId,
		);
		expect(result.stuckInProgress.actionableStuckCount).toBe(1);

		expect(result.peersStuckOnYou.entries.map((e) => e.taskId)).toContain(
			peerTaskId,
		);
		expect(result.peersStuckOnYou.actionableStuckCount).toBe(1);
	});
});
