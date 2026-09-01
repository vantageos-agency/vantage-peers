// One-shot READ-ONLY audit — task k171x0td6c1fyecsansna1gbr98dhwnk (#1257 read-half gate).
//
// Counts messageReceipts rows whose `tenantId` is undefined — the rows written
// BEFORE the T1 write-fix went live on prod (ead59b9, this morning). The write
// fix stamps `tenantId` at construction, so that population is CLOSED: it stops
// growing at the deploy instant and is a finite, countable set. The #1257 read
// half forces `eq("tenantId", scope.orgSlug)`, which cannot see an
// undefined-tenant row addressed to that very caller — so the size of this set
// is the gate: zero ⇒ no backfill needed; non-zero ⇒ backfill sizes itself here.
//
// POSITIVE CONTROL is returned alongside the count (Eta + Pi, binding): a
// non-zero `withTenant` and a real `positiveControlSampleReceiptId` prove the
// scan can return a populated row at all — so a `withoutTenant: 0` means "no such
// rows", never "the scan could not see the table". Paginated so it is correct for
// any table size (a bare .collect() would silently truncate past the read cap —
// the exact measure-nothing failure this audit exists to avoid).
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";

export const _receiptTenantPage = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		count: v.number(),
		withTenant: v.number(),
		withoutTenant: v.number(),
		sampleWith: v.union(v.id("messageReceipts"), v.null()),
		isDone: v.boolean(),
		continueCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db
			.query("messageReceipts")
			.paginate({ numItems: 2000, cursor });
		let withTenant = 0;
		let withoutTenant = 0;
		let sampleWith: (typeof page.page)[number]["_id"] | null = null;
		for (const r of page.page) {
			if (r.tenantId === undefined) {
				withoutTenant++;
			} else {
				withTenant++;
				if (sampleWith === null) sampleWith = r._id;
			}
		}
		return {
			count: page.page.length,
			withTenant,
			withoutTenant,
			sampleWith,
			isDone: page.isDone,
			continueCursor: page.isDone ? null : page.continueCursor,
		};
	},
});

// Top-level entry is a QUERY, not an action: `convex run` treats an action as a
// write vector (the prod guard refuses to classify it read-only), and a query is
// a single transaction that either scans the whole table or throws LOUDLY on the
// read cap — it never silently undercounts, which is the measurement-integrity
// property this audit must hold. If it throws on prod (table over the cap), that
// is a loud signal to page via `_receiptTenantPage` under a Pi token, not a zero.
export const countReceiptTenantPresence = internalQuery({
	args: {},
	returns: v.object({
		total: v.number(),
		withTenant: v.number(),
		withoutTenant: v.number(),
		positiveControlSampleReceiptId: v.union(v.id("messageReceipts"), v.null()),
	}),
	handler: async (ctx) => {
		let total = 0;
		let withTenant = 0;
		let withoutTenant = 0;
		let sampleWith: Id<"messageReceipts"> | null = null;
		for await (const r of ctx.db.query("messageReceipts")) {
			total++;
			if (r.tenantId === undefined) {
				withoutTenant++;
			} else {
				withTenant++;
				if (sampleWith === null) sampleWith = r._id;
			}
		}
		return {
			total,
			withTenant,
			withoutTenant,
			positiveControlSampleReceiptId: sampleWith,
		};
	},
});
