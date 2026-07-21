/// <reference types="vite/client" />
/**
 * convex/__tests__/setBillableProjects.test.ts
 *
 * Public-repo doctrine: the billableProjects list must never be a source
 * literal (client names would be permanent public git history). This suite
 * proves `setBillableProjects` (convex/migrations/seed_task_closure_config.ts)
 * lets an operator patch the row at RUNTIME instead, with the return value
 * as the evidence artifact (previous/current), and that it refuses to ever
 * write an empty list (which would silently disable the billing gate).
 *
 * All slugs used below are clearly fictitious ("acme-fictitious-co" /
 * "widgets-fictitious-inc") — never a real client name.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { isBillableProject } from "../lib/taskClosureGate";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);

describe("setBillableProjects — runtime-argument upsert (no client names in source)", () => {
	test("fresh (unseeded) table: inserts the row, previous=[] and current=<passed list>", async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(
			internal.migrations.seed_task_closure_config.setBillableProjects,
			{ projects: ["acme-fictitious-co"] },
		);

		expect(result.previous).toEqual([]);
		expect(result.current).toEqual(["acme-fictitious-co"]);

		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("taskClosureConfig")
				.withIndex("by_key", (q) => q.eq("key", "billableProjects"))
				.unique();
			expect(row?.value).toEqual(["acme-fictitious-co"]);
		});
	});

	test("existing row: replaces the value, returns correct previous and current", async () => {
		const t = convexTest(schema, modules);

		await t.mutation(
			internal.migrations.seed_task_closure_config.setBillableProjects,
			{ projects: ["acme-fictitious-co"] },
		);

		const result = await t.mutation(
			internal.migrations.seed_task_closure_config.setBillableProjects,
			{ projects: ["acme-fictitious-co", "widgets-fictitious-inc"] },
		);

		expect(result.previous).toEqual(["acme-fictitious-co"]);
		expect(result.current).toEqual([
			"acme-fictitious-co",
			"widgets-fictitious-inc",
		]);

		await t.run(async (ctx) => {
			const rows = await ctx.db.query("taskClosureConfig").collect();
			const billableRows = rows.filter((r) => r.key === "billableProjects");
			expect(billableRows).toHaveLength(1);
			expect(billableRows[0]?.value).toEqual([
				"acme-fictitious-co",
				"widgets-fictitious-inc",
			]);
		});
	});

	test("projects=[] throws — refuses to silently disable the billing gate", async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(
				internal.migrations.seed_task_closure_config.setBillableProjects,
				{ projects: [] },
			),
		).rejects.toThrow(/SET_BILLABLE_PROJECTS_EMPTY/);
	});

	test("round-trip: gate honours the newly written list (fictitious slugs only)", async () => {
		const t = convexTest(schema, modules);

		await t.mutation(
			internal.migrations.seed_task_closure_config.setBillableProjects,
			{ projects: ["acme-fictitious-co"] },
		);

		await t.run(async (ctx) => {
			expect(await isBillableProject(ctx, "acme-fictitious-co")).toBe(true);
			expect(await isBillableProject(ctx, "widgets-fictitious-inc")).toBe(
				false,
			);
		});
	});
});
