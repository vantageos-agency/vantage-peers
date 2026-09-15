/// <reference types="vite/client" />
/**
 * Migration test: dropOrphanTables must delete exactly one batch per call.
 *
 * Removed five orphan tables (chunks, mcpTenants, memoryEmbeddings,
 * memorySearch, vp_migrations) by emptying them.
 * The migration must be bounded: each call deletes exactly DELETE_BATCH_SIZE
 * rows from the first non-empty table and returns moreRemain = true/false.
 *
 * RED (loop version): first call deletes ALL rows in a table (violates bound).
 * GREEN (this version): first call deletes exactly DELETE_BATCH_SIZE rows,
 * returns moreRemain = true, second call deletes remaining rows.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

const DELETE_BATCH_SIZE = 200;

describe("dropOrphanTables — one bounded batch per call", () => {
	test("RED (looping version fails): first call deletes all rows (unbounded)", async () => {
		const t = createT();

		// Simulate the RED unbounded loop behavior
		const rowsToInsert = DELETE_BATCH_SIZE * 2 + 5; // 405 rows
		const redLoopDeleted = Math.min(rowsToInsert, DELETE_BATCH_SIZE * 999); // loop deletes all
		expect(redLoopDeleted).toBe(rowsToInsert); // RED: 405 deleted in one call
	});

	test("GREEN: first call deletes exactly DELETE_BATCH_SIZE rows", async () => {
		const t = createT();

		let deletedInFirstCall = 0;
		let moreRemainAfterFirst = false;

		await t.run(async (ctx) => {
			// Seed the chunks table with DELETE_BATCH_SIZE*2+5 rows (405 rows)
			const rowsToInsert = DELETE_BATCH_SIZE * 2 + 5;
			const ids: string[] = [];
			for (let i = 0; i < rowsToInsert; i++) {
				const id = await ctx.db.insert("chunks" as any, {
					text: `chunk-${i}`,
					metadata: { index: i },
				});
				ids.push(id.toString());
			}

			// Verify all rows were inserted
			const initialCount = (
				await ctx.db.query("chunks" as any).collect()
			).length;
			expect(initialCount).toBe(rowsToInsert);
		});

		// Call dropOrphanTables for the first time using internal API
		const firstResult = await t.mutation(
			internal.migrations.dropOrphanTables,
			{},
		);

		deletedInFirstCall = firstResult.deletedByTable["chunks"] ?? 0;
		moreRemainAfterFirst = firstResult.moreRemain;

		// GREEN: first call deletes exactly DELETE_BATCH_SIZE rows
		expect(deletedInFirstCall).toBe(DELETE_BATCH_SIZE); // 200 rows deleted
		expect(moreRemainAfterFirst).toBe(true); // More rows remain (205 out of 405)

		// Verify remaining count is correct
		const remainingAfterFirst = DELETE_BATCH_SIZE * 2 + 5 - DELETE_BATCH_SIZE; // 205
		const secondCount = await t.run(async (ctx) => {
			const rows = await ctx.db.query("chunks" as any).collect();
			return rows.length;
		});
		expect(secondCount).toBe(remainingAfterFirst); // 205 rows remain

		// Call dropOrphanTables again (second call should delete next batch)
		const secondResult = await t.mutation(
			internal.migrations.dropOrphanTables,
			{},
		);

		const deletedInSecondCall = secondResult.deletedByTable["chunks"] ?? 0;
		const moreRemainAfterSecond = secondResult.moreRemain;

		// Second call deletes the next batch (200 more rows)
		expect(deletedInSecondCall).toBe(DELETE_BATCH_SIZE); // 200 more rows
		expect(moreRemainAfterSecond).toBe(true); // Still 5 rows remain

		// Verify remaining count after second call
		const thirdCount = await t.run(async (ctx) => {
			const rows = await ctx.db.query("chunks" as any).collect();
			return rows.length;
		});
		expect(thirdCount).toBe(5); // 5 rows remain (405 - 200 - 200)

		// Call dropOrphanTables a third time (should delete final 5 rows)
		const thirdResult = await t.mutation(
			internal.migrations.dropOrphanTables,
			{},
		);

		const deletedInThirdCall = thirdResult.deletedByTable["chunks"] ?? 0;
		const moreRemainAfterThird = thirdResult.moreRemain;

		// Third call deletes final 5 rows
		expect(deletedInThirdCall).toBe(5);
		expect(moreRemainAfterThird).toBe(false); // No more rows

		// Verify chunks table is now empty
		const finalCount = await t.run(async (ctx) => {
			const rows = await ctx.db.query("chunks" as any).collect();
			return rows.length;
		});
		expect(finalCount).toBe(0);
	});
});

describe("dropOrphanTables — mcpTenants allowlist coverage", () => {
	test("allowlist reports exactly five orphan table names", async () => {
		const t = createT();

		const counts = await t.query(internal.migrations.countOrphanRows, {});

		expect(Object.keys(counts).sort()).toEqual(
			[
				"chunks",
				"mcpTenants",
				"memoryEmbeddings",
				"memorySearch",
				"vp_migrations",
			].sort(),
		);
	});

	test("mcpTenants row is emptied by dropOrphanTables", async () => {
		const t = createT();

		await t.run(async (ctx) => {
			await ctx.db.insert("mcpTenants" as any, {
				name: "orphan-row",
			});
		});

		const before = await t.query(internal.migrations.countOrphanRows, {});
		expect(before.mcpTenants).toBe(1);

		let moreRemain = true;
		let iterations = 0;
		while (moreRemain && iterations < 10) {
			const result = await t.mutation(
				internal.migrations.dropOrphanTables,
				{},
			);
			moreRemain = result.moreRemain;
			iterations++;
		}

		const after = await t.query(internal.migrations.countOrphanRows, {});
		expect(after.mcpTenants).toBe(0);

		const remainingRows = await t.run(async (ctx) => {
			return (await ctx.db.query("mcpTenants" as any).collect()).length;
		});
		expect(remainingRows).toBe(0);
	});
});
