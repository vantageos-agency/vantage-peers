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
import { loadRealClientOrgs } from "./receiptTenantBackfill";

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

// ─────────────────────────────────────────────────────────────────────────────
// countWithheldRecipientReceipts — task k17bf7bsfrm255x4pr5r96q5g58cw691
// follow-up (PR #1257 read-half gate, withheld-population instrument).
//
// `countReceiptTenantPresence` above answers "how many rows have no
// tenantId at all". It does NOT answer the question that actually matters
// once reads derive the tenant from the verified identity: of those
// untenanted rows, how many are addressed to a name that sits in a REAL
// client org's roster, and would therefore go dark the instant a scoped
// reader queries `eq("tenantId", orgSlug)`? `npx convex data` caps at 8192
// rows with no cursor, so this population was previously unmeasured on
// prod. This is READ-ONLY — it patches nothing, it only counts.
//
// Reuses `loadRealClientOrgs` (convex/receiptTenantBackfill.ts) — the SAME
// join the backfill uses to build its roster (excludes the master sentinel
// `allowedOrchestrators === ["*"]` and `orgKind === "operator"` rows) — never
// a duplicated predicate. A receipt's `recipient` OR `recipientInstanceId`
// matching a roster entry counts it as withheld under that org's slug; a
// name that sits in TWO OR MORE client rosters is ambiguous — counted once
// under the `ambiguous` bucket, never split or double-counted into perOrg.
const WITHHELD_RECIPIENT_PAGE_BATCH_SIZE = 2000;

export const _withheldRecipientPage = internalQuery({
	args: {
		cursor: v.union(v.string(), v.null()),
		// Test-only page-size override — never set outside a test — mirrors
		// receiptTenantBackfill's `batchSize` so the pagination/resume path can
		// be exercised without seeding thousands of rows.
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		scanned: v.number(),
		withheld: v.number(),
		perOrg: v.record(v.string(), v.number()),
		ambiguous: v.number(),
		sampleReceiptId: v.union(v.id("messageReceipts"), v.null()),
		// Distinct roster names checked THIS page — same value every page (the
		// roster is loaded once per page, never accumulated across pages), so
		// the caller can tell "checked against zero names" from "checked, no
		// match" rather than reading a bare zero.
		rosterSize: v.number(),
		isDone: v.boolean(),
		continueCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, { cursor, batchSize }) => {
		// Loaded ONCE per page — never requeried per row.
		const clientOrgs = await loadRealClientOrgs(ctx);
		const rosterNames = new Set<string>();
		for (const org of clientOrgs) {
			for (const name of org.allowedOrchestrators) {
				rosterNames.add(name);
			}
		}

		const page = await ctx.db
			.query("messageReceipts")
			.withIndex("by_tenant", (q) => q.eq("tenantId", undefined))
			.paginate({
				numItems: batchSize ?? WITHHELD_RECIPIENT_PAGE_BATCH_SIZE,
				cursor,
			});

		let withheld = 0;
		let ambiguous = 0;
		const perOrg: Record<string, number> = {};
		let sampleReceiptId: Id<"messageReceipts"> | null = null;

		for (const r of page.page) {
			const matchedSlugs = new Set<string>();
			for (const org of clientOrgs) {
				const recipientMatches = org.allowedOrchestrators.includes(
					r.recipient,
				);
				const instanceMatches =
					r.recipientInstanceId !== undefined &&
					org.allowedOrchestrators.includes(r.recipientInstanceId);
				if (recipientMatches || instanceMatches) {
					matchedSlugs.add(org.clerkOrgSlug);
				}
			}

			if (matchedSlugs.size === 1) {
				const [slug] = matchedSlugs;
				perOrg[slug] = (perOrg[slug] ?? 0) + 1;
				withheld++;
				if (sampleReceiptId === null) sampleReceiptId = r._id;
			} else if (matchedSlugs.size > 1) {
				ambiguous++;
				withheld++;
				if (sampleReceiptId === null) sampleReceiptId = r._id;
			}
		}

		return {
			scanned: page.page.length,
			withheld,
			perOrg,
			ambiguous,
			sampleReceiptId,
			rosterSize: rosterNames.size,
			isDone: page.isDone,
			continueCursor: page.isDone ? null : page.continueCursor,
		};
	},
});

// Named page cap — same discipline as RECEIPT_TENANT_AUDIT_PAGE_CAP above:
// a page-walking loop that never spins forever, throws rather than
// truncating silently past the cap.
const WITHHELD_RECIPIENT_AUDIT_PAGE_CAP = 200; // 200 * 2000/page = 400,000 rows headroom

export const countWithheldRecipientReceipts = internalAction({
	args: {
		// Test-only page-size override — never set outside a test — mirrors
		// receiptTenantBackfill's `batchSize` so the multi-page walk THROUGH
		// THIS ACTION (not just the underlying query) can be exercised without
		// seeding thousands of rows.
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		scanned: v.number(),
		withheld: v.number(),
		perOrg: v.record(v.string(), v.number()),
		ambiguous: v.number(),
		positiveControlSampleReceiptId: v.union(v.id("messageReceipts"), v.null()),
		// Distinct roster names checked — makes a zero withheld count with an
		// EMPTY roster visible as such, rather than indistinguishable from a
		// populated roster with zero matches.
		clientRosterSize: v.number(),
	}),
	handler: async (ctx, args) => {
		let scanned = 0;
		let withheld = 0;
		let ambiguous = 0;
		const perOrg: Record<string, number> = {};
		let sample: Id<"messageReceipts"> | null = null;
		let clientRosterSize = 0;

		let cursor: string | null = null;
		let isDone = false;
		let pages = 0;

		while (!isDone) {
			pages++;
			if (pages > WITHHELD_RECIPIENT_AUDIT_PAGE_CAP) {
				throw new Error(
					`countWithheldRecipientReceipts: exceeded ${WITHHELD_RECIPIENT_AUDIT_PAGE_CAP} pages without isDone — refusing to spin forever rather than silently truncating`,
				);
			}
			const page: {
				scanned: number;
				withheld: number;
				perOrg: Record<string, number>;
				ambiguous: number;
				sampleReceiptId: Id<"messageReceipts"> | null;
				rosterSize: number;
				isDone: boolean;
				continueCursor: string | null;
			} = await ctx.runQuery(
				internal.receiptTenantAudit._withheldRecipientPage,
				{ cursor, batchSize: args.batchSize },
			);
			scanned += page.scanned;
			withheld += page.withheld;
			ambiguous += page.ambiguous;
			for (const [slug, count] of Object.entries(page.perOrg)) {
				perOrg[slug] = (perOrg[slug] ?? 0) + count;
			}
			if (sample === null) sample = page.sampleReceiptId;
			clientRosterSize = page.rosterSize;
			isDone = page.isDone;
			cursor = page.continueCursor;
		}

		return {
			scanned,
			withheld,
			perOrg,
			ambiguous,
			positiveControlSampleReceiptId: sample,
			clientRosterSize,
		};
	},
});
