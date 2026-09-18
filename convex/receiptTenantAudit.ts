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
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";

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

// #1259 fix: this was a single-transaction `for await` walk over the WHOLE
// table — the file's own prior comment admitted it "throws on prod over the
// read cap", which is exactly the unbounded-scan class this repo's other
// backend-doctor fixes (#1287/#1290) close elsewhere. A single transaction
// that throws past ~32k documents is not a bound, it is a landmine sized to
// today's row count. Rewritten as an internalAction that walks the SAME
// paginated `_receiptTenantPage` query the file already exports, accumulating
// exact totals across pages — no single transaction ever reads more than one
// page's worth, and the loop itself is capped by a named constant so a
// pagination bug (a cursor that never reports isDone) cannot spin forever.
const RECEIPT_TENANT_AUDIT_PAGE_CAP = 200; // 200 * 2000/page = 400,000 rows headroom

export const countReceiptTenantPresence = internalAction({
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

		let cursor: string | null = null;
		let isDone = false;
		let pages = 0;

		while (!isDone) {
			pages++;
			if (pages > RECEIPT_TENANT_AUDIT_PAGE_CAP) {
				throw new Error(
					`countReceiptTenantPresence: exceeded ${RECEIPT_TENANT_AUDIT_PAGE_CAP} pages without isDone — refusing to spin forever rather than silently truncating`,
				);
			}
			const page: {
				count: number;
				withTenant: number;
				withoutTenant: number;
				sampleWith: Id<"messageReceipts"> | null;
				isDone: boolean;
				continueCursor: string | null;
			} = await ctx.runQuery(internal.receiptTenantAudit._receiptTenantPage, {
				cursor,
			});
			total += page.count;
			withTenant += page.withTenant;
			withoutTenant += page.withoutTenant;
			if (sampleWith === null) sampleWith = page.sampleWith;
			isDone = page.isDone;
			cursor = page.continueCursor;
		}

		return {
			total,
			withTenant,
			withoutTenant,
			positiveControlSampleReceiptId: sampleWith,
		};
	},
});
