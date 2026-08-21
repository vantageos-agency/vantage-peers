/// <reference types="vite/client" />
/**
 * convex/__tests__/pendingOnYou.test.ts
 *
 * Day 133 (k176bjye4kvpgg0qf6fkrneq558btx7c) introduced `pendingOnYou`
 * (`blocked` tasks whose unblock authority is the caller) wired directly
 * into `checkNewMessagesEnvelope`'s returned envelope. Laurent (task
 * k17c4ejer172fgj9t1h027hswn8bvv4w, categorical decision): "les messages
 * ce sont des messages, pas de liste de tâches dans un retour check
 * message." — the pendingOnYou/slaBreached fields are REMOVED from the
 * envelope. `check_messages` returns messages + pagination +
 * staleInProgress + stuckInProgress + peersStuckOnYou. Do not revive
 * pendingOnYou*.
 *
 * `computePendingOnYou`/`getSlaBreachedTopN`/`isDormant` in
 * `convex/lib/taskClosureGate.ts` are left intact (unwired, not deleted) —
 * a future dedicated opt-in `list_pending_on_me` tool may reuse them. This
 * file now tests:
 *   1. `checkNewMessagesEnvelope` output has NO pendingOnYouTotal /
 *      slaBreachedTotal / slaBreachedTop keys (the regression guard for
 *      this removal).
 *   2. `computePendingOnYou` the FUNCTION still works correctly at the
 *      lib level (POS/NEG authority + SLA-age + dormant-tag exclusion),
 *      called directly rather than through the envelope.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { computePendingOnYou } from "../lib/taskClosureGate";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedBlockedTaskWithAge(
	t: any,
	assignedTo: string,
	createdBy: string,
	title: string,
	ageMs: number,
	tags?: string[],
): Promise<string> {
	const now = Date.now();
	return await t.run(async (ctx: any) => {
		return await ctx.db.insert("tasks", {
			title,
			assignedTo,
			priority: "high" as const,
			status: "blocked" as const,
			createdBy,
			createdAt: now - ageMs,
			updatedAt: now - ageMs,
			...(tags !== undefined ? { tags } : {}),
		});
	});
}

describe("checkNewMessagesEnvelope — no pendingOnYou/slaBreached fields (Laurent k17c4ejer172fgj9t1h027hswn8bvv4w)", () => {
	test("envelope keys include stuck siblings and still exclude pendingOnYou*", async () => {
		const t = convexTest(schema, modules);
		await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[PROD-DEPLOY-AUTHORIZED] ship v2",
			0,
		);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result).not.toHaveProperty("pendingOnYouTotal");
		expect(result).not.toHaveProperty("slaBreachedTotal");
		expect(result).not.toHaveProperty("slaBreachedTop");
		expect(Object.keys(result).sort()).toEqual(
			[
				"messages",
				"nextSince",
				"peersStuckOnYou",
				"staleInProgress",
				"stuckInProgress",
				"truncated",
			].sort(),
		);
	});
});

describe("computePendingOnYou (lib-level, unwired from envelope)", () => {
	const CYCLE_MS = 1_800_000; // DEFAULT_PENDING_ON_YOU_CYCLE_MS

	test("POS: blocked task created by the caller → counted", async () => {
		const t = convexTest(schema, modules);
		await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[PROD-DEPLOY-AUTHORIZED] ship v2",
			0,
		);

		const entries = await t.run(async (ctx: any) =>
			computePendingOnYou(ctx, "victor", Date.now()),
		);

		expect(entries.length).toBe(1);
		expect(entries[0].slaBreached).toBe(false);
	});

	test("NEG: blocked task created by someone else → NOT listed for the caller", async () => {
		const t = convexTest(schema, modules);
		await seedBlockedTaskWithAge(
			t,
			"eta",
			"pi",
			"[REVIEW] someone else's gate",
			0,
		);

		const entries = await t.run(async (ctx: any) =>
			computePendingOnYou(ctx, "victor", Date.now()),
		);

		expect(entries.length).toBe(0);
	});

	test("POS: age >= 3 cycles → slaBreached true", async () => {
		const t = convexTest(schema, modules);
		await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[PROD-DEPLOY-AUTHORIZED] sla breach case",
			3 * CYCLE_MS + 60_000,
		);

		const entries = await t.run(async (ctx: any) =>
			computePendingOnYou(ctx, "victor", Date.now()),
		);

		expect(entries.length).toBe(1);
		expect(entries[0].slaBreached).toBe(true);
		expect(entries[0].cyclesWaiting).toBeGreaterThanOrEqual(3);
	});

	test("NEG: age < 3 cycles → slaBreached false", async () => {
		const t = convexTest(schema, modules);
		await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[REVIEW] not yet breached",
			1 * CYCLE_MS,
		);

		const entries = await t.run(async (ctx: any) =>
			computePendingOnYou(ctx, "victor", Date.now()),
		);

		expect(entries.length).toBe(1);
		expect(entries[0].slaBreached).toBe(false);
	});

	test("NEG-excluded: tags=[dormant] → excluded despite SLA-breach age", async () => {
		const t = convexTest(schema, modules);
		await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[REVIEW] dormant-tagged, should be excluded",
			3 * CYCLE_MS + 60_000,
			["dormant"],
		);

		const entries = await t.run(async (ctx: any) =>
			computePendingOnYou(ctx, "victor", Date.now()),
		);

		expect(entries.length).toBe(0);
	});

	test("POS-included (regression guard): non-dormant tags → present with slaBreached true", async () => {
		const t = convexTest(schema, modules);
		await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[REVIEW] security-tagged, should be included",
			3 * CYCLE_MS + 60_000,
			["security"],
		);

		const entries = await t.run(async (ctx: any) =>
			computePendingOnYou(ctx, "victor", Date.now()),
		);

		expect(entries.length).toBe(1);
		expect(entries[0].slaBreached).toBe(true);
	});
});
