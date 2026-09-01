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
// implementations) and THE ONE ACTION (Eta, binding — report + write share
// one code path, a flag decides only whether the patch is issued) both live
// here.
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
	internalAction,
	internalMutation,
	internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
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
// (allowedOrchestrators === ["*"]). Fetched ONCE per run by the caller and
// passed into the resolver — never requeried per row.
export const _listRealClientOrgs = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			clerkOrgSlug: v.string(),
			allowedOrchestrators: v.array(v.string()),
		}),
	),
	handler: async (ctx): Promise<ClientOrg[]> => {
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
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SHARED RESOLVER
// ─────────────────────────────────────────────────────────────────────────────

export type ReceiptPairResolution =
	| { state: "same-client-org"; tenant: string; reason: string }
	| { state: "no-touch"; tenant: null; reason: string };

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
			tenant: senderOrgs[0].clerkOrgSlug,
			reason: "sender and recipient both resolve to the same single active client org",
		};
	}

	return {
		state: "no-touch",
		tenant: null,
		reason:
			"sender/recipient do not both resolve to the same single active client org — never guessed, left unmarked",
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Paginated page reader — mirrors receiptTenantAudit.ts's `_receiptTenantPage`
// shape, but only pages rows where tenantId === undefined (the closed,
// finite backfill population).
// ─────────────────────────────────────────────────────────────────────────────

export const _undefinedTenantReceiptPage = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
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
	handler: async (ctx, { cursor }) => {
		// undefined is not a valid index-equality value on a v.optional field via
		// a compound index here (no by_tenant index usable for "is undefined"), so
		// this mirrors receiptTenantAudit.ts's full-table scan + paginate — the
		// table is bounded (46906 rows at brief-authoring time) and this is a
		// one-shot maintenance action, not a hot query path.
		// messageId is now PRESENT (not omitted) — the both-ends rule needs it
		// to look up the message's sender (`message.from`).
		const page = await ctx.db
			.query("messageReceipts")
			.paginate({ numItems: 2000, cursor });
		const receipts = page.page
			.filter((r) => r.tenantId === undefined)
			.map((r) => ({
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
// Sender lookup — the both-ends rule needs `message.from` alongside
// `receipt.recipient`. A dedicated narrow projection (never spreads the raw
// message row) so the action only ever sees the one field it needs.
// ─────────────────────────────────────────────────────────────────────────────

export const _getMessageFrom = internalQuery({
	args: { messageId: v.id("messages") },
	returns: v.union(v.object({ from: v.string() }), v.null()),
	handler: async (ctx, { messageId }) => {
		const message = await ctx.db.get(messageId);
		if (message === null) return null;
		return { from: message.from };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Patch helper — idempotent (re-checks tenantId is STILL undefined before
// writing) and only ever called for state==="same-client-org" rows.
// ─────────────────────────────────────────────────────────────────────────────

export const _patchReceiptTenant = internalMutation({
	args: {
		receiptId: v.id("messageReceipts"),
		tenantId: v.string(),
	},
	returns: v.boolean(),
	handler: async (ctx, { receiptId, tenantId }) => {
		const row = await ctx.db.get(receiptId);
		if (row === null) return false;
		if (row.tenantId !== undefined) return false; // already stamped — idempotent no-op
		await ctx.db.patch(receiptId, { tenantId });
		return true;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ACTION — report and write share this exact code path; `dryRun`
// decides only whether the patch is issued.
// ─────────────────────────────────────────────────────────────────────────────

const backfillResultValidator = v.object({
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
});

export type BackfillReceiptTenantsResult = {
	total: number;
	perScope: Record<string, number>;
	notTouched: number;
	positiveControlSample: { receiptId: Id<"messageReceipts">; tenant: string } | null;
	dryRun: boolean;
	patched: number;
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

export const _receiptsForCaller = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			_id: v.id("messageReceipts"),
			recipient: v.string(),
			tenantId: v.optional(v.string()),
		}),
	),
	handler: async (ctx) => {
		const scope = await withOrgScope(ctx);

		// Defense-in-depth (mirrors listMessages's own degenerate-scope guard):
		// a non-master scope with no org slug can serve nothing.
		if (!scope.isMaster && scope.orgSlug === null) return [];

		if (scope.isMaster) {
			// Master reads the all-tenants path — not exercised by the
			// both-directions litmus (which asserts on the two SCOPED poles),
			// but kept honest with the rest of the repo's master/scoped split.
			const rows = await ctx.db.query("messageReceipts").collect();
			return rows.map((r) => ({
				_id: r._id,
				recipient: r.recipient,
				tenantId: r.tenantId,
			}));
		}

		const orgSlug = scope.orgSlug as string;
		const rows = await ctx.db
			.query("messageReceipts")
			.withIndex("by_tenant_recipient_unread", (q) => q.eq("tenantId", orgSlug))
			.collect();
		return rows.map((r) => ({
			_id: r._id,
			recipient: r.recipient,
			tenantId: r.tenantId,
		}));
	},
});

export const backfillReceiptTenants = internalAction({
	args: { dryRun: v.boolean() },
	returns: backfillResultValidator,
	handler: async (ctx, { dryRun }): Promise<BackfillReceiptTenantsResult> => {
		const clientOrgs: ClientOrg[] = await ctx.runQuery(
			internal.receiptTenantBackfill._listRealClientOrgs,
			{},
		);

		let total = 0;
		const perScope: Record<string, number> = {};
		let notTouched = 0;
		let positiveControlSample: {
			receiptId: Id<"messageReceipts">;
			tenant: string;
		} | null = null;
		let patched = 0;

		let cursor: string | null = null;
		let isDone = false;

		while (!isDone) {
			const page: {
				receipts: Array<{
					_id: Id<"messageReceipts">;
					messageId: Id<"messages">;
					recipient: string;
					recipientInstanceId?: string;
				}>;
				isDone: boolean;
				continueCursor: string | null;
			} = await ctx.runQuery(
				internal.receiptTenantBackfill._undefinedTenantReceiptPage,
				{ cursor },
			);

			for (const receipt of page.receipts) {
				total++;

				// Look up the message to get its sender — the both-ends rule
				// requires BOTH the sender and the recipient, not the recipient
				// alone (the leak the recipient-only rule had).
				const message = await ctx.runQuery(
					internal.receiptTenantBackfill._getMessageFrom,
					{ messageId: receipt.messageId },
				);

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
					perScope[resolution.tenant] =
						(perScope[resolution.tenant] ?? 0) + 1;
					if (positiveControlSample === null) {
						positiveControlSample = {
							receiptId: receipt._id,
							tenant: resolution.tenant,
						};
					}
					if (!dryRun) {
						const didPatch: boolean = await ctx.runMutation(
							internal.receiptTenantBackfill._patchReceiptTenant,
							{ receiptId: receipt._id, tenantId: resolution.tenant },
						);
						if (didPatch) patched++;
					}
				} else {
					notTouched++;
				}
			}

			isDone = page.isDone;
			cursor = page.continueCursor;
		}

		return {
			total,
			perScope,
			notTouched,
			positiveControlSample,
			dryRun,
			patched,
		};
	},
});
