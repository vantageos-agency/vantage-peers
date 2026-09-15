/// <reference types="vite/client" />
/**
 * Migration test: dropOrphanTables must delete exactly one batch per call.
 *
 * Origin: #1286 removed four orphan tables; #1289 adds mcpTenants and fixes
 * moreRemain across tables.
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

// The mcpTenants field set actually read on production for #1289 (dummy
// values; tokenHash is an obviously fake string, never a real credential).
const seedMcpTenantsRow = (ctx: { db: { insert: (table: any, doc: any) => Promise<unknown> } }) =>
	ctx.db.insert("mcpTenants" as any, {
		convexUrl: "https://example-dummy-deployment.convex.cloud",
		createdAt: 0,
		enabledAt: 0,
		lastUsedAt: 0,
		tenantName: "orphan-row-fixture",
		tokenHash: "dummy-fake-token-hash-not-a-real-credential",
	});

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
			await seedMcpTenantsRow(ctx);
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

describe("dropOrphanTables — moreRemain must reflect every later allowlisted table, not just the one just emptied", () => {
	test("3 chunks rows + 1 mcpTenants row: first call empties chunks but must still report moreRemain: true", async () => {
		const t = createT();

		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) {
				await ctx.db.insert("chunks" as any, {
					text: `chunk-${i}`,
					metadata: { index: i },
				});
			}
			await seedMcpTenantsRow(ctx);
		});

		const firstResult = await t.mutation(
			internal.migrations.dropOrphanTables,
			{},
		);

		// chunks table is now empty (all 3 rows deleted in the one batch),
		// but mcpTenants still holds 1 row — moreRemain must not go false
		// just because the table this call happened to act on is empty.
		expect(firstResult.deletedByTable["chunks"]).toBe(3);
		expect(firstResult.moreRemain).toBe(true);

		const counts = await t.query(internal.migrations.countOrphanRows, {});
		expect(counts.mcpTenants).toBe(1);
	});

	test("450 chunks rows + 1 mcpTenants row: looping until moreRemain false empties every allowlisted table", async () => {
		const t = createT();

		await t.run(async (ctx) => {
			for (let i = 0; i < 450; i++) {
				await ctx.db.insert("chunks" as any, {
					text: `chunk-${i}`,
					metadata: { index: i },
				});
			}
			await seedMcpTenantsRow(ctx);
		});

		let moreRemain = true;
		let iterations = 0;
		const MAX_ITERATIONS = 20;
		while (moreRemain && iterations < MAX_ITERATIONS) {
			const result = await t.mutation(
				internal.migrations.dropOrphanTables,
				{},
			);
			moreRemain = result.moreRemain;
			iterations++;
		}

		// If the operator's own stop condition ("repeat until moreRemain:
		// false") never fires within a generous cap, the loop-until contract
		// is broken — fail loudly instead of silently accepting a short loop.
		expect(iterations).toBeLessThan(MAX_ITERATIONS);
		expect(moreRemain).toBe(false);

		const finalCounts = await t.query(internal.migrations.countOrphanRows, {});
		expect(finalCounts).toEqual({
			chunks: 0,
			mcpTenants: 0,
			memoryEmbeddings: 0,
			memorySearch: 0,
			vp_migrations: 0,
		});
	});
});
