/// <reference types="vite/client" />
/**
 * convex/__tests__/stuckInProgress.test.ts
 *
 * Task k176w8hfeaxq07z500qk71xc2d8cw334 — checkNewMessagesEnvelope must
 * surface live in_progress work without waiting for the 24h staleInProgress
 * threshold (T4 was stuck in minutes; 24h is too late).
 *
 * Sibling arrays on the envelope (same shape as staleInProgress):
 *   stuckInProgress  — in_progress assignedTo the caller (any age)
 *   peersStuckOnYou  — in_progress createdBy the caller, assignedTo someone else
 *
 * Does NOT revive pendingOnYou / slaBreached (Laurent + Day-156: messages
 * are messages). Empty unread messages must not hide a non-empty stuck list.
 *
 * TDD:
 *   RED:  unread=[], young in_progress assignedTo=recipient → current
 *         envelope has no stuckInProgress or length 0
 *   GREEN: same fixture → stuckInProgress length 1, taskId matches
 *          second fixture: createdBy=pi assignedTo=sigma, recipient=pi
 *          → peersStuckOnYou length 1
 *   NEG:  pendingOnYouTotal still absent
 */

import { readFileSync } from "node:fs";
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

const FIVE_MINUTES_MS = 5 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedInProgressTask(
	t: any,
	opts: {
		assignedTo: string;
		createdBy: string;
		title: string;
		ageMs: number;
	},
): Promise<string> {
	const startedAt = Date.now() - opts.ageMs;
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
		});
	});
}

describe("stuckInProgress — checkNewMessagesEnvelope (k176w8hfeaxq07z500qk71xc2d8cw334)", () => {
	test("unread=[] + young in_progress assignedTo=recipient → stuckInProgress length 1, not stale", async () => {
		const t = convexTest(schema, modules);
		const taskId = await seedInProgressTask(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "T4 stuck in minutes, not 24h",
			ageMs: FIVE_MINUTES_MS,
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "sigma",
		});

		expect(result.messages).toEqual([]);
		expect(result.staleInProgress).toEqual([]);
		expect(result.stuckInProgress.entries).toHaveLength(1);
		expect(result.stuckInProgress.entries[0].taskId).toBe(taskId);
		expect(result.stuckInProgress.entries[0].title).toBe(
			"T4 stuck in minutes, not 24h",
		);
		expect(result.stuckInProgress.entries[0].age).toBeGreaterThan(0);
		expect(result.stuckInProgress.entries[0].age).toBeLessThan(
			24 * 60 * 60 * 1000,
		);
		expect(result.stuckInProgress.total).toBe(1);
		expect(result.stuckInProgress.truncated).toBe(false);
	});

	test("unread=[] + createdBy=pi assignedTo=sigma, recipient=pi → peersStuckOnYou length 1", async () => {
		const t = convexTest(schema, modules);
		const taskId = await seedInProgressTask(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "peer stuck on coordinator",
			ageMs: FIVE_MINUTES_MS,
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "pi",
		});

		expect(result.messages).toEqual([]);
		expect(result.peersStuckOnYou.entries).toHaveLength(1);
		expect(result.peersStuckOnYou.entries[0].taskId).toBe(taskId);
		expect(result.peersStuckOnYou.entries[0].title).toBe(
			"peer stuck on coordinator",
		);
		expect(result.peersStuckOnYou.total).toBe(1);
		expect(result.peersStuckOnYou.truncated).toBe(false);
		expect(result.stuckInProgress.entries).toEqual([]);
	});

	test("self-assigned in_progress is stuckInProgress, not peersStuckOnYou", async () => {
		const t = convexTest(schema, modules);
		const taskId = await seedInProgressTask(t, {
			assignedTo: "pi",
			createdBy: "pi",
			title: "own live work",
			ageMs: FIVE_MINUTES_MS,
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "pi",
		});

		expect(result.stuckInProgress.entries.map((e) => e.taskId)).toEqual([
			taskId,
		]);
		expect(result.peersStuckOnYou.entries).toEqual([]);
	});

	test("ETA-M28: 1 pi-created in_progress + 250 newer omega in_progress → peersStuckOnYou still finds the old wait", async () => {
		const t = convexTest(schema, modules);
		const awaitedId = await seedInProgressTask(t, {
			assignedTo: "sigma",
			createdBy: "pi",
			title: "ETA-M28 awaited",
			ageMs: 10 * 60 * 1000,
		});

		await t.run(async (ctx: any) => {
			const now = Date.now();
			for (let i = 0; i < 250; i++) {
				const createdAt = now - i;
				await ctx.db.insert("tasks", {
					title: `ETA-M28 noise ${i}`,
					assignedTo: "omega",
					priority: "medium" as const,
					status: "in_progress" as const,
					startedAt: createdAt,
					createdBy: "omega",
					createdAt,
					updatedAt: createdAt,
				});
			}
		});

		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "pi",
		});

		expect(result.peersStuckOnYou.entries.length).toBe(1);
		expect(result.peersStuckOnYou.entries[0].taskId).toBe(awaitedId);
		expect(result.peersStuckOnYou.truncated).toBe(false);
		expect(result.peersStuckOnYou.total).toBe(1);

		expect(result).not.toHaveProperty("pendingOnYou");
		expect(result).not.toHaveProperty("pendingOnYouTotal");
		expect(result).not.toHaveProperty("slaBreached");
		expect(result).not.toHaveProperty("slaBreachedTotal");
		expect(result).not.toHaveProperty("slaBreachedTop");
	});

	test("NEG: pendingOnYou* still absent; envelope keys include the new siblings", async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "victor",
		});

		expect(result).not.toHaveProperty("pendingOnYou");
		expect(result).not.toHaveProperty("pendingOnYouTotal");
		expect(result).not.toHaveProperty("slaBreached");
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

	test("NEG: taskClosureGate.ts must not contain .paginate( (one paginate cursor per Convex function)", () => {
		const src = readFileSync(
			new URL("../lib/taskClosureGate.ts", import.meta.url),
			"utf8",
		);
		expect(src).not.toMatch(/\.paginate\s*\(/);
	});
});
