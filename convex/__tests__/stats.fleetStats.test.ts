/// <reference types="vite/client" />
/**
 * convex/__tests__/stats.fleetStats.test.ts
 *
 * TDD RED→GREEN for stats:fleetStats (VP task k177xw1r3qr5fkv3dr5f2jcfhs8bqz7f).
 *
 * Problem: MCP list_missions/list_tasks paginate with a SCAN_CAP (~2000 rows)
 * and can only report floors ("at least N"), never true totals. fleetStats
 * counts server-side via a paginate-loop (never a single unbounded
 * `.collect()`) so it cannot OOM and cannot silently under-count.
 *
 * Coverage:
 *   T1  seeded bus/missions/tasks/missionTemplates → exact per-status counts,
 *       including explicit 0 for statuses with zero seeded rows.
 *   T2  positive control: exactly 3 in_progress tasks + 16 validate missions
 *       seeded (Day 150 known-real prod shape) → query returns those exact
 *       numbers, proving the positive-control logic on seeded data before
 *       any prod deploy.
 *   T3  totals equal the sum of their own byStatus breakdown (no double count,
 *       no silent drop).
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
async function seedMission(ctx: any, overrides: Record<string, unknown> = {}): Promise<string> {
	const now = Date.now();
	return await ctx.db.insert("missions", {
		name: "Test mission",
		project: "vantage-memory",
		status: "brainstorm" as const,
		priority: "medium" as const,
		pilot: "sigma",
		agents: [],
		createdBy: "sigma",
		createdAt: now,
		updatedAt: now,
		...overrides,
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedTask(ctx: any, overrides: Record<string, unknown> = {}): Promise<string> {
	const now = Date.now();
	return await ctx.db.insert("tasks", {
		title: "Test task",
		assignedTo: "sigma",
		priority: "medium" as const,
		status: "todo" as const,
		createdBy: "sigma",
		createdAt: now,
		updatedAt: now,
		...overrides,
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedBu(ctx: any, overrides: Record<string, unknown> = {}): Promise<string> {
	return await ctx.db.insert("businessUnits", {
		name: "Test BU",
		description: "desc",
		purpose: "purpose",
		orchestratorId: "sigma",
		status: "building" as const,
		businessModel: "saas",
		targetCustomers: "orgs",
		services: [],
		pricing: "flat",
		revenueProjections: { y1: 0, y2: 0, y3: 0 },
		coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
		coreProcesses: [],
		dependencies: [],
		kpis: [],
		managementFee: 10,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedMissionTemplate(ctx: any, overrides: Record<string, unknown> = {}): Promise<string> {
	const now = Date.now();
	return await ctx.db.insert("missionTemplates", {
		name: "Test template",
		steps: [],
		isDefault: false,
		createdBy: "sigma",
		createdAt: now,
		updatedAt: now,
		...overrides,
	});
}

describe("stats.fleetStats — real fleet totals (no SCAN_CAP floors)", () => {
	// ── T1: exact per-status counts, explicit 0 for empty statuses ───────────
	test("T1: fleetStats returns exact seeded per-status counts including explicit 0", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedBu(ctx, { name: "BU A" });
			await seedBu(ctx, { name: "BU B" });

			await seedMission(ctx, { name: "M1", status: "brainstorm" });
			await seedMission(ctx, { name: "M2", status: "brainstorm" });
			await seedMission(ctx, { name: "M3", status: "plan" });
			await seedMission(ctx, { name: "M4", status: "execute" });
			// "validate" and "complete" intentionally left at 0.

			await seedTask(ctx, { title: "T1", status: "todo" });
			await seedTask(ctx, { title: "T2", status: "todo" });
			await seedTask(ctx, { title: "T3", status: "todo" });
			await seedTask(ctx, { title: "T4", status: "done" });
			// "in_progress", "review", "blocked" intentionally left at 0.

			await seedMissionTemplate(ctx, { name: "Tmpl A" });
		});

		const result = await t.query(api.stats.fleetStats, {});

		expect(result.bus.total).toBe(2);

		expect(result.missions.total).toBe(4);
		expect(result.missions.byStatus).toEqual({
			brainstorm: 2,
			plan: 1,
			execute: 1,
			validate: 0,
			complete: 0,
		});

		expect(result.tasks.total).toBe(4);
		expect(result.tasks.byStatus).toEqual({
			todo: 3,
			in_progress: 0,
			review: 0,
			blocked: 0,
			done: 1,
		});

		expect(result.missionTemplates.total).toBe(1);
		expect(typeof result.generatedAt).toBe("number");
	});

	// ── T2: positive control — Day 150 known-real prod shape, seeded ─────────
	test("T2: positive control — 3 in_progress tasks + 16 validate missions", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			// Seed exactly 3 in_progress tasks.
			for (let i = 0; i < 3; i++) {
				await seedTask(ctx, { title: `InProgress ${i}`, status: "in_progress" });
			}
			// Noise: other task statuses, must not be counted as in_progress.
			await seedTask(ctx, { title: "Todo noise", status: "todo" });
			await seedTask(ctx, { title: "Done noise", status: "done" });

			// Seed exactly 16 validate missions.
			for (let i = 0; i < 16; i++) {
				await seedMission(ctx, { name: `Validate ${i}`, status: "validate" });
			}
			// Noise: other mission statuses, must not be counted as validate.
			await seedMission(ctx, { name: "Plan noise", status: "plan" });
			await seedMission(ctx, { name: "Complete noise", status: "complete" });
		});

		const result = await t.query(api.stats.fleetStats, {});

		expect(result.tasks.byStatus.in_progress).toBe(3);
		expect(result.missions.byStatus.validate).toBe(16);
	});

	// ── T3: totals equal sum of their own byStatus breakdown ─────────────────
	test("T3: totals equal sum of byStatus breakdown — no double count, no silent drop", async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await seedMission(ctx, { status: "brainstorm" });
			await seedMission(ctx, { status: "plan" });
			await seedMission(ctx, { status: "execute" });
			await seedMission(ctx, { status: "validate" });
			await seedMission(ctx, { status: "complete" });

			await seedTask(ctx, { status: "todo" });
			await seedTask(ctx, { status: "in_progress" });
			await seedTask(ctx, { status: "review" });
			await seedTask(ctx, { status: "blocked" });
			await seedTask(ctx, { status: "done" });
		});

		const result = await t.query(api.stats.fleetStats, {});

		const missionsSum = Object.values(result.missions.byStatus).reduce(
			(a, b) => a + b,
			0,
		);
		const tasksSum = Object.values(result.tasks.byStatus).reduce(
			(a, b) => a + b,
			0,
		);

		expect(result.missions.total).toBe(missionsSum);
		expect(result.tasks.total).toBe(tasksSum);
		expect(result.missions.total).toBe(5);
		expect(result.tasks.total).toBe(5);
	});
});
