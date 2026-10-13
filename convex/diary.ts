import {
	hasFleetRead,
	isFleetStamp,
	type OrgRef,
	sameOrg,
	sameTenantStamp,
} from "@vantageos/cloud-identity";
import type { OrderedQuery } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import {
	authorIdOfLabel,
	claimedOrgArgs,
	requireClaimedScope,
} from "./contentClaims";
import { creatorValidator } from "./schema";
import {
	isMcpBoundMaster,
	requireResolvedCaller,
	withOrgScope,
	type OrgScope,
} from "./lib/auth";
import { isFleetSystemCaller } from "./lib/systemCaller";
import { fleetOperatorRef } from "./lib/operatorOrg";
import { orgRefOfRow, orgRefOfScope } from "./lib/authOrgMapping";
import { memoryAuthorOf } from "./lib/memoryTenant";
import { listedAgentsOfOrg } from "./lib/rosterIds";
import { agentIdOfLabelInOrg, isAgentOnScopeRoster } from "./lib/rosterLabels";

// ─────────────────────────────────────────────────────────────────────────────
// The diary is read and written by ID (modules M10b and F1; see
// .claude/rules/authority-attached-to-anonymous-object.md).
//
// TRANSPORT. Every MCP caller reaches these doors as the fleet service account.
// A call carries the organisation the transport VERIFIED for the bearer
// (`verifiedOrg`); a service-account call that carries none is refused, never
// served as master (convex/contentClaims.ts, backend standard R-54). A client
// org's claim runs the door under that org's MEMBER scope; the operator org's
// claim keeps the fleet's reach.
//
// TENANT. A row belongs to an organisation by its permanent Clerk org ID
// (`clerkOrgId`), judged by @vantageos/cloud-identity (`sameOrg`, `isFleetStamp`,
// `sameTenantStamp`). The slug on the row is a renamable label: a NEW org that
// took a freed label matches no row of the org that held it before. A row whose
// stamp carries no ID (not yet through backfill_org_clerk_id) is served to no
// client org: nothing is guessed.
//   fleet standing      -> the FLEET's range: rows stamped with the operator
//                          org's ID, then unstamped rows.
//   operator-org member -> the same fleet range.
//   any other org       -> only the rows stamped with its own org ID, selected
//                          through the by_org_agent_date_clerk_id INDEX, so a
//                          foreign row is never read and never a lockout.
//   no tenant           -> nothing.
//
// ORCHESTRATOR. A diary entry belongs to an AGENT: the row carries the
// orchestrator's `agents` row ID (`agentId`) and every selection, key and
// admission uses that ID. The label a caller types (`orchestrator`) is resolved
// to an ID in the caller's OWN org (the operator org for fleet standing), and a
// member's agent must be an entry of the org's stored ID roster
// (`allowedAgentIds`) through @vantageos/cloud-identity (`assertPrincipalListed`,
// via convex/lib/rosterLabels.ts). The label stays on the row as display text. A
// row written before the ID column carries none and is served to nobody until
// migrations/backfill_diary_agent_ids fills it.
//
// AUTHOR. A member's `createdBy` is the verified caller ("user:<subject>"). A
// claimed author that is anyone else is refused. Only the transport-verified
// service account supplies `createdBy` for the seat it authenticated. The row
// also stores the author's ID (`createdById`) so an author filter compares IDs.
// ─────────────────────────────────────────────────────────────────────────────

type DiaryQuery = OrderedQuery<DataModel["diary"]>;

// One diary row as the doors return it.
const DIARY_ROW = v.object({
	_id: v.id("diary"),
	_creationTime: v.number(),
	date: v.string(),
	orchestrator: creatorValidator,
	agentId: v.optional(v.id("agents")),
	instanceId: v.optional(v.string()),
	content: v.string(),
	highlights: v.optional(v.array(v.string())),
	blockers: v.optional(v.array(v.string())),
	createdBy: v.optional(creatorValidator),
	createdById: v.optional(v.string()),
	createdAt: v.number(),
	orgId: v.optional(v.string()),
	clerkOrgId: v.optional(v.string()),
});

