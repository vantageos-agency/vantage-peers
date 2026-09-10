/// <reference types="vite/client" />
/**
 * Staleness age must come from the OPEN work segment, not from `startedAt`.
 *
 * `startedAt` is deliberately the FIRST start and is preserved across pause,
 * resume, and a start that resumes. Deriving age from it makes the detector
 * report the wall-clock span the billing derivation was changed to stop
 * counting: a task paused overnight reports the whole night, and a resumed
 * task is announced as stuck while someone is working it.
 *
 * Both signals are covered because `toStuckEntry` feeds each of them; a fix
 * proven on one call site says nothing about the other.
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
const THRESHOLD = 24 * HOUR; // staleInProgress default

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

describe("staleness age is derived from the open segment", () => {
	test("resumed task: startedAt hours old, open segment seconds old -> age is the segment's", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const taskId = await seed(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "worked in two sittings, resumed just now",
			startedAtAgeMs: 3 * HOUR,
			workSegments: [
				{ start: now - 3 * HOUR, end: now - 3 * HOUR + 4 * MINUTE },
				{ start: now - 10 * 1000 },
			],
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.stuckInProgress.entries).toHaveLength(1);
		expect(result.stuckInProgress.entries[0].taskId).toBe(taskId);
		// The whole point: minutes, not the three hours since the first start.
		expect(result.stuckInProgress.entries[0].age).toBeLessThan(5 * MINUTE);
	});

	test("peersStuckOnYou uses the same derivation — the other call site", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await seed(t, {
			assignedTo: "eta",
			createdBy: "sigma",
			title: "a peer's row, resumed just now",
			startedAtAgeMs: 3 * HOUR,
			workSegments: [
				{ start: now - 3 * HOUR, end: now - 3 * HOUR + 4 * MINUTE },
				{ start: now - 10 * 1000 },
			],
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.peersStuckOnYou.entries).toHaveLength(1);
		expect(result.peersStuckOnYou.entries[0].age).toBeLessThan(5 * MINUTE);
	});

	test("a genuinely stalled open segment is still reported with its real age", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await seed(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "open segment untouched for hours",
			startedAtAgeMs: 5 * HOUR,
			workSegments: [{ start: now - 4 * HOUR }],
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.stuckInProgress.entries).toHaveLength(1);
		expect(result.stuckInProgress.entries[0].age).toBeGreaterThan(
			4 * HOUR - MINUTE,
		);
		expect(result.stuckInProgress.entries[0].age).toBeLessThan(
			4 * HOUR + MINUTE,
		);
	});

	test("a row with no segments keeps the startedAt behaviour", async () => {
		const t = convexTest(schema, modules);
		await seed(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "legacy row, no segments",
			startedAtAgeMs: 2 * HOUR,
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.stuckInProgress.entries).toHaveLength(1);
		// Bracketed, not merely "large": a reference of zero also reads as
		// greater than an hour, so a lower bound alone guards nothing.
		expect(result.stuckInProgress.entries[0].age).toBeGreaterThan(
			2 * HOUR - MINUTE,
		);
		expect(result.stuckInProgress.entries[0].age).toBeLessThan(
			2 * HOUR + MINUTE,
		);
	});

	test("staleInProgress uses its own derivation — the third site, not the same function", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		// Old derivation: 30h since the first start, past the 24h threshold.
		// New derivation: seconds since the open segment, far below it.
		await seed(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "paused for a day and a half, resumed just now",
			startedAtAgeMs: 30 * HOUR,
			workSegments: [
				{ start: now - 30 * HOUR, end: now - 30 * HOUR + 4 * MINUTE },
				{ start: now - 10 * 1000 },
			],
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.staleInProgress).toEqual([]);
	});

	test("a last segment that is CLOSED is not an open one — age falls back", async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		// Reachable: the gate closes the trailing segment on exit, and a row
		// can return to in_progress without a new segment opening.
		await seed(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "back in progress, trailing segment already closed",
			startedAtAgeMs: 30 * HOUR,
			workSegments: [{ start: now - 10 * 1000, end: now - 5 * 1000 }],
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.stuckInProgress.entries).toHaveLength(1);
		expect(result.stuckInProgress.entries[0].age).toBeGreaterThan(
			30 * HOUR - MINUTE,
		);
		expect(result.stuckInProgress.entries[0].age).toBeLessThan(
			30 * HOUR + MINUTE,
		);
		expect(result.staleInProgress).toHaveLength(1);
	});
});
