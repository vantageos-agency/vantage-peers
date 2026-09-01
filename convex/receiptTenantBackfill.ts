// One-shot backfill for the `messageReceipts` rows written BEFORE the T1
// write-fix (ead59b9, this morning) that left `tenantId` undefined —
// task k171x0td6c1fyecsansna1gbr98dhwnk follow-up (#1257 write half).
//
// THE RULE (Pi, binding): every receipt must be readable by its intended
// recipient UNDER THE IDENTITY THAT RECIPIENT ACTUALLY AUTHENTICATES WITH.
//   - A recipient that authenticates SCOPED (a client-org orchestrator) must
//     have its receipts stamped with that org's tenant — the scoped read
//     path filters `eq("tenantId", scope.orgSlug)` and cannot see a null row.
//   - A recipient that authenticates as MASTER (fleet-internal orchestrator)
//     reads the all-tenants path — null is CORRECT for it, never stamp.
//   - A recipient whose identity cannot be resolved unambiguously goes to a
//     NAMED, COUNTED "unresolved" bucket — never a guessed tenant. A wrong
//     stamp (handing a row to a stranger) is categorically worse than a
//     missing one.
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

export type ReceiptTenantResolution =
	| { state: "scope"; tenant: string; reason: string }
	| { state: "null-master"; tenant: null; reason: string }
	| { state: "unresolved"; tenant: null; reason: string };

// Exported so the resolver and its call sites (report + write) are provably
// the ONE implementation — never duplicated between the dry-run report path
// and the write path.
export function resolveReceiptTenant(
	clientOrgs: ClientOrg[],
	recipient: string,
	_recipientInstanceId: string | undefined,
): ReceiptTenantResolution {
	const matches = clientOrgs.filter((org) =>
		org.allowedOrchestrators.includes(recipient),
	);

	if (matches.length === 1) {
		return {
			state: "scope",
			tenant: matches[0].clerkOrgSlug,
			reason: "recipient in exactly one active client org",
		};
	}

	if (matches.length === 0) {
		return {
			state: "null-master",
			tenant: null,
			reason:
				"recipient in no active client org — authenticates as master, null is correct",
		};
	}

	return {
		state: "unresolved",
		tenant: null,
		reason: "recipient in multiple client orgs — ambiguous, never guessed",
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
		const page = await ctx.db
			.query("messageReceipts")
			.paginate({ numItems: 2000, cursor });
		const receipts = page.page
			.filter((r) => r.tenantId === undefined)
			.map((r) => ({
				_id: r._id,
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
// Patch helper — idempotent (re-checks tenantId is STILL undefined before
// writing) and only ever called for state==="scope" rows.
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
	nullMaster: v.number(),
	unresolved: v.number(),
	resolvedScopeCount: v.number(),
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
	nullMaster: number;
	unresolved: number;
	resolvedScopeCount: number;
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
		let nullMaster = 0;
		let unresolved = 0;
		let resolvedScopeCount = 0;
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
				const resolution = resolveReceiptTenant(
					clientOrgs,
					receipt.recipient,
					receipt.recipientInstanceId,
				);

				if (resolution.state === "scope") {
					perScope[resolution.tenant] =
						(perScope[resolution.tenant] ?? 0) + 1;
					resolvedScopeCount++;
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
				} else if (resolution.state === "null-master") {
					nullMaster++;
				} else {
					unresolved++;
				}
			}

			isDone = page.isDone;
			cursor = page.continueCursor;
		}

		return {
			total,
			perScope,
			nullMaster,
			unresolved,
			resolvedScopeCount,
			positiveControlSample,
			dryRun,
			patched,
		};
	},
});
