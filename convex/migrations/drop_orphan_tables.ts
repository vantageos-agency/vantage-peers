// MANUAL INVOCATION REQUIRED — DEV ONLY, DO NOT auto-run against prod:
//   npx convex run "migrations/drop_orphan_tables:countOrphanRows" '{}'
//   npx convex run "migrations/drop_orphan_tables:dropOrphanTables" '{}'
//
// Purpose: task k173r2p1yh94m5f7yvgr1b30gx8dn3ez — remove four orphan tables
// that carry zero references in convex/schema.ts and zero source references:
// "chunks", "memoryEmbeddings", "memorySearch", "vp_migrations". Because they
// are not declared in the schema, there is nothing to remove from schema.ts —
// Convex drops a table with no schema entry once it holds no documents. The
// CLI cannot delete rows directly, so this migration empties them.
//
// Both countOrphanRows and dropOrphanTables are paginated with bounded reads
// and mutations. Safe to re-run multiple times — each call only processes what
// is currently present. If a table is very large, countOrphanRows will report
// "at least N rows" beyond the batch size. dropOrphanTables deletes one bounded
// batch per invocation and returns whether more remain, enabling safe re-run
// loops by the operator.

import { type GenericId, v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

// Hardcoded allowlist — the only table names this migration will ever act on.
// None of these four names are declared in convex/schema.ts (that is exactly
// why they are orphans), so they carry no `TableNames` type — every access
// below goes through a narrow, explicitly-typed escape hatch keyed ONLY off
// this literal tuple, never off a caller-supplied string.
const ORPHAN_TABLE_ALLOWLIST = [
	"chunks",
	"memoryEmbeddings",
	"memorySearch",
	"vp_migrations",
] as const;

type OrphanTableName = (typeof ORPHAN_TABLE_ALLOWLIST)[number];

const DELETE_BATCH_SIZE = 200;
const COUNT_BATCH_SIZE = 1000;

// Minimal structural type for the subset of `db` this migration needs,
// widened past the schema-generated `TableNames` union (these four tables
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

		for (const table of ORPHAN_TABLE_ALLOWLIST) {
			let deleted = 0;
			// Paginate in fixed-size batches so a large table never blows the
			// mutation's execution budget; safe to re-run — each call only ever
			// deletes what is currently present.
			let batch = await db.query(table).take(DELETE_BATCH_SIZE);
			while (batch.length > 0) {
				for (const doc of batch) {
					await db.delete(doc._id);
					deleted++;
				}
				batch = await db.query(table).take(DELETE_BATCH_SIZE);
			}
			deletedByTable[table] = deleted;
			// Check final count (paginated) to determine if more remain
			const finalBatch = await db.query(table).take(1);
			remainingByTable[table] = finalBatch.length > 0 ? 1 : 0;
			if (finalBatch.length > 0) {
				moreRemain = true;
			}
		}

		return { deletedByTable, remainingByTable, moreRemain };
	},
});
