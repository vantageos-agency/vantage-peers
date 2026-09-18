// One-shot backfill for the `messageReceipts` rows written BEFORE the T1
// write-fix (ead59b9, this morning) that left `tenantId` undefined —
// task k171x0td6c1fyecsansna1gbr98dhwnk follow-up (#1257 write half).
//
// THE RULE (Pi, binding, narrowed post-Eta-leak-finding): a receipt is
// backfilled ONLY IF its message's SENDER and its RECIPIENT both belong to
// the SAME single active client org. Otherwise it is left UNMARKED — no
// unresolved bucket, that state dissolves into "not touched".
//
// WHY (the leak this closes): the prior recipient-only rule stamped a
// receipt based on the RECIPIENT alone. A fleet-internal message
// (sender "pi" -> recipient "sigma") where "sigma" ALSO happens to sit in a
// client org's `allowedOrchestrators` roster got stamped INTO that client
// org — handing that client a receipt for a message it never sent or was
// ever meant to see. Both-ends-same-org is the only decidable, fail-closed
// fix: the org must be able to see BOTH the sender and the recipient as its
// own, not merely the recipient.
//
// CHANGELOG — knowingly accepted trade (Eta, binding): a receipt whose
// sender is fleet-internal but whose recipient IS a client-org agent is now
// NOT stamped, even though that agent could safely have read it under the
// old (leaky) rule. If that agent later reads scoped, this row stays
// invisible to them — a withheld grant, not a wrong one. Accepted because a
// withheld row surfaces as a reportable empty inbox (loud, fixable by a
// follow-up backfill once sender attribution is available), while a leaked
// row hands a stranger's message to the wrong tenant silently (unfixable
// after the fact — the read already happened). WITHHELD > LEAKED.
//
// THE SHARED RESOLVER (report and write call the SAME function — never two
// implementations) and THE ONE MUTATION (Eta, binding — report + write share
// one code path, a flag decides only whether the patch is issued) both live
// here.
//
// #1259 REVISE fix (Eta, backend-doctor R-11/R-46/R-6): the prior shape was
// an `internalAction` walking the whole table with one `runQuery`/
// `runMutation` round-trip PER ROW and no resume cursor — on prod (46906+
// rows) this both violated R-11 (page-then-post-filter selection) and had no
// bounded-transaction resume story: an action that hits the time limit
// restarts from row one, redoing already-patched work indefinitely. This is
// now a single self-scheduling `internalMutation`, modeled on
// `backfillReviewPrLinkFields` (convex/migrations.ts): each execution reads
// at most one bounded page via `.paginate()`, resolves + patches within that
// SAME transaction (no cross-call round-trips), and schedules its own
// continuation with the accumulated counters until `isDone`. No execution's
// read/write footprint depends on corpus size.
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server";
import { withOrgScope } from "./lib/auth";

// ─────────────────────────────────────────────────────────────────────────────
// Master sentinel + client-org fetch
// ─────────────────────────────────────────────────────────────────────────────

const MASTER_SENTINEL = "*";

export type ClientOrg = {
	clerkOrgSlug: string;
	allowedOrchestrators: string[];
};

// Real client orgs = active mapping rows that are NOT the master sentinel
// (allowedOrchestrators === ["*"]). Fetched ONCE per page by the mutation
// below — never requeried per row. Shared as a plain helper (not routed
// through ctx.runQuery) so the self-scheduling mutation reads it inside its
// own transaction, same discipline as `backfillReviewPrLinkFields`.
async function loadRealClientOrgs(
	ctx: QueryCtx | MutationCtx,
): Promise<ClientOrg[]> {
	const rows = await ctx.db
		.query("client_org_mapping")
		.withIndex("by_isActive", (q) => q.eq("isActive", true))
		.collect();
	return rows
		.filter(
			(r) =>
				!(
					r.allowedOrchestrators.length === 1 &&
					r.allowedOrchestrators[0] === MASTER_SENTINEL
				),
		)
		.map((r) => ({
			clerkOrgSlug: r.clerkOrgSlug,
			allowedOrchestrators: r.allowedOrchestrators,
		}));
}

