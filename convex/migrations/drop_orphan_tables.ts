// MANUAL INVOCATION REQUIRED — DEV ONLY, DO NOT auto-run against prod:
//   npx convex run "migrations/drop_orphan_tables:countOrphanRows" '{}'
//   npx convex run "migrations/drop_orphan_tables:dropOrphanTables" '{}'
//   (repeat the second command until it returns moreRemain: false)
//
// Purpose: remove five orphan tables that carry zero references in
// convex/schema.ts and zero source references: "chunks", "mcpTenants",
// "memoryEmbeddings", "memorySearch", "vp_migrations". "mcpTenants" was
// declared in the schema until the table-removal PR dropped its schema
// entry; it is now undeclared with leftover rows, exactly the same state
// as the other four. Because none of the five are declared in the schema,
// there is nothing to remove from schema.ts. This migration empties the
// rows — removing the resulting empty table shell is a separate dashboard
// step, not performed here.
//
// Each call to dropOrphanTables deletes exactly one bounded batch
// (DELETE_BATCH_SIZE=200 rows) from the first non-empty table, then returns.
// The operator must call it repeatedly until moreRemain is false.
// This ensures mutation execution budget is never exceeded, even on very large
// tables. Idempotent: safe to invoke repeatedly until all orphan tables are
// empty.

import { type GenericId, v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

// Hardcoded allowlist — the only table names this migration will ever act on.
// None of these five names are declared in convex/schema.ts (that is exactly
// why they are orphans), so they carry no `TableNames` type — every access
// below goes through a narrow, explicitly-typed escape hatch keyed ONLY off
// this literal tuple, never off a caller-supplied string.
const ORPHAN_TABLE_ALLOWLIST = [
	"chunks",
	"mcpTenants",
	"memoryEmbeddings",
	"memorySearch",
	"vp_migrations",
] as const;

type OrphanTableName = (typeof ORPHAN_TABLE_ALLOWLIST)[number];

const DELETE_BATCH_SIZE = 200;
const COUNT_BATCH_SIZE = 1000;

// Minimal structural type for the subset of `db` this migration needs,
// widened past the schema-generated `TableNames` union (these five tables
// have no schema entry, hence no generated type) while still requiring the
// caller to pass one of the hardcoded literal names above.
type UntypedTableDb = {
	query: (table: OrphanTableName) => {
		collect: () => Promise<{ _id: GenericId<string> }[]>;
		take: (n: number) => Promise<{ _id: GenericId<string> }[]>;
	};
	delete: (id: GenericId<string>) => Promise<void>;
};

export const countOrphanRows = internalQuery({
	args: {},
	returns: v.record(v.string(), v.number()),
	handler: async (ctx) => {
		const db = ctx.db as unknown as UntypedTableDb;
		const counts: Record<string, number> = {};
		for (const table of ORPHAN_TABLE_ALLOWLIST) {
			let totalCount = 0;
			const batch = await db.query(table).take(COUNT_BATCH_SIZE + 1);
			totalCount += batch.length;
			// If we got COUNT_BATCH_SIZE + 1 rows, there are more; report as "at least"
			// by truncating to COUNT_BATCH_SIZE and noting in a separate pass (operator
			// reads count and re-invokes if "at least" is reached).
			if (batch.length > COUNT_BATCH_SIZE) {
				counts[table] = COUNT_BATCH_SIZE; // Report batch size, not total (unbounded)
			} else {
				counts[table] = totalCount;
			}
		}
		return counts;
	},
});

export const dropOrphanTables = internalMutation({
	args: {},
	returns: v.object({
		deletedByTable: v.record(v.string(), v.number()),
		remainingByTable: v.record(v.string(), v.number()),
		moreRemain: v.boolean(),
	}),
	handler: async (ctx) => {
		const db = ctx.db as unknown as UntypedTableDb;
		const deletedByTable: Record<string, number> = {};
		const remainingByTable: Record<string, number> = {};
		let moreRemain = false;

		// Delete one bounded batch from the first non-empty table, then return.
		// Operator must call repeatedly until moreRemain is false.
		// This ensures one call never deletes more than DELETE_BATCH_SIZE rows
		// across all tables, keeping mutation execution budget bounded.
		for (const table of ORPHAN_TABLE_ALLOWLIST) {
			// Take one batch of rows from this table
			const batch = await db.query(table).take(DELETE_BATCH_SIZE);
			let deleted = 0;

			if (batch.length > 0) {
				// Delete this batch
				for (const doc of batch) {
					await db.delete(doc._id);
					deleted++;
				}
				deletedByTable[table] = deleted;

				// Check if more rows remain in this table
				const remaining = await db.query(table).take(1);
				remainingByTable[table] = remaining.length > 0 ? 1 : 0;
				if (remaining.length > 0) {
					moreRemain = true;
				}

				// Stop after this table — one batch per call
				return { deletedByTable, remainingByTable, moreRemain };
			} else {
				// This table is empty; record it and move to next
				deletedByTable[table] = 0;
				remainingByTable[table] = 0;
			}
		}

		// All tables are empty
		return { deletedByTable, remainingByTable, moreRemain };
	},
});
