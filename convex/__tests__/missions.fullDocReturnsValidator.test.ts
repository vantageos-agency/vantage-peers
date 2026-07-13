/// <reference types="vite/client" />
/**
 * convex/__tests__/missions.fullDocReturnsValidator.test.ts
 *
 * Regression suite for Day-101 sweep — missions.get returning 500 Server Error
 * due to full-doc returns-validator missing the `orgId` field added in
 * PR #360 (commit 44f0a93).
 *
 * Root cause: schema.ts missions table has `orgId: v.optional(v.string())`
 * since PR #360 (feat(scope): client_org_mapping + withOrgScope helper). The
 * returns validator of `missions.get` did not include orgId, so any mission
 * that has `orgId` set fails the Convex response validator → 500.
 *
 * Fix: add `orgId: v.optional(v.string())` to the inline returns block of
 * `missions.get`.
 *
 * Coverage:
 *   T1  get — mission WITH orgId → 200 + full doc including orgId
 *   T2  get — mission WITHOUT orgId → 200 + full doc (orgId omitted, not null)
 *   T3  update on mission WITH orgId → mutation 200 + get still returns orgId
 *   T4  update on mission WITHOUT orgId → mutation 200 (backward compat)
 *   T5  updateStatus on mission WITH orgId → mutation 200 + get still returns orgId
 *   T6  list regression — still returns docs without 500 (no returns validator → always passes, smoke)
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

// ─── Seed helpers ─────────────────────────────────────────────────────────────

/** Insert a mission WITH orgId (simulates post-PR #360 tenant-scoped row). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedMissionWithOrgId(ctx: any): Promise<string> {
	return await ctx.db.insert("missions", {
		name: "Mission with orgId",
		project: "vantage-peers",
		status: "execute" as const,
		priority: "high" as const,
		pilot: "sigma",
		agents: ["sigma", "eta"],
		createdBy: "sigma",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		orgId: "acme-hr", // the field missing from old validators
	});
}

/** Insert a mission WITHOUT orgId (pre-PR #360 legacy row — backward compat). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedMissionWithoutOrgId(ctx: any): Promise<string> {
	return await ctx.db.insert("missions", {
		name: "Mission without orgId",
		project: "vantage-peers",
		status: "plan" as const,
		priority: "medium" as const,
		pilot: "pi",
		agents: ["pi"],
		createdBy: "pi",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		// orgId intentionally omitted
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("missions.get — orgId returns-validator regression", () => {

	// ── T1: get — mission WITH orgId ─────────────────────────────────────────
	test("T1: missions.get returns full doc for mission WITH orgId (no validator 500)", async () => {
		const t = convexTest(schema, modules);
		let missionId: string | undefined;
		await t.run(async (ctx) => {
			missionId = await seedMissionWithOrgId(ctx);
		});

		// Before the fix this call triggered a 500: orgId was in the stored doc
		// but absent from the returns validator → Convex rejects the response.
		const result = await t.query(api.missions.get, { missionId: missionId as any });

		expect(result).not.toBeNull();
		expect(result?.name).toBe("Mission with orgId");
		// After fix: orgId is present in the returned document
		expect((result as any).orgId).toBe("acme-hr");
	});

	// ── T2: get — mission WITHOUT orgId (backward compat) ───────────────────
	test("T2: missions.get returns full doc for mission WITHOUT orgId (backward compat)", async () => {
		const t = convexTest(schema, modules);
		let missionId: string | undefined;
		await t.run(async (ctx) => {
			missionId = await seedMissionWithoutOrgId(ctx);
		});

		const result = await t.query(api.missions.get, { missionId: missionId as any });

		expect(result).not.toBeNull();
		expect(result?.name).toBe("Mission without orgId");
		// orgId absent in old doc — field must be omitted (not null, not error)
		expect((result as any).orgId).toBeUndefined();
	});
});

describe("missions.update + missions.updateStatus — smoke test with orgId mission shapes", () => {

	// ── T3: update on mission WITH orgId ────────────────────────────────────
	test("T3: missions.update on mission WITH orgId → updates + get returns full doc with orgId", async () => {
		const t = convexTest(schema, modules);
		let missionId: string | undefined;
		await t.run(async (ctx) => {
			missionId = await seedMissionWithOrgId(ctx);
		});

		await t.mutation(api.missions.update, {
			missionId: missionId as any,
			priority: "urgent",
		});

		const result = await t.query(api.missions.get, { missionId: missionId as any });
		expect(result?.priority).toBe("urgent");
		expect((result as any).orgId).toBe("acme-hr");
	});

	// ── T4: update on mission WITHOUT orgId ─────────────────────────────────
	test("T4: missions.update on mission WITHOUT orgId → updates + get returns full doc (backward compat)", async () => {
		const t = convexTest(schema, modules);
		let missionId: string | undefined;
		await t.run(async (ctx) => {
			missionId = await seedMissionWithoutOrgId(ctx);
		});

		await t.mutation(api.missions.update, {
			missionId: missionId as any,
			priority: "low",
		});

		const result = await t.query(api.missions.get, { missionId: missionId as any });
		expect(result?.priority).toBe("low");
		expect((result as any).orgId).toBeUndefined();
	});

	// ── T5: updateStatus on mission WITH orgId ───────────────────────────────
	test("T5: missions.updateStatus on mission WITH orgId → status updated + get returns orgId", async () => {
		const t = convexTest(schema, modules);
		let missionId: string | undefined;
		await t.run(async (ctx) => {
			missionId = await seedMissionWithOrgId(ctx);
		});

		await t.mutation(api.missions.updateStatus, {
			missionId: missionId as any,
			status: "validate",
		});

		const result = await t.query(api.missions.get, { missionId: missionId as any });
		expect(result?.status).toBe("validate");
		expect((result as any).orgId).toBe("acme-hr");
	});
});

describe("missions.list — regression guard (no returns validator — smoke)", () => {

	// ── T6: list regression ──────────────────────────────────────────────────
	test("T6: missions.list still returns docs for missions with and without orgId", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await seedMissionWithOrgId(ctx);
			await seedMissionWithoutOrgId(ctx);
		});

		const result = await t.query(api.missions.list, { fields: "lite", limit: 10 });

		expect(Array.isArray(result)).toBe(true);
		const items = result as Array<Record<string, unknown>>;
		expect(items.length).toBe(2);

		// lite projection: must have _id, name, status, priority, pilot, project
		for (const item of items) {
			expect(item).toHaveProperty("_id");
			expect(item).toHaveProperty("name");
			expect(item).toHaveProperty("status");
			expect(item).toHaveProperty("priority");
			expect(item).toHaveProperty("pilot");
			expect(item).toHaveProperty("project");
		}
	});
});
