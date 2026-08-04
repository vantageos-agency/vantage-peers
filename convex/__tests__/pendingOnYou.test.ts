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
	test("POS: blocked task created by the caller → counted in pendingOnYouTotal", async () => {
		const t = convexTest(schema, modules);
		await seedBlockedTask(
			t,
			"eta",
			"victor",
			"[PROD-DEPLOY-AUTHORIZED] ship v2",
		);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result.pendingOnYouTotal).toBe(1);
		// not slaBreached (fresh task, age ~0) → not in slaBreachedTop.
		expect(result.slaBreachedTotal).toBe(0);
		expect(result.slaBreachedTop).toEqual([]);
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

		expect(result.pendingOnYouTotal).toBe(0);
		expect(result.slaBreachedTotal).toBe(0);
		expect(result.slaBreachedTop).toEqual([]);
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

		expect(result.pendingOnYouTotal).toBe(1);
		expect(result.slaBreachedTotal).toBe(1);
		expect(result.slaBreachedTop.length).toBe(1);
		const entry = result.slaBreachedTop[0];
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

		expect(result.pendingOnYouTotal).toBe(1);
		expect(result.slaBreachedTotal).toBe(0);
		expect(result.slaBreachedTop).toEqual([]);
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

		expect(result.pendingOnYouTotal).toBe(0);
		expect(
			result.slaBreachedTop.some((e: { taskId: string }) => e.taskId === taskId),
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

		expect(result.pendingOnYouTotal).toBe(0);
		expect(
			result.slaBreachedTop.some((e: { taskId: string }) => e.taskId === taskId),
		).toBe(false);
	});

	test("NEG-excluded: tags=[deferred] → NOT present in pendingOnYou despite SLA-breach age", async () => {
		const t = convexTest(schema, modules);
		const taskId = await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[REVIEW] deferred-tagged, should be excluded",
			3 * CYCLE_MS + 60_000,
			["deferred"],
		);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result.pendingOnYouTotal).toBe(0);
		expect(
			result.slaBreachedTop.some((e: { taskId: string }) => e.taskId === taskId),
		).toBe(false);
	});

	test("NEG-excluded: tags=[Dormant] (mixed-case) → NOT present in pendingOnYou despite SLA-breach age", async () => {
		const t = convexTest(schema, modules);
		const taskId = await seedBlockedTaskWithAge(
			t,
			"eta",
			"victor",
			"[REVIEW] mixed-case-dormant-tagged, should be excluded",
			3 * CYCLE_MS + 60_000,
			["Dormant"],
		);

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result.pendingOnYouTotal).toBe(0);
		expect(
			result.slaBreachedTop.some((e: { taskId: string }) => e.taskId === taskId),
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

		expect(result.pendingOnYouTotal).toBe(1);
		expect(result.slaBreachedTotal).toBe(1);
		const entry = result.slaBreachedTop.find(
			(e: { taskId: string }) => e.taskId === taskId,
		);
		expect(entry).toBeDefined();
		expect(entry?.slaBreached).toBe(true);
	});
});

describe("slaBreachedTop CAP (Day 156, measurement-integrity: volume drowns the signal)", () => {
	const CYCLE_MS = 1_800_000; // DEFAULT_PENDING_ON_YOU_CYCLE_MS

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async function seedBlockedTaskWithAge(
		t: any,
		assignedTo: string,
		createdBy: string,
		title: string,
		ageMs: number,
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
			});
		});
	}

	test("under-cap: 3 slaBreached tasks → slaBreachedTop.length===3, slaBreachedTotal===3", async () => {
		const t = convexTest(schema, modules);
		for (let i = 0; i < 3; i++) {
			await seedBlockedTaskWithAge(
				t,
				"eta",
				"victor",
				`[REVIEW] under-cap breach ${i}`,
				3 * CYCLE_MS + 60_000 + i * 1_000,
			);
		}

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result.slaBreachedTop.length).toBe(3);
		expect(result.slaBreachedTotal).toBe(3);
	});

	test("over-cap: 12 slaBreached tasks with distinct increasing ages → slaBreachedTop capped at 10, slaBreachedTotal===12, sorted by cyclesWaiting DESC", async () => {
		const t = convexTest(schema, modules);
		const TASK_COUNT = 12;
		// increasing ages: task i has age = 3*CYCLE_MS + 60_000 + i * CYCLE_MS
		// so higher i = older = higher cyclesWaiting. The 2 smallest-age tasks
		// (i=0, i=1) must be excluded from the top-10 by cyclesWaiting DESC.
		for (let i = 0; i < TASK_COUNT; i++) {
			await seedBlockedTaskWithAge(
				t,
				"eta",
				"victor",
				`[REVIEW] over-cap breach ${i}`,
				3 * CYCLE_MS + 60_000 + i * CYCLE_MS,
			);
		}

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result.slaBreachedTotal).toBe(12);
		expect(result.slaBreachedTop.length).toBe(10);

		// sorted DESC by cyclesWaiting: first entry has the highest
		// cyclesWaiting (the oldest task, i=11).
		for (let i = 1; i < result.slaBreachedTop.length; i++) {
			expect(result.slaBreachedTop[i - 1].cyclesWaiting).toBeGreaterThanOrEqual(
				result.slaBreachedTop[i].cyclesWaiting,
			);
		}
		expect(result.slaBreachedTop[0].title).toBe("[REVIEW] over-cap breach 11");

		// the 2 smallest-age tasks (i=0, i=1) are absent from the top-10.
		const titles = result.slaBreachedTop.map((e) => e.title);
		expect(titles).not.toContain("[REVIEW] over-cap breach 0");
		expect(titles).not.toContain("[REVIEW] over-cap breach 1");
	});
});
