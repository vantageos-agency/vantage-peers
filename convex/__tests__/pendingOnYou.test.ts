/// <reference types="vite/client" />
/**
 * convex/__tests__/pendingOnYou.test.ts
 *
 * Day 133 (k176bjye4kvpgg0qf6fkrneq558btx7c, mission pi-pending-on-me-queue-v1)
 * — checkNewMessagesEnvelope must surface `pendingOnYou`: `blocked` tasks
 * whose unblock authority is the caller (createdBy === recipient), derived
 * on every call, never a stored flag. Mirrors staleInProgress.test.ts.
 *
 * Cases:
 *   POS: blocked task created by the caller ("victor") → pendingOnYou
 *        non-empty, full 32-char taskId, correct assignee/title/age.
 *   NEG: blocked task created by SOMEONE ELSE (not the caller) → NOT
 *        listed for the caller — unblock authority belongs to a different
 *        party.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedBlockedTask(
	t: any,
	assignedTo: string,
	createdBy: string,
	title: string,
): Promise<string> {
	const now = Date.now();
	return await t.run(async (ctx: any) => {
		return await ctx.db.insert("tasks", {
			title,
			assignedTo,
			priority: "high" as const,
			status: "blocked" as const,
			createdBy,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe("pendingOnYou — checkNewMessagesEnvelope (Day 133)", () => {
	test("POS: blocked task created by the caller → pendingOnYou lists it with full taskId", async () => {
		const t = convexTest(schema, modules);
		const taskId = await seedBlockedTask(
			t,
			"eta",
			"victor",
			"[PROD-DEPLOY-AUTHORIZED] ship v2",
		);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result.pendingOnYou).toBeDefined();
		expect(result.pendingOnYou.length).toBe(1);
		const entry = result.pendingOnYou[0];
		expect(entry.taskId).toBe(taskId);
		expect(entry.taskId.length).toBeGreaterThan(0);
		expect(entry.title).toBe("[PROD-DEPLOY-AUTHORIZED] ship v2");
		expect(entry.assignee).toBe("eta");
		expect(typeof entry.age).toBe("number");
	});

	test("NEG: blocked task created by someone else → NOT listed for the caller", async () => {
		const t = convexTest(schema, modules);
		await seedBlockedTask(
			t,
			"eta",
			"pi",
			"[REVIEW] someone else's gate",
		);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result.pendingOnYou).toEqual([]);
	});
});

describe("pendingOnYou SLA-AGE (Day 152)", () => {
	const CYCLE_MS = 1_800_000; // DEFAULT_PENDING_ON_YOU_CYCLE_MS

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

	test("POS: age >= 3 cycles → slaBreached true, cyclesWaiting >= 3", async () => {
		const t = convexTest(schema, modules);
		await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[PROD-DEPLOY-AUTHORIZED] sla breach case",
			3 * CYCLE_MS + 60_000,
		);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result.pendingOnYou.length).toBe(1);
		const entry = result.pendingOnYou[0];
		expect(entry.slaBreached).toBe(true);
		expect(entry.cyclesWaiting).toBeGreaterThanOrEqual(3);
	});

	test("NEG: age < 3 cycles (1 cycle) → slaBreached false, cyclesWaiting < 3", async () => {
		const t = convexTest(schema, modules);
		await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[REVIEW] not yet breached",
			1 * CYCLE_MS,
		);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result.pendingOnYou.length).toBe(1);
		const entry = result.pendingOnYou[0];
		expect(entry.slaBreached).toBe(false);
		expect(entry.cyclesWaiting).toBeLessThan(3);
	});
});

describe("pendingOnYou dormant-tag exclusion (Day 154)", () => {
	const CYCLE_MS = 1_800_000; // DEFAULT_PENDING_ON_YOU_CYCLE_MS

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

	test("NEG-excluded: tags=[dormant] → NOT present in pendingOnYou despite SLA-breach age", async () => {
		const t = convexTest(schema, modules);
		const taskId = await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[REVIEW] dormant-tagged, should be excluded",
			3 * CYCLE_MS + 60_000,
			["dormant"],
		);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(
			result.pendingOnYou.some((e: { taskId: string }) => e.taskId === taskId),
		).toBe(false);
	});

	test("NEG-excluded: tags=[parked] → NOT present in pendingOnYou despite SLA-breach age", async () => {
		const t = convexTest(schema, modules);
		const taskId = await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[REVIEW] parked-tagged, should be excluded",
			3 * CYCLE_MS + 60_000,
			["parked"],
		);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(
			result.pendingOnYou.some((e: { taskId: string }) => e.taskId === taskId),
		).toBe(false);
	});

	test("POS-included (regression guard): non-dormant tags → present with slaBreached true", async () => {
		const t = convexTest(schema, modules);
		const taskId = await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[REVIEW] security-tagged, should be included",
			3 * CYCLE_MS + 60_000,
			["security"],
		);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		const entry = result.pendingOnYou.find(
			(e: { taskId: string }) => e.taskId === taskId,
		);
		expect(entry).toBeDefined();
		expect(entry?.slaBreached).toBe(true);
	});
});
