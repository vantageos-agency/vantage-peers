import { v, ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { creatorValidator } from "./schema";
import { requireResolvedCaller, withOrgScope, type OrgScope } from "./lib/auth";
import { isFleetSystemCaller } from "./lib/systemCaller";
import {
	fleetOperatorRef,
	fleetOperatorSlug,
	sameTenantStamp,
	stampOfScope,
} from "./lib/operatorOrg";

// ─────────────────────────────────────────────────────────────────────────────
// Org-scope orchestrator enforcement (same defect class as
// convex/memories.ts's isNamespaceAllowedForScope and
// convex/messages.ts's isOrchestratorAllowedForScope — see
// .claude/rules/authority-attached-to-anonymous-object.md). diary has no
// namespace column; the owner key here is the `orchestrator` field. Master
// scope (no identity with legacy opt-in, or the recognized service-account
// identity) retains unrestricted access — preserves internal/MCP-server
// behaviour unchanged. A Clerk-org-scoped caller may only write/delete a
// diary entry whose `orchestrator` is in its own client_org_mapping row's
// allowedOrchestrators; anything else is denied.
// ─────────────────────────────────────────────────────────────────────────────

function isOrchestratorAllowedForScope(scope: OrgScope, orchestrator: string): boolean {
	if (scope.isMaster) return true;
	if (scope.orgSlug === null) return false;
	return scope.allowedOrchestrators.includes(orchestrator);
}

// The (orchestrator, date) key is a NAME that two organisations, or the fleet,
// can all hold, so it can name several rows. The tenants a caller may read and
// write are the stamps of its OWN range, selected through the
// by_org_orchestrator_date INDEX so a foreign tenant's row is never read, never
// returned, and can never lock the caller out.
//   master              -> the FLEET's range: operator-stamped (what
//                          backfill_org_stamp writes) then unstamped (what a
//                          master write writes), in that preference order.
//   operator-org member -> the SAME fleet range (RULING 4: unstamped rows ARE
//                          the operator org's range).
//   any other org       -> only the rows stamped with its own org. It never
//                          matches the unstamped range, and never the operator
//                          slug (it is not the operator org).
//   no tenant           -> nothing.
// The operator slug is derived at run time and only when EXACTLY ONE operator
// org is active; otherwise the fleet range is the unstamped rows alone.
async function readableTenants(
	ctx: QueryCtx,
	scope: OrgScope,
): Promise<(string | undefined)[]> {
	const operatorSlug = await fleetOperatorSlug(ctx.db);
	const fleet = operatorSlug === undefined ? [undefined] : [operatorSlug, undefined];
	if (scope.isMaster) return fleet;
	if (scope.orgSlug === null) return [];
	return scope.orgSlug === operatorSlug ? fleet : [scope.orgSlug];
}

// `.first()`, never `.unique()`: a row landing between deploy and backfill must
// not make the selection throw. Deterministic: the first tenant in
// readableTenants order that has a row.
async function ownDiaryRow(
	ctx: QueryCtx,
	scope: OrgScope,
	orchestrator: string,
	date: string,
): Promise<Doc<"diary"> | null> {
	for (const tenant of await readableTenants(ctx, scope)) {
		const row = await ctx.db
			.query("diary")
			.withIndex("by_org_orchestrator_date", (q) =>
				q.eq("orgId", tenant).eq("orchestrator", orchestrator).eq("date", date),
			)
			.first();
		if (row !== null) return row;
	}
	return null;
}

async function readRange(
	ctx: QueryCtx,
	scope: OrgScope,
	names: string[],
	from: string,
	to: string,
): Promise<Doc<"diary">[]> {
	const tenants = await readableTenants(ctx, scope);
	const perRange = await Promise.all(
		tenants.flatMap((tenant) =>
			names.map((name) =>
				ctx.db
					.query("diary")
					.withIndex("by_org_orchestrator_date", (q) =>
						q
							.eq("orgId", tenant)
							.eq("orchestrator", name)
							.gte("date", from)
							.lte("date", to),
					)
					.collect(),
			),
		),
	);
	return perRange
		.flat()
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// write — upsert diary entry (if entry exists for date+orchestrator, update it)
//
// v2.4.8: `createdBy` is server-supplied (auth-derived from oauthCtx.userId at
// the MCP layer, passed as a trusted arg). It is NOT accepted from the MCP
// client directly — the MCP handler derives it and passes it here. On insert,
// it records the authenticated author. On update (upsert), createdBy is NOT
// overwritten — preserving the original author captured at creation time.
// ─────────────────────────────────────────────────────────────────────────────

export const write = mutation({
	args: {
		date: v.string(),
		orchestrator: creatorValidator,
		content: v.string(),
		highlights: v.optional(v.array(v.string())),
		blockers: v.optional(v.array(v.string())),
		// v2.4.8: auth-derived author. MCP layer passes oauthCtx.userId here.
		// Optional for backwards compat (pre-v2.4.8 callers omit it).
		createdBy: v.optional(creatorValidator),
	},
	returns: v.id("diary"),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("diary:write", …) at mcp-server/src/tools.ts:5913 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
		// Fail-closed multi-tenant fix (defect class: authority attached
		// to an anonymously-registered object — see
		// .claude/rules/authority-attached-to-anonymous-object.md). write
		// used to accept ANY orchestrator name with no identity/scope
		// check at all — a direct call to the public Convex deployment
		// could write (or overwrite) any org's diary entries. withOrgScope
		// is called WITHOUT allowNoIdentityMaster — the MCP server always
		// presents a real Clerk identity (the caller's own org JWT or its
		// service-account token; see
		// mcp-server/src/authenticatedConvexClient.ts), so the
		// fail-closed default here never breaks that live path.
		const scope = await withOrgScope(ctx);
		if (!isOrchestratorAllowedForScope(scope, args.orchestrator)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not write a diary entry for orchestrator "${args.orchestrator}" — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		const now = Date.now();

		// Check for existing entry
		const existing = await ownDiaryRow(ctx, scope, args.orchestrator, args.date);

		if (existing !== null) {
			// R-52 — the row was selected as the caller's OWN (ownDiaryRow), so this
			// can only fire if that selection is ever loosened; it keeps the patch
			// bound to the row's server-stamped tenant. Master is unchanged.
			if (
				!scope.isMaster &&
				!sameTenantStamp(existing, stampOfScope(scope), await fleetOperatorRef(ctx.db))
			) {
				throw new ConvexError(
					`RBAC_DENIED: caller may not write diary entry ${existing._id} (orchestrator "${args.orchestrator}") — ${JSON.stringify({ orgSlug: scope.orgSlug, reason: "row-not-in-caller-org" })}`,
				);
			}
			// Update content fields only — do NOT overwrite createdBy (preserve
			// original auth-verified author captured at creation time).
			await ctx.db.patch(existing._id, {
				content: args.content,
				highlights: args.highlights,
				blockers: args.blockers,
			});
			return existing._id;
		}

		return await ctx.db.insert("diary", {
			date: args.date,
			orchestrator: args.orchestrator,
			content: args.content,
			highlights: args.highlights,
			blockers: args.blockers,
			createdBy: args.createdBy,
			createdAt: now,
			// R-52 tenant stamp, derived from the verified scope. A master write is
			// fleet-owned (unstamped), as `tasks` does.
			...(scope.isMaster || scope.orgSlug === null
				? {}
				: {
						orgId: scope.orgSlug,
						clerkOrgId: scope.orgClerkId,
					}),
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch diary entry by date + orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	args: {
		date: v.string(),
		orchestrator: creatorValidator,
	},
	returns: v.union(
		v.object({
			_id: v.id("diary"),
			_creationTime: v.number(),
			date: v.string(),
			orchestrator: creatorValidator,
			instanceId: v.optional(v.string()),
			content: v.string(),
			highlights: v.optional(v.array(v.string())),
			blockers: v.optional(v.array(v.string())),
			createdBy: v.optional(creatorValidator),
			createdAt: v.number(),
			orgId: v.optional(v.string()),
			clerkOrgId: v.optional(v.string()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		// GATE — CLOSED (roster-scoped): this door served any orchestrator's
		// diary entry to a caller presenting NO CREDENTIAL AT ALL. Diary rows are
		// owned by `orchestrator`, so an ordinary org member is NOT refused: it
		// reads entries of orchestrators in its OWN roster (same check as
		// `diary:list` / the writes); another org's entry reads as null.
		// isolation-contract: no reactive subscriber. Enumerated by command
		// against vantage-peers-dashboard:
		//   grep -rn "api\.diary\." --include=*.tsx --include=*.ts \
		//     app components hooks lib contexts providers  -> 0 hits
		// The MCP `diary_read` tool reads it one-shot.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "diary:get", { alsoRefusePreOrg: true });
		if (!isOrchestratorAllowedForScope(scope, args.orchestrator)) return null;
		return await ownDiaryRow(ctx, scope, args.orchestrator, args.date);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list diary entries by orchestrator, ordered by date desc
// ─────────────────────────────────────────────────────────────────────────────

// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
// convex/profiles.ts PROFILES_LIST_SCAN_CAP, lot 1 mission k574p02m). When
// paginating via `createdBefore`, the post-take filter only finds rows
// older than the cursor if the FETCH is wide enough to include them —
// mission k574p02m DEFECT 2, lot 2.
export const DIARY_LIST_SCAN_CAP = 2000;

const DIARY_LIST_ROW = v.object({
	_id: v.id("diary"),
	_creationTime: v.number(),
	date: v.string(),
	orchestrator: creatorValidator,
	instanceId: v.optional(v.string()),
	content: v.string(),
	highlights: v.optional(v.array(v.string())),
	blockers: v.optional(v.array(v.string())),
	createdBy: v.optional(creatorValidator),
	createdAt: v.number(),
	orgId: v.optional(v.string()),
	clerkOrgId: v.optional(v.string()),
});

export const list = query({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		orchestrator: v.optional(creatorValidator),
		// v2.4.8: filter by auth-derived author (distinct from orchestrator).
		// Applied universally post-take (mirrors tasks.ts:354-357 pattern).
		createdBy: v.optional(creatorValidator),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 1 — cursor paging anchor (forward, newest-first).
		createdBefore: v.optional(v.number()),
	},
	// The envelope arm is the refusal contract for the signed-in-no-organisation
	// caller (a mounted, subscribed render: never a throw, never the bytes of an
	// absence). An array is a served result.
	returns: v.union(
		v.array(DIARY_LIST_ROW),
		v.object({ refused: v.literal(true), items: v.array(DIARY_LIST_ROW) }),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 20;
		// Widen the fetch whenever a cursor is present, so the post-take
		// `createdBefore` filter has candidate rows older than the anchor to
		// find (mirrors profiles.ts `needsWideScan` / `fetchCap`).
		const needsWideScan = args.createdBefore !== undefined;
		const fetchCap = needsWideScan ? DIARY_LIST_SCAN_CAP + 1 : limit;

		// Fail-closed org scoping: diary has no orgId/tenantId column
		// (convex/schema.ts ~272-287), so a non-master caller is restricted to
		// entries whose `orchestrator` is in its own allowedOrchestrators list
		// — same mechanism lib/auth.ts:filterByOrgScope uses for tasks/missions,
		// applied here inline since diary rows expose `orchestrator` rather than
		// `pilot`/`assignedTo`. No org-specific literal is hardcoded: the allow
		// list comes entirely from the caller's resolved OrgScope.
		// R-50: reactively-subscribed public query — refuseWithoutThrow narrows
		// the signed-in-no-org branch to a typed refused scope (empty
		// allowedOrchestrators), answered below with the refusal envelope, never a
		// throw.
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });

		// REFUSAL SHAPE (task k17066vn8kh5v1a8xkgsx0bnxs8fjre5; four callers, see
		// .claude/rules/refusal-is-distinguishable-from-absence.md):
		//   anonymous          -> RAISES RBAC_DENIED naming "diary:list". No
		//     mounted render exists for a throw to crash (every dashboard route sits
		//     behind clerkMiddleware); an empty success was the defect.
		//   signed-in, no org  -> `{ refused: true, items: [] }`. Subscribed by
		//     components/activity/unified-activity-feed.tsx:158 and
		//     components/diary/diary-feed.tsx:67, both of which read the result
		//     through `readList` (bare array | envelope | refusal), so the envelope
		//     renders empty AND says it was refused. A throw would crash that render.
		//   org member         -> served its own roster's rows (below).
		//   fleet master       -> the bare array, unchanged.
		requireResolvedCaller(scope, "diary:list");
		if (!scope.isMaster && scope.orgSlug === null) {
			return { refused: true as const, items: [] };
		}

		if (!scope.isMaster && args.orchestrator !== undefined) {
			if (!scope.allowedOrchestrators.includes(args.orchestrator)) {
				return [];
			}
		}

		const orchestrator = args.orchestrator;
		let rows: Doc<"diary">[];
		if (orchestrator !== undefined && scope.isMaster) {
			rows = await ctx.db
				.query("diary")
				.withIndex("by_orchestrator_date", (q) =>
					q.eq("orchestrator", orchestrator),
				)
				.order("desc")
				.take(fetchCap);
		} else if (scope.isMaster) {
			rows = await ctx.db.query("diary").order("desc").take(fetchCap);
		} else {
			// Member (with or without an `orchestrator` argument). The tenant key is
			// the row's stamp (readableTenants: its own org, or the fleet range for
			// the operator org), the name key is the roster: one bounded indexed
			// read per (tenant, rostered name) instead of taking the table and
			// filtering afterwards, which both read other tenants' rows and let
			// their volume starve the member's page. The tenant ranges are disjoint
			// (distinct orgId values), so the merge needs no de-duplication; merged
			// newest-first by _creationTime, the order the table read used.
			const names =
				orchestrator !== undefined
					? [orchestrator]
					: [...new Set(scope.allowedOrchestrators)];
			const tenants = await readableTenants(ctx, scope);
			const perRange = await Promise.all(
				tenants.flatMap((tenant) =>
					names.map((name) =>
						ctx.db
							.query("diary")
							.withIndex("by_org_orchestrator_date", (q) =>
								q.eq("orgId", tenant).eq("orchestrator", name),
							)
							.order("desc")
							.take(fetchCap),
					),
				),
			);
			rows = perRange
				.flat()
				.sort((a, b) => b._creationTime - a._creationTime);
		}

		// Universal post-take createdBy filter — mirrors tasks.ts:371-373 pattern.
		// Anti-spoof guarantee per v2.4.8: createdBy is auth-derived at write time
		// (oauthCtx.userId from MCP layer), client cannot spoof.
		if (args.createdBy !== undefined) {
			rows = rows.filter((r) => r.createdBy === args.createdBy);
		}
		// S3.3 B8 follow-up batch 1 — cursor paging anchor: drop rows newer-or-equal to before.
		if (args.createdBefore !== undefined) {
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}
		// Re-bound to the requested page size now that the filter has run over
		// the widened superset (no-op when a wide scan wasn't needed).
		return rows.slice(0, limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteDiary — hard delete a diary entry by ID
// RBAC: callerOrchestrator must match entry.orchestrator or be "system"
// Pass callerOrchestrator=undefined to bypass (server-to-server / admin use).
// ─────────────────────────────────────────────────────────────────────────────

export const deleteDiary = mutation({
	args: {
		diaryId: v.id("diary"),
		callerOrchestrator: v.optional(creatorValidator),
	},
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		// write-contract: no caller exists outside convex-test — measured 2026-10-01 at origin/main 2498c00 with `grep -rnE "deleteDiary" /root/coding/vantage-peers-dashboard/{app,components,hooks,lib,contexts,providers} mcp-server/src --include=*.ts --include=*.tsx` (0 hits in the dashboard and mcp-server/src). A pre-organisation client shell cannot reach this write; the RBAC_DENIED throw below is the R-16 coded refusal of an unauthorised write, never an uncaught pre-org render crash.
		// Fail-closed multi-tenant fix (same defect class as write above)
		// — deleteDiary used to authorize solely on the client-supplied
		// callerOrchestrator argument: an anonymous caller (or a caller from
		// a DIFFERENT org) could pass "system" or the entry's own
		// orchestrator name and delete any org's diary entry. withOrgScope
		// is called WITHOUT allowNoIdentityMaster for the same reason as
		// write: the MCP server always presents a real Clerk identity on
		// this path.
		//
		// Resolved BEFORE ctx.db.get(args.diaryId) (mirrors convex-reviewer
		// REVISE on PR #1313 / messages.ts deleteMessage): an anonymous
		// caller must get RBAC_DENIED, never "Diary entry not found" — a
		// get-then-scope order lets diaryId existence act as an
		// unauthenticated existence oracle.
		const scope = await withOrgScope(ctx);

		// Anonymous/no-identity, non-master (isMaster===false, orgSlug===null)
		// can never pass isOrchestratorAllowedForScope for ANY orchestrator —
		// refuse here, before ctx.db.get, so a non-existent diaryId cannot be
		// distinguished from an existing-but-foreign one by an unauthenticated
		// caller.
		if (!scope.isMaster && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete diary entry ${args.diaryId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const entry = await ctx.db.get(args.diaryId);
		if (!entry) throw new Error("Diary entry not found");

		// R-52 — the entry's own server-stamped tenant must be the caller's; the
		// roster check below keys on a name another organisation may also hold.
		if (
			!scope.isMaster &&
			!sameTenantStamp(entry, stampOfScope(scope), await fleetOperatorRef(ctx.db))
		) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete diary entry ${args.diaryId} — ${JSON.stringify({ orgSlug: scope.orgSlug, reason: "row-not-in-caller-org" })}`,
			);
		}

		if (!isOrchestratorAllowedForScope(scope, entry.orchestrator)) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete diary entry ${args.diaryId} (orchestrator "${entry.orchestrator}") — ${JSON.stringify({ orgSlug: scope.orgSlug })}`,
			);
		}

		if (args.callerOrchestrator === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: callerOrchestrator is required to delete a diary entry — omitting it is refused, not exempted — ${JSON.stringify({ registration: "diary:deleteDiary", orgSlug: scope.orgSlug, reason: "caller-orchestrator-required" })}`,
			);
		}
		if (
			!isFleetSystemCaller(scope, args.callerOrchestrator) &&
			entry.orchestrator !== args.callerOrchestrator
		) {
			throw new ConvexError(
				`RBAC_DENIED: only ${entry.orchestrator} (owner) or system can delete this diary entry — ${JSON.stringify({ registration: "diary:deleteDiary", orgSlug: scope.orgSlug, reason: "not-owner" })}`,
			);
		}

		await ctx.db.delete(args.diaryId);
		return { deleted: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// listByDateRange — list diary entries between from and to dates (inclusive)
// ─────────────────────────────────────────────────────────────────────────────

export const listByDateRange = query({
	args: {
		from: v.string(),
		to: v.string(),
		orchestrator: v.optional(creatorValidator),
	},
	returns: v.array(
		v.object({
			_id: v.id("diary"),
			_creationTime: v.number(),
			date: v.string(),
			orchestrator: creatorValidator,
			instanceId: v.optional(v.string()),
			content: v.string(),
			highlights: v.optional(v.array(v.string())),
			blockers: v.optional(v.array(v.string())),
			createdBy: v.optional(creatorValidator),
			createdAt: v.number(),
			orgId: v.optional(v.string()),
			clerkOrgId: v.optional(v.string()),
		}),
	),
	handler: async (ctx, args) => {
		// GATE — CLOSED (roster-scoped), same shape as `diary:get` above: refuses
		// an unresolved caller; an ordinary member is served ONLY entries of
		// orchestrators in its own roster (filtered by the index predicate when
		// `orchestrator` is given, else per row), never another org's.
		// isolation-contract: no reactive subscriber (0 hits for
		// `api\.diary\.` in vantage-peers-dashboard app/components/hooks/lib).
		const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(scope, "diary:listByDateRange", {
			alsoRefusePreOrg: true,
		});
		if (args.orchestrator !== undefined) {
			const orchestrator = args.orchestrator;
			if (!isOrchestratorAllowedForScope(scope, orchestrator)) return [];
			if (scope.isMaster) {
				return await ctx.db
					.query("diary")
					.withIndex("by_orchestrator_date", (q) =>
						q
							.eq("orchestrator", orchestrator)
							.gte("date", args.from)
							.lte("date", args.to),
					)
					.order("asc")
					.collect();
			}
			// R-52: an org caller reads only its own tenant range of the name.
			return await readRange(ctx, scope, [orchestrator], args.from, args.to);
		}

		if (scope.isMaster) {
			return await ctx.db
				.query("diary")
				.withIndex("by_date", (q) =>
					q.gte("date", args.from).lte("date", args.to),
				)
				.order("asc")
				.collect();
		}
		// Member without an `orchestrator` arg: one indexed range read PER
		// (tenant range, rostered orchestrator) — the tenant and the roster are the
		// predicates of the read, not a filter applied to rows already read.
		return await readRange(
			ctx,
			scope,
			[...new Set(scope.allowedOrchestrators)],
			args.from,
			args.to,
		);
	},
});
