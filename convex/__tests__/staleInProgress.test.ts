/// <reference types="vite/client" />
/**
 * convex/__tests__/staleInProgress.test.ts
 *
 * Day 130 (k17dhcmzqafve1ayzvh833kf558ae019) — checkNewMessagesEnvelope must
 * surface `staleInProgress`: tasks assigned to the recipient that are
 * in_progress beyond a configurable threshold (default 24h, config-driven —
 * never hardcoded).
 *
 * Coordinator correction (post-implementation): `checkNewMessages` is a
 * FROZEN legacy contract for vp-mcp <2.12.0 callers — nothing live calls it
 * (mcp-server only calls checkNewMessagesEnvelope, tools.ts:2776). Adding
 * staleInProgress there broke the frozen array shape for no real benefit.
 * staleInProgress is delivered exclusively via the envelope variant, which
 * is the path every real orchestrator actually uses.
 *
 * Cases:
 *   (f) checkNewMessagesEnvelope: in_progress task older than threshold →
 *       staleInProgress non-empty
 *   (h) checkNewMessagesEnvelope: in_progress task younger than threshold →
 *       staleInProgress empty
 *   FROZEN-CONTRACT: checkNewMessages still returns a bare array (guards
 *       against the shape ever being broken again)
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

const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedInProgressTask(
	t: any,
	assignedTo: string,
	ageMs: number,
): Promise<string> {
	const startedAt = Date.now() - ageMs;
	return await t.run(async (ctx: any) => {
		return await ctx.db.insert("tasks", {
			title: `Stale-check task age=${ageMs}`,
			assignedTo,
			priority: "medium" as const,
			status: "in_progress" as const,
			startedAt,
			createdBy: "sigma",
			createdAt: startedAt,
			updatedAt: startedAt,
		});
	});
}

describe("staleInProgress — checkNewMessagesEnvelope (Day 130, the real path)", () => {
	test("(f) in_progress task older than threshold (24h default) → staleInProgress non-empty", async () => {
		const t = convexTest(schema, modules);
		await seedInProgressTask(t, "victor", TWENTY_FIVE_HOURS_MS);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result.staleInProgress).toBeDefined();
		expect(result.staleInProgress.length).toBeGreaterThan(0);
	});

	test("(h) in_progress task younger than threshold → staleInProgress empty", async () => {
		const t = convexTest(schema, modules);
		await seedInProgressTask(t, "victor", ONE_HOUR_MS);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result.staleInProgress).toEqual([]);
	});
});

describe("checkNewMessages — frozen legacy contract (Day 130 regression guard)", () => {
	test("checkNewMessages still returns a bare array, no staleInProgress wrapper", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "tau",
			content: "Frozen contract smoke",
		});

		const result = await t.query(api.messages.checkNewMessages, {
			recipient: "tau",
		});

		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(1);
		expect(result[0]).not.toHaveProperty("staleInProgress");
		expect((result as unknown as Record<string, unknown>).staleInProgress).toBeUndefined();
	});
});