/**
 * The agent a typed orchestrator label stands for, as an ID, or undefined.
 *   fleet standing -> the operator org's agent of that label (the fleet's own
 *                     orchestrators), judged active by the package;
 *   a member       -> the agent of that label in the member's OWN org, and only
 *                     when the org's stored ID roster lists it.
 * A label that names no such agent resolves to nothing: no row is selected by it.
 */
async function orchestratorIdOf(
	ctx: QueryCtx,
	scope: OrgScope,
	label: string,
	door: string,
): Promise<Id<"agents"> | undefined> {
	if (hasFleetRead(scope)) {
		const found = await agentIdOfLabelInOrg(ctx, { orgSlug: null }, label, door);
		return found === undefined
			? undefined
			: (ctx.db.normalizeId("agents", found) ?? undefined);
	}
	if (scope.orgSlug === null) return undefined;
	const found = await agentIdOfLabelInOrg(
		ctx,
		{
			orgSlug: scope.orgSlug,
			...(scope.orgClerkId !== undefined
				? { clerkOrgId: scope.orgClerkId }
				: {}),
		},
		label,
		door,
	);
	if (found === undefined) return undefined;
	if (!(await isAgentOnScopeRoster(ctx, scope, found, door))) return undefined;
	return ctx.db.normalizeId("agents", found) ?? undefined;
}

/**
 * The IDs of the agents of the caller's own org that its stored ID roster lists
 * (`listedAgentsOfOrg`: judged by agent ID through @vantageos/cloud-identity).
 * Empty for a caller with no org; fleet standing is not roster-bound and never asks.
 */
async function rosterAgentIds(
	ctx: QueryCtx,
	scope: OrgScope,
	door: string,
): Promise<Id<"agents">[]> {
	if (scope.orgSlug === null) return [];
	const listed = await listedAgentsOfOrg(
		ctx,
		scope.orgSlug,
		scope.allowedAgentIds,
		door,
	);
	return listed.map((agent) => agent._id);
}

type Tenant = {
	/** The clerkOrgId values whose index ranges the caller may read (undefined = unstamped). */
	keys: (string | undefined)[];
	/** The package's verdict on one row, applied to every row the ranges return. */
	owns: (row: Doc<"diary">) => boolean;
};

async function callerTenant(ctx: QueryCtx, scope: OrgScope): Promise<Tenant> {
	const operator = await fleetOperatorRef(ctx.db);
	const fleet: Tenant = {
		keys:
			typeof operator?.id === "string" ? [operator.id, undefined] : [undefined],
		owns: (row) => isFleetStamp(orgRefOfRow(row), operator),
	};
	if (hasFleetRead(scope)) return fleet;
	if (scope.orgSlug === null) return { keys: [], owns: () => false };
	const mine: OrgRef = orgRefOfScope(scope);
	if (operator !== undefined && sameOrg(mine, operator)) return fleet;
	return {
		keys: scope.orgClerkId === undefined ? [] : [scope.orgClerkId],
		owns: (row) => sameOrg(orgRefOfRow(row), mine),
	};
}

// `.first()`, never `.unique()`: a row landing between deploy and backfill must
// not make the selection throw. Deterministic: the first tenant key, in
// callerTenant order, that has a row the package says the caller owns.
async function ownDiaryRow(
	ctx: QueryCtx,
	scope: OrgScope,
	agentId: Id<"agents">,
	date: string,
): Promise<Doc<"diary"> | null> {
	const tenant = await callerTenant(ctx, scope);
	for (const key of tenant.keys) {
		// One row is wanted: the range is streamed and the first row the package
		// says the caller owns ends the read. At most DIARY_OWN_ROW_SCAN rows are
		// looked at (the range is a handful of rows a day); beyond that it fails
		// closed (no row).
		let seen = 0;
		for await (const row of ctx.db
			.query("diary")
			.withIndex("by_org_agent_date_clerk_id", (q) =>
				q.eq("clerkOrgId", key).eq("agentId", agentId).eq("date", date),
			)) {
			if (tenant.owns(row)) return row;
			seen += 1;
			if (seen >= DIARY_OWN_ROW_SCAN) break;
		}
	}
	return null;
}

