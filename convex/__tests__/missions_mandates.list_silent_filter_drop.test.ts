/// <reference types="vite/client" />
//
// missions_mandates.list_silent_filter_drop.test.ts
// ─────────────────────────────────────────────────────────────────────────────
//
// Class-sweep follow-up to convex/__tests__/tasks.list_silent_filter_drop.test.ts.
// convex/missions.ts `list` (project + pilot) and convex/mandates.ts `list`
// (requestedBy + fulfilledBy) carry the SAME if/else-if-picks-one-index shape
// as the tasks.ts defect: no compound index covers the combination, so the
// branch chain would silently apply only one of the two filters.
//
// Fix: refuse the unsupported combination loudly instead of silently picking
// one side. These tests assert the refusal (RED before the guard existed —
// the pre-fix code would silently apply ONLY the first-matched filter and
// return a result rather than throwing).
// ─────────────────────────────────────────────────────────────────────────────

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

describe("missions.list — project + pilot refused loudly (not silently resolved)", () => {
	test("throws a clear error naming the unsupported combination", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx: unknown) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const c = ctx as any;
			await c.db.insert("missions", {
				name: "Fixture mission",
				pilot: "test-pilot-tau",
				agents: ["test-orch-tau"],
				project: "fixture-project-real",
				status: "execute",
				priority: "medium",
				createdBy: "test-orch-tau",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await expect(
			t.withIdentity({ subject: "test-service-account-user-id" }).query(api.missions.list, {
				project: "fixture-project-real",
				pilot: "test-pilot-tau",
				limit: 5,
			}),
		).rejects.toThrow(/project.*pilot|pilot.*project/i);
	});

	test("project alone still works (regression guard)", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx: unknown) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const c = ctx as any;
			await c.db.insert("missions", {
				name: "Fixture mission",
				pilot: "test-pilot-tau",
				agents: ["test-orch-tau"],
				project: "fixture-project-real",
				status: "execute",
				priority: "medium",
				createdBy: "test-orch-tau",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.missions.list, {
			project: "fixture-project-real",
			limit: 5,
		});
		expect(Array.isArray(result)).toBe(true);
	});
});

describe("mandates.list — requestedBy + fulfilledBy refused loudly (not silently resolved)", () => {
	test("throws a clear error naming the unsupported combination", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx: unknown) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const c = ctx as any;
			await c.db.insert("mandates", {
				requestedBy: "test-orch-tau",
				fulfilledBy: "test-orch-eta",
				service: "fixture service",
				budget: 100,
				status: "requested",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await expect(
			t.withIdentity({ subject: "test-service-account-user-id" }).query(api.mandates.list, {
				requestedBy: "test-orch-tau",
				fulfilledBy: "test-orch-eta",
				limit: 5,
			}),
		).rejects.toThrow(/requestedBy.*fulfilledBy|fulfilledBy.*requestedBy/i);
	});

	test("requestedBy alone still works (regression guard)", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx: unknown) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const c = ctx as any;
			await c.db.insert("mandates", {
				requestedBy: "test-orch-tau",
				fulfilledBy: "test-orch-eta",
				service: "fixture service",
				budget: 100,
				status: "requested",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.mandates.list, {
			requestedBy: "test-orch-tau",
			limit: 5,
		});
		expect(Array.isArray(result)).toBe(true);
	});
});