// Public-shaped wrapper kept for direct inspection/testing of the same join
// the mutation below uses — never re-implemented, just exposed.
export const _listRealClientOrgs = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			clerkOrgSlug: v.string(),
			allowedOrchestrators: v.array(v.string()),
		}),
	),
	handler: async (ctx): Promise<ClientOrg[]> => loadRealClientOrgs(ctx),
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SHARED RESOLVER
// ─────────────────────────────────────────────────────────────────────────────

// The success arm's field is named `orgSlug` (not `tenant`) to match this
// codebase's established vocabulary for a resolved Clerk org slug
// (`ClientOrg.clerkOrgSlug`, `OrgScope.orgSlug` in convex/lib/auth.ts) — the
// SAME value this resolver hands to the write site below, so its provenance
// reads as what it is: a scope-derived slug, never a caller argument.
export type ReceiptPairResolution =
	| { state: "same-client-org"; orgSlug: string; reason: string }
	| { state: "no-touch"; orgSlug: null; reason: string };

// Exported so the resolver and its call sites (report + write) are provably
// the ONE implementation — never duplicated between the dry-run report path
// and the write path. ONE predicate (Eta: not two lookups that can drift):
// both the sender's org set and the recipient's org set must each resolve
// to exactly one org, AND it must be the SAME clerkOrgSlug. Any other case
// (either end fleet-internal, either end ambiguous, or the two ends
// resolving to different orgs) is no-touch.
//
// MEMBERSHIP IS A ROSTER FACT, DELIBERATELY NOT AN IDENTITY FACT (Eta,
// PR #1259 review). `client_org_mapping.allowedOrchestrators` says which
// orchestrator's DATA a client user may query — it says NOTHING about how
// that orchestrator itself authenticates. withOrgScope (convex/lib/auth.ts)
// decides the reading identity from the CLAIM the caller presents (org-claim
// -> scoped, isMaster:false; service-account / master-secret / no-org-claim
// -> master), never from a roster. Conflating the two — reading a recipient's
// roster presence as ownership of every receipt addressed to them — is exactly
// what produced the leak this narrowed rule closes. A dual-role agent that
// polls as itself with no org claim reads MASTER, so fleet-internal messages
// to it stay visible after this backfill; the scoped reader is the client's
// human user, not the orchestrator.
export function resolveReceiptPair(
	clientOrgs: ClientOrg[],
	sender: string,
	recipient: string,
): ReceiptPairResolution {
	const senderOrgs = clientOrgs.filter((org) =>
		org.allowedOrchestrators.includes(sender),
	);
	const recipientOrgs = clientOrgs.filter((org) =>
		org.allowedOrchestrators.includes(recipient),
	);

	if (
		senderOrgs.length === 1 &&
		recipientOrgs.length === 1 &&
		senderOrgs[0].clerkOrgSlug === recipientOrgs[0].clerkOrgSlug
	) {
		return {
			state: "same-client-org",
			orgSlug: senderOrgs[0].clerkOrgSlug,
			reason: "sender and recipient both resolve to the same single active client org",
		};
	}

	return {
		state: "no-touch",
		orgSlug: null,
		reason:
			"sender/recipient do not both resolve to the same single active client org — never guessed, left unmarked",
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Paginated page reader — pages ONLY rows where tenantId === undefined via
// the `by_tenant` index's `eq("tenantId", undefined)` branch (R-11 fix: the
// prior version paged the WHOLE table then post-filtered `tenantId ===
// undefined` in application code; this pushes the selection into the index
// itself, so a page can never contain an already-tenanted row at all — no
// post-filter needed or present).
//
// returns-projection: page reader for the #1259 backfill's one-shot scan —
// the both-ends resolver keys on recipient AND the message's sender (looked
// up via messageId), so messageId is present; tenantId is undefined by
// construction on this population (it is what the backfill sets) and readAt
// is irrelevant to tenant resolution, so both are omitted.
// ─────────────────────────────────────────────────────────────────────────────
export const _undefinedTenantReceiptPage = internalQuery({
	args: {
		cursor: v.union(v.string(), v.null()),
		numItems: v.optional(v.number()),
	},
	returns: v.object({
		receipts: v.array(
			v.object({
				_id: v.id("messageReceipts"),
				messageId: v.id("messages"),
				recipient: v.string(),
				recipientInstanceId: v.optional(v.string()),
			}),
		),
		isDone: v.boolean(),
		continueCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, { cursor, numItems }) => {
		const page = await ctx.db
			.query("messageReceipts")
			.withIndex("by_tenant", (q) => q.eq("tenantId", undefined))
			.paginate({ numItems: numItems ?? BACKFILL_BATCH_SIZE, cursor });
		const receipts = page.page.map((r) => ({
			_id: r._id,
			messageId: r.messageId,
			recipient: r.recipient,
			recipientInstanceId: r.recipientInstanceId,
		}));
		return {
			receipts,
			isDone: page.isDone,
			continueCursor: page.isDone ? null : page.continueCursor,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE MUTATION — self-scheduling, bounded per page. Report and write
// share this exact code path; `dryRun` decides only whether the patch is
// issued. Modeled on `backfillReviewPrLinkFields` (convex/migrations.ts):
// each execution reads and resolves at most `batchSize` rows inside its OWN
// transaction, then either returns (isDone) or schedules its own
// continuation carrying the running totals forward — never a per-row
// runQuery/runMutation round-trip, and never a single transaction whose
// footprint scales with corpus size.
//
// R-6 fix: the value patched into `tenantId` is `resolution.orgSlug` (bound
// to the local `tenantSlug` at the write site) — always DERIVED from the
// resource (the message's sender + the receipt's recipient, resolved
// through `resolveReceiptPair` against `client_org_mapping`) inside this
// same handler, never accepted as a caller-supplied argument. There is no
// exported mutation anywhere in this file that takes a `tenantId` argument.
// ─────────────────────────────────────────────────────────────────────────────

const BACKFILL_BATCH_SIZE = 200;

const backfillPageResultValidator = v.object({
	total: v.number(),
	perScope: v.record(v.string(), v.number()),
	notTouched: v.number(),
	positiveControlSample: v.union(
		v.object({
			receiptId: v.id("messageReceipts"),
			tenant: v.string(),
		}),
		v.null(),
	),
	dryRun: v.boolean(),
	patched: v.number(),
	isDone: v.boolean(),
});

export type BackfillReceiptTenantsResult = {
	total: number;
	perScope: Record<string, number>;
	notTouched: number;
	positiveControlSample: { receiptId: Id<"messageReceipts">; tenant: string } | null;
	dryRun: boolean;
	patched: number;
	isDone: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Minimal scoped-read probe for the both-directions test.
//
// DEVIATION FROM BRIEF: the brief's preferred surfaces (`checkNewMessages`,
// `listByChannel`) take `tenantId`/scope as an explicit caller-supplied arg
// or operate on `messages` (not `messageReceipts`) rather than deriving the
// tenant from `ctx.auth.getUserIdentity()` via `withOrgScope` the way
// `messages.listMessages` does. This minimal internalQuery mirrors
// `listMessages`'s own pattern instead: it takes NO orgSlug arg — the
// identity IS the input. `withOrgScope(ctx)` resolves `scope.orgSlug` from
// the caller's authenticated Clerk identity via the `client_org_mapping`
// join, and the query filters strictly on that resolved value. Deleting the
// `withOrgScope` call (or hardcoding a tenant) is what this test's litmus
// assertion is built to catch — see receiptTenantBackfill.test.ts's
// both-directions pole.
// ─────────────────────────────────────────────────────────────────────────────

// Named cap: this is a test-only scoped-identity probe (the both-directions
// litmus), never a hot production path, but the query guidelines still
// forbid an unbounded `.collect()`. 5000 comfortably exceeds any fixture
// this test seeds while staying well under the platform's per-execution
// document ceiling.
//
// LOUD, not silent (coordinator follow-up on the first cut of this fix,
// mirrors `fetchCappedOrOverflow`'s SCAN_CAP_EXCEEDED doctrine in
// briefingNotes.ts/tasks.ts): a `.take(CAP)` that quietly returns a
// truncated page is indistinguishable from "this is everyone" — on a
// backfill probe that is exactly the failure this whole PR closes for the
// underlying data, just relocated into the verification tool. So this
// fetches CAP+1 and THROWS ConvexError SCAN_CAP_EXCEEDED if that many come
// back, rather than silently handing the caller a short list.
export const RECEIPTS_FOR_CALLER_SCAN_CAP = 5000;

function capOrOverflow<T>(rows: T[], cap: number, label: string): T[] {
	if (rows.length > cap) {
		throw new ConvexError(
			`receiptTenantBackfill._receiptsForCaller: SCAN_CAP_EXCEEDED — ${label} hit the cap of ${cap} rows before the read completed. The result would be incomplete and indistinguishable from a full match.`,
		);
	}
	return rows;
}

// returns-projection: both-directions isolation-proof projection for the
// #1259 receipt-tenant backfill — the test authenticates as a scoped
// identity and asserts it reads only its own tenant's rows; the full
// receipt shape (messageId/recipientInstanceId/readAt) is irrelevant to that
// proof. Handler maps to this shape explicitly, never spreads the raw row.
export const _receiptsForCaller = internalQuery({
	// scanCapOverride exists ONLY so the pole test can seed CAP+1 rows
	// without seeding thousands — never set outside a test.
	args: { scanCapOverride: v.optional(v.number()) },
	returns: v.array(
		v.object({
			_id: v.id("messageReceipts"),
			recipient: v.string(),
			tenantId: v.optional(v.string()),
		}),
	),
	handler: async (ctx, { scanCapOverride }) => {
		const scope = await withOrgScope(ctx);
		const cap = scanCapOverride ?? RECEIPTS_FOR_CALLER_SCAN_CAP;

		// Defense-in-depth (mirrors listMessages's own degenerate-scope guard):
		// a non-master scope with no org slug can serve nothing.
		if (!scope.isMaster && scope.orgSlug === null) return [];

		if (scope.isMaster) {
			// Master reads the all-tenants path — not exercised by the
			// both-directions litmus (which asserts on the two SCOPED poles),
			// but kept honest with the rest of the repo's master/scoped split.
			const fetched = await ctx.db.query("messageReceipts").take(cap + 1);
			const rows = capOrOverflow(fetched, cap, "master all-tenants scan");
			return rows.map((r) => ({
				_id: r._id,
				recipient: r.recipient,
				tenantId: r.tenantId,
			}));
		}

		const orgSlug = scope.orgSlug as string;
		// by_tenant (tenantId-only) — NOT by_tenant_recipient_unread: this
		// probe wants every receipt in the tenant, read and unread alike, so
		// binding only tenantId is correct here and the *_unread scan-bound
		// class check does not track this index (no readAt field).
		const fetched = await ctx.db
			.query("messageReceipts")
			.withIndex("by_tenant", (q) => q.eq("tenantId", orgSlug))
			.take(cap + 1);
		const rows = capOrOverflow(fetched, cap, "scoped per-tenant scan");
		return rows.map((r) => ({
			_id: r._id,
			recipient: r.recipient,
			tenantId: r.tenantId,
		}));
	},
});

export const backfillReceiptTenants = internalMutation({
	args: {
		dryRun: v.boolean(),
		// Accumulator/continuation args — all optional so a first call
		// (`{ dryRun }` only) works exactly like the old entry point. The
		// self-scheduled continuation below always passes every field.
		cursor: v.optional(v.union(v.string(), v.null())),
		total: v.optional(v.number()),
		perScope: v.optional(v.record(v.string(), v.number())),
		notTouched: v.optional(v.number()),
		patched: v.optional(v.number()),
		positiveControlSample: v.optional(
			v.union(
				v.object({ receiptId: v.id("messageReceipts"), tenant: v.string() }),
				v.null(),
			),
		),
		// Test-only page-size override — never set outside a test — so the
		// pagination/resume path can be exercised without seeding thousands
		// of rows.
		batchSize: v.optional(v.number()),
	},
	returns: backfillPageResultValidator,
	handler: async (ctx, args): Promise<BackfillReceiptTenantsResult> => {
		const dryRun = args.dryRun;
		const batchSize = args.batchSize ?? BACKFILL_BATCH_SIZE;
		let total = args.total ?? 0;
		const perScope: Record<string, number> = { ...(args.perScope ?? {}) };
		let notTouched = args.notTouched ?? 0;
		let patched = args.patched ?? 0;
		let positiveControlSample: { receiptId: Id<"messageReceipts">; tenant: string } | null =
			args.positiveControlSample ?? null;

		const clientOrgs = await loadRealClientOrgs(ctx);

		// Bound selection pushed into the index itself (R-11 fix) — a page can
		// never contain an already-tenanted row, no post-filter needed.
		const page = await ctx.db
			.query("messageReceipts")
			.withIndex("by_tenant", (q) => q.eq("tenantId", undefined))
			.paginate({ numItems: batchSize, cursor: args.cursor ?? null });

		for (const receipt of page.page) {
			total++;

			// Look up the message to get its sender — the both-ends rule
			// requires BOTH the sender and the recipient, not the recipient
			// alone (the leak the recipient-only rule had). Direct ctx.db.get —
			// same transaction as the page read, no per-row round-trip.
			const message = await ctx.db.get(receipt.messageId);

			if (message === null) {
				// Dangling messageId (message deleted) — cannot resolve either
				// end. Fail-closed: no-touch, never guessed.
				notTouched++;
				continue;
			}

			const resolution = resolveReceiptPair(
				clientOrgs,
				message.from,
				receipt.recipient,
			);

			if (resolution.state === "same-client-org") {
				perScope[resolution.orgSlug] = (perScope[resolution.orgSlug] ?? 0) + 1;
				if (positiveControlSample === null) {
					positiveControlSample = {
						receiptId: receipt._id,
						tenant: resolution.orgSlug,
					};
				}
				if (!dryRun) {
					// The written value: `tenantSlug` — the resolved Clerk org slug
					// (never a caller argument; `resolution.orgSlug` is derived above
					// from the message's sender + this receipt's recipient against
					// `client_org_mapping`, the SAME shared resolver the dry-run
					// report path also reads).
					const tenantSlug = resolution.orgSlug;
					// GUARD (R-6): a receipt already carrying a tenantId is NEVER
					// re-tenanted. Re-checked via a fresh `ctx.db.get` (rather than
					// trusting the page snapshot) so the guard holds even if the
					// selection query above is ever loosened.
					const current = await ctx.db.get(receipt._id);
					if (current !== null && current.tenantId === undefined) {
						await ctx.db.patch(receipt._id, { tenantId: tenantSlug });
						patched++;
					}
				}
			} else {
				notTouched++;
			}
		}

		const isDone = page.isDone;

		if (!isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.receiptTenantBackfill.backfillReceiptTenants,
				{
					dryRun,
					cursor: page.continueCursor,
					total,
					perScope,
					notTouched,
					patched,
					positiveControlSample,
					batchSize: args.batchSize,
				},
			);
		}

		// Per-page counts only (never a corpus-wide claim from a single
		// execution) — same discipline as backfillReviewPrLinkFields /
		// backfillBriefingNoteParticipants. `isDone` is the only field that
		// means "the whole backfill is finished"; everything else here is the
		// running total carried across self-scheduled continuations.
		console.log(
			`receiptTenantBackfill: dryRun=${dryRun} scanned=${page.page.length} total=${total} patched=${patched} notTouched=${notTouched} isDone=${isDone} perScope=${JSON.stringify(perScope)}`,
		);

		return {
			total,
			perScope,
			notTouched,
			positiveControlSample,
			dryRun,
			patched,
			isDone,
		};
	},
});
