/// <reference types="vite/client" />
/**
 * dashboard:getDashboardSummary — the returned profile rows carry ONLY the
 * fields the `returns` validator declares.
 *
 * DEFECT (#1423): the validator declares `dynamic: { currentTask, lastSeen,
 * sessionCount }` but the handler returned the raw profile rows. A profile
 * whose stored `dynamic` carries `endOfDayIndex` (a real, schema-valid field,
 * written by close-day) made the whole query throw ReturnsValidationError for
 * every caller.
 */
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
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

describe("dashboard:getDashboardSummary — profile projection (#1423)", () => {
	test("a profile carrying dynamic.endOfDayIndex does not throw, and no undeclared key is echoed", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert("profiles", {
				orchestratorId: "sigma",
				name: "sigma",
				static: { role: "sigma", workspace: "w", capabilities: ["x"] },
				dynamic: {
					currentTask: "t",
					endOfDayIndex: "SENTINEL_EOD_INDEX",
					lastSeen: 1,
					sessionCount: 2,
				},
			});
		});

		const s = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.dashboard.getDashboardSummary, {});

		expect(s.activeOrchestrators).toHaveLength(1);
		const p = s.activeOrchestrators[0];
		expect(Object.keys(p.dynamic).sort()).toEqual([
			"currentTask",
			"lastSeen",
			"sessionCount",
		]);
		expect(JSON.stringify(s)).not.toContain("SENTINEL_EOD_INDEX");
		expect(Object.keys(p).sort()).toEqual(
			[
				"_creationTime",
				"_id",
				"dynamic",
				"name",
				"orchestratorId",
				"static",
			].sort(),
		);
	});
});