const DIARY_OWN_ROW_SCAN = 8;

// One (tenant, orchestrator) range is a handful of rows a day; the bound keeps a
// range read from being unbounded and fails closed beyond it.
// Organisations a fleet range read walks (a mapped org each).
const DIARY_TENANT_CAP = 1000;
const DIARY_RANGE_SCAN_CAP = 2000;

// The tenant stamp of a diary row, derived from the verified scope: a fleet write is
// fleet-owned (unstamped), as `tasks` does.
function diaryTenantStamp(
	scope: OrgScope,
): { orgId: string; clerkOrgId: string | undefined } | Record<string, never> {
	if (hasFleetRead(scope) || scope.orgSlug === null) return {};
	return { orgId: scope.orgSlug, clerkOrgId: scope.orgClerkId };
}

async function readRange(
	ctx: QueryCtx,
	scope: OrgScope,
	agentIds: readonly Id<"agents">[],
	from: string,
	to: string,
): Promise<Doc<"diary">[]> {
	const tenant = await callerTenant(ctx, scope);
	const perRange = await Promise.all(
		tenant.keys.flatMap((key) =>
			agentIds.map((agentId) =>
				ctx.db
					.query("diary")
					.withIndex("by_org_agent_date_clerk_id", (q) =>
						q
							.eq("clerkOrgId", key)
							.eq("agentId", agentId)
							.gte("date", from)
							.lte("date", to),
					)
					.take(DIARY_RANGE_SCAN_CAP),
			),
		),
	);
	const owned: Doc<"diary">[] = [];
	for (const row of perRange.flat()) if (tenant.owns(row)) owned.push(row);
	return owned.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

async function readTenantRange(
	ctx: QueryCtx,
	scope: OrgScope,
	from: string,
	to: string,
): Promise<Doc<"diary">[]> {
	// The fleet reader serves every tenant (its standing is the whole fleet): one
	// indexed range per tenant key — the fleet's own (operator-stamped, unstamped)
	// and each mapped organisation's permanent ID. Never one scan across tenants.
	const fleet = await callerTenant(ctx, scope);
	const mappings = await ctx.db.query("client_org_mapping").take(DIARY_TENANT_CAP);
	const keys = new Set<string | undefined>(fleet.keys);
	for (const m of mappings) if (m.clerkOrgId !== undefined) keys.add(m.clerkOrgId);
	const perRange = await Promise.all(
		[...keys].map((key) =>
			ctx.db
				.query("diary")
				.withIndex("by_org_date_clerk_id", (q) =>
					q.eq("clerkOrgId", key).gte("date", from).lte("date", to),
				)
				.take(DIARY_RANGE_SCAN_CAP),
		),
	);
	return perRange
		.flat()
		.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

// The predicates of a `list` page that are not the tenant or the agent: the author
// (by ID) and the time cursor. They sit in the query builder, BEFORE the bound, so
// the page counts only rows the caller asked for (backend standard R-55).
function narrowPage(
	rows: DiaryQuery,
	createdById: string | undefined,
	createdBefore: number | undefined,
): DiaryQuery {
	let narrowed = rows;
	if (createdById !== undefined) {
		narrowed = narrowed.filter((f) => f.eq(f.field("createdById"), createdById));
	}
	if (createdBefore !== undefined) {
		narrowed = narrowed.filter((f) =>
			f.lt(f.field("_creationTime"), createdBefore),
		);
	}
	return narrowed;
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
		...claimedOrgArgs,
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
		const transport = await withOrgScope(ctx);
		const scope = await requireClaimedScope(
			ctx,
			transport,
			args.verifiedOrg,
			"diary:write",
		);
		const agentId = await orchestratorIdOf(
			ctx,
			scope,
			args.orchestrator,
			"diary:write",
		);
		if (agentId === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not write a diary entry for orchestrator "${args.orchestrator}" — ${JSON.stringify({ orgSlug: scope.orgSlug, reason: "orchestrator-not-listed" })}`,
			);
		}
		// The author is the verified caller: a member's stamp needs the org's
		// permanent ID, or the row it wrote could never be read back. The
		// transport-verified service account (the MCP server) passes the author of
		// the seat it authenticated; any other caller is a person, recorded as its
		// verified subject, and a claimed author that is anyone else is refused.
		const createdBy = isMcpBoundMaster(transport)
			? args.createdBy
			: memoryAuthorOf(scope, args.createdBy, "diary:write", false);
		const createdById = await authorIdOfLabel(ctx, scope, createdBy);
		if (!hasFleetRead(scope) && scope.orgClerkId === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: caller's organisation has no permanent org ID to stamp a diary entry with — ${JSON.stringify({ reason: "org-id-missing", door: "diary:write", orgSlug: scope.orgSlug })}`,
			);
		}

		const now = Date.now();

		// Check for existing entry
		const existing = await ownDiaryRow(ctx, scope, agentId, args.date);

		if (existing !== null) {
			// R-52 — the row was selected as the caller's OWN (ownDiaryRow), so this
			// can only fire if that selection is ever loosened; it keeps the patch
			// bound to the row's server-stamped tenant. Fleet standing is unchanged.
			if (
				!hasFleetRead(scope) &&
				!sameTenantStamp(
					orgRefOfRow(existing),
					orgRefOfScope(scope),
					await fleetOperatorRef(ctx.db),
				)
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
			agentId,
			content: args.content,
			highlights: args.highlights,
			blockers: args.blockers,
			createdBy,
			...(createdById === undefined ? {} : { createdById }),
			createdAt: now,
			// R-52 tenant stamp, derived from the verified scope. A fleet write is
			// fleet-owned (unstamped), as `tasks` does.
			...diaryTenantStamp(scope),
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
		...claimedOrgArgs,
	},
	returns: v.union(DIARY_ROW, v.null()),
	handler: async (ctx, args) => {
		// GATE — CLOSED (roster-scoped): this door served any orchestrator's
		// diary entry to a caller presenting NO CREDENTIAL AT ALL. Diary rows are
		// owned by an orchestrator agent, so an ordinary org member is NOT refused:
		// it reads entries of agents in its OWN roster (same check as
		// `diary:list` / the writes); another org's entry reads as null.
		// isolation-contract: no reactive subscriber. Enumerated by command
		// against vantage-peers-dashboard:
		//   grep -rn "api\.diary\." --include=*.tsx --include=*.ts \
		//     app components hooks lib contexts providers  -> 0 hits
		// The MCP `diary_read` tool reads it one-shot.
		const transport = await withOrgScope(ctx, { refuseWithoutThrow: true });
		const scope = await requireClaimedScope(
			ctx,
			transport,
			args.verifiedOrg,
			"diary:get",
		);
		requireResolvedCaller(scope, "diary:get", { alsoRefusePreOrg: true });
		const agentId = await orchestratorIdOf(
			ctx,
			scope,
			args.orchestrator,
			"diary:get",
		);
		if (agentId === undefined) return null;
		return await ownDiaryRow(ctx, scope, agentId, args.date);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list diary entries by orchestrator, ordered by date desc
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		// A LABEL the caller types; resolved to the agent's ID in the caller's org.
		orchestrator: v.optional(creatorValidator),
		// v2.4.8: filter by auth-derived author (distinct from orchestrator): a LABEL
		// resolved to the author's ID, and the page is read by that ID.
		createdBy: v.optional(creatorValidator),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 1 — cursor paging anchor (forward, newest-first).
		createdBefore: v.optional(v.number()),
		...claimedOrgArgs,
	},
	// The envelope arm is the refusal contract for the signed-in-no-organisation
	// caller (a mounted, subscribed render: never a throw, never the bytes of an
	// absence). An array is a served result.
	returns: v.union(
		v.array(DIARY_ROW),
		v.object({ refused: v.literal(true), items: v.array(DIARY_ROW) }),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 20;

		// Fail-closed org scoping: a non-fleet caller reads only the rows its
		// organisation owns by permanent org ID (callerTenant), and only the
		// orchestrators its org's ID roster lists (rosterAgentIds). No org-specific
		// literal is hardcoded: both come from the caller's resolved OrgScope.
		// R-50: reactively-subscribed public query — refuseWithoutThrow narrows
		// the signed-in-no-org branch to a typed refused scope (no org, no
		// roster), answered below with the refusal envelope, never a
		// throw.
		const transport = await withOrgScope(ctx, { refuseWithoutThrow: true });
		const scope = await requireClaimedScope(
			ctx,
			transport,
			args.verifiedOrg,
			"diary:list",
		);

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
		//   fleet standing     -> the bare array, unchanged.
		requireResolvedCaller(scope, "diary:list");
		if (!hasFleetRead(scope) && scope.orgSlug === null) {
			return { refused: true as const, items: [] };
		}

		// The author filter, by ID: a label that names nobody in the caller's org
		// matches no row (an empty page, not an error).
		const createdById =
			args.createdBy === undefined
				? undefined
				: await authorIdOfLabel(ctx, scope, args.createdBy);
		if (args.createdBy !== undefined && createdById === undefined) return [];

		// Which agents' entries are read: the one the typed label names, else (a
		// member) every agent its roster lists, else (fleet standing) every agent.
		let agentIds: Id<"agents">[] = [];
		let namedAgentId: Id<"agents"> | undefined;
		if (args.orchestrator !== undefined) {
			namedAgentId = await orchestratorIdOf(
				ctx,
				scope,
				args.orchestrator,
				"diary:list",
			);
			if (namedAgentId === undefined) return [];
			agentIds = [namedAgentId];
		} else if (!hasFleetRead(scope)) {
			agentIds = await rosterAgentIds(ctx, scope, "diary:list");
		}

		if (hasFleetRead(scope)) {
			const named = namedAgentId;
			const all: DiaryQuery =
				named === undefined
					? ctx.db.query("diary").order("desc")
					: ctx.db
							.query("diary")
							.withIndex("by_agent_date", (q) => q.eq("agentId", named))
							.order("desc");
			return await narrowPage(all, createdById, args.createdBefore).take(limit);
		}

		// Member: the tenant key is the row's permanent org ID (callerTenant), the
		// agent key is the ID roster (rosterAgentIds): one bounded indexed read per
		// (tenant, listed agent) instead of taking the table and filtering
		// afterwards, which both read other tenants' rows and let their volume starve
		// the member's page. The tenant ranges are disjoint (distinct clerkOrgId
		// values), so the merge needs no de-duplication; merged newest-first by
		// _creationTime, the order the table read used.
		const tenant = await callerTenant(ctx, scope);
		const perRange = await Promise.all(
			tenant.keys.flatMap((key) =>
				agentIds.map((agentId) =>
					narrowPage(
						ctx.db
							.query("diary")
							.withIndex("by_org_agent_date_clerk_id", (q) =>
								q.eq("clerkOrgId", key).eq("agentId", agentId),
							)
							.order("desc"),
						createdById,
						args.createdBefore,
					).take(limit),
				),
			),
		);
		const rows: Doc<"diary">[] = [];
		for (const row of perRange.flat()) if (tenant.owns(row)) rows.push(row);
		rows.sort((a, b) => b._creationTime - a._creationTime);
		return rows.slice(0, limit);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteDiary — hard delete a diary entry by ID
// RBAC: the caller's orchestrator is resolved to an agent ID and must be the
// entry's own agent, or the fleet's "system" word from the MCP-bound master.
// ─────────────────────────────────────────────────────────────────────────────

export const deleteDiary = mutation({
	args: {
		diaryId: v.id("diary"),
		// A LABEL the caller types; resolved to the agent's ID in the caller's org.
		callerOrchestrator: v.optional(creatorValidator),
		...claimedOrgArgs,
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
		const transport = await withOrgScope(ctx);
		const scope = await requireClaimedScope(
			ctx,
			transport,
			args.verifiedOrg,
			"diary:deleteDiary",
		);

		// Anonymous/no-identity, non-fleet (orgSlug===null) can never pass the
		// orchestrator check for ANY agent — refuse here, before ctx.db.get, so a
		// non-existent diaryId cannot be distinguished from an existing-but-foreign
		// one by an unauthenticated caller.
		if (!hasFleetRead(scope) && scope.orgSlug === null) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete diary entry ${args.diaryId} — ${JSON.stringify({ orgSlug: null })}`,
			);
		}

		const entry = await ctx.db.get(args.diaryId);
		if (!entry) throw new Error("Diary entry not found");

		// R-52 — the entry's own server-stamped tenant must be the caller's; the
		// roster check below keys on an agent another organisation may also name.
		if (
			!hasFleetRead(scope) &&
			!sameTenantStamp(
				orgRefOfRow(entry),
				orgRefOfScope(scope),
				await fleetOperatorRef(ctx.db),
			)
		) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete diary entry ${args.diaryId} — ${JSON.stringify({ orgSlug: scope.orgSlug, reason: "row-not-in-caller-org" })}`,
			);
		}

		if (args.callerOrchestrator === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: callerOrchestrator is required to delete a diary entry — omitting it is refused, not exempted — ${JSON.stringify({ registration: "diary:deleteDiary", orgSlug: scope.orgSlug, reason: "caller-orchestrator-required" })}`,
			);
		}
		// The deleting agent, by ID, in the caller's own org (a member's agent must be
		// on its roster). The fleet's "system" word is the MCP-bound master's alone.
		const callerAgentId = await orchestratorIdOf(
			ctx,
			scope,
			args.callerOrchestrator,
			"diary:deleteDiary",
		);
		if (
			!isFleetSystemCaller(transport, args.callerOrchestrator) &&
			(callerAgentId === undefined || entry.agentId !== callerAgentId)
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
		// A LABEL the caller types; resolved to the agent's ID in the caller's org.
		orchestrator: v.optional(creatorValidator),
		...claimedOrgArgs,
	},
	returns: v.array(DIARY_ROW),
	handler: async (ctx, args) => {
		// GATE — CLOSED (roster-scoped), same shape as `diary:get` above: refuses
		// an unresolved caller; an ordinary member is served ONLY entries of
		// agents in its own roster (filtered by the index predicate when
		// `orchestrator` is given, else per row), never another org's.
		// isolation-contract: no reactive subscriber (0 hits for
		// `api\.diary\.` in vantage-peers-dashboard app/components/hooks/lib).
		const transport = await withOrgScope(ctx, { refuseWithoutThrow: true });
		const scope = await requireClaimedScope(
			ctx,
			transport,
			args.verifiedOrg,
			"diary:listByDateRange",
		);
		requireResolvedCaller(scope, "diary:listByDateRange", {
			alsoRefusePreOrg: true,
		});
		if (args.orchestrator !== undefined) {
			const agentId = await orchestratorIdOf(
				ctx,
				scope,
				args.orchestrator,
				"diary:listByDateRange",
			);
			if (agentId === undefined) return [];
			if (hasFleetRead(scope)) {
				return await ctx.db
					.query("diary")
					.withIndex("by_agent_date", (q) =>
						q.eq("agentId", agentId).gte("date", args.from).lte("date", args.to),
					)
					.order("asc")
					.collect();
			}
			// R-52: an org caller reads only its own tenant range of the agent.
			return await readRange(ctx, scope, [agentId], args.from, args.to);
		}

		if (hasFleetRead(scope)) {
			// The fleet's own tenant range (operator-stamped and unstamped rows), by the
			// index: never a scan of every tenant's rows.
			return await readTenantRange(ctx, scope, args.from, args.to);
		}
		// Member without an `orchestrator` arg: one indexed range read PER
		// (tenant range, rostered agent) — the tenant and the roster are the
		// predicates of the read, not a filter applied to rows already read.
		return await readRange(
			ctx,
			scope,
			await rosterAgentIds(ctx, scope, "diary:listByDateRange"),
			args.from,
			args.to,
		);
	},
});
