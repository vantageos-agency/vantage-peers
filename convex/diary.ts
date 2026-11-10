import {
	isFleetStamp,
	type OrgRef,
	sameOrg,
	sameTenantStamp,
} from "@vantageos/cloud-identity";
import { v, ConvexError } from "convex/values";
import type { FilterBuilder, NamedTableInfo } from "convex/server";
import type { DataModel, Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./lib/functions";
import { creatorValidator } from "./schema";
import { requireResolvedCaller, verifiedActorValidator, withOrgScope, type OrgScope } from "./lib/auth";
import { seatAgentIdOf } from "./lib/seatNamespace";
import { memoryAuthorIdOf } from "./lib/memoryTenant";
import { isFleetSystemCaller } from "./lib/systemCaller";
import { fleetOperatorRef, fleetWriteClerkOrgId } from "./lib/operatorOrg";
import { orgRefOfRow, orgRefOfScope } from "./lib/authOrgMapping";
import { memberActorOf, resolveHumanActor } from "./lib/humanActor";
import { requireMemberWriterRole } from "./memberWriterRoles";
import { listedAgentsOfOrg } from "./lib/rosterIds";
import { normalizeOrchestratorId } from "./_helpers/normalizeOrchestratorId";
import {
	resolveVerifiedOrgMapping,
	resolveVerifiedOrgScope,
	verifiedOrgValidator,
} from "./lib/verifiedOrg";

// ─────────────────────────────────────────────────────────────────────────────
// The diary is read and written by ID scope (module M10b; see
// .claude/rules/authority-attached-to-anonymous-object.md).
//
// TENANT. A row belongs to an organisation by its permanent Clerk org ID
// (`clerkOrgId`), judged by @vantageos/cloud-identity (`sameOrg`, `isFleetStamp`,
// `sameTenantStamp`). The slug on the row is a renamable label: a NEW org that
// took a freed label matches no row of the org that held it before. A row whose
// stamp carries no ID (not yet through backfill_org_clerk_id) is served to no
// client org: nothing is guessed.
//   master              -> the FLEET's range: rows stamped with the operator
//                          org's ID, then unstamped rows.
//   operator-org member -> the same fleet range.
//   any other org       -> only the rows stamped with its own org ID, selected
//                          through the by_org_orchestrator_date_clerk_id INDEX,
//                          so a foreign row is never read and never a lockout.
//   no tenant           -> nothing.
//
// ORCHESTRATOR. The orchestrator a member may reach is judged by AGENT ID: the
// name typed by the caller (or stored on the row) is looked up in the caller's
// OWN org, and the resulting agent must be an entry of the org's stored ID
// roster (`allowedAgentIds`) through @vantageos/cloud-identity
// (`assertPrincipalListed`, via convex/lib/rosterIds.ts). A name on the legacy
// name roster is no grant. Master retains unrestricted access.
//
// AUTHOR. A member's `createdBy` is the verified caller ("user:<subject>"). A
// claimed author that is anyone else is refused. Only the transport-verified
// master (the MCP server) supplies `createdBy` for the seat it authenticated.
//
// VERIFIED ORG (task k176723g3m5cczsq44ak9fbgm58hd0tx). A non-master MCP bearer
// reaches Convex as the fleet service account, so `withOrgScope` alone resolves
// MASTER: `list` read every tenant's rows of a name, `get` the fleet range, and
// `write` stored the row fleet-owned. The transport's `verifiedOrg` (believed
// from the service account only, convex/lib/verifiedOrg.ts) makes `write`, `get`
// and `list` run under that organisation's MEMBER scope, as `briefingNotes`
// does, so the tenant and the ID roster above apply to a seat exactly as they
// apply to a signed-in member. With no claim, each door is byte-unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The agents of the caller's own org that its stored ID roster lists
 * (`listedAgentsOfOrg`: judged by agent ID through @vantageos/cloud-identity).
 * Empty for a caller with no org; the master is not roster-bound and never asks.
 */
async function listedAgents(
	ctx: QueryCtx,
	scope: OrgScope,
	door: string,
): Promise<Doc<"agents">[]> {
	if (scope.orgSlug === null) return [];
	return await listedAgentsOfOrg(ctx, scope.orgClerkId, scope.allowedAgentIds, door);
}

/** Is `name` the label of an agent on the caller's ID roster? The master reaches every orchestrator. */
async function orchestratorListed(
	ctx: QueryCtx,
	scope: OrgScope,
	name: string,
	door: string,
): Promise<boolean> {
	if (scope.isMaster) return true;
	const claimed = normalizeOrchestratorId(name);
	return (await listedAgents(ctx, scope, door)).some(
		(agent) => normalizeOrchestratorId(agent.name) === claimed,
	);
}

/** The labels a listed agent's diary rows are stored under (the label, and its normalised form). */
async function rosterNames(
	ctx: QueryCtx,
	scope: OrgScope,
	door: string,
): Promise<string[]> {
	const names = new Set<string>();
	for (const agent of await listedAgents(ctx, scope, door)) {
		names.add(agent.name);
		if (agent.normalizedName !== undefined) names.add(agent.normalizedName);
	}
	return [...names];
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
	if (scope.isMaster) return fleet;
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
	orchestrator: string,
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
			.withIndex("by_org_orchestrator_date_clerk_id", (q) =>
				q.eq("clerkOrgId", key).eq("orchestrator", orchestrator).eq("date", date),
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
const DIARY_RANGE_SCAN_CAP = 2000;

async function readRange(
	ctx: QueryCtx,
	scope: OrgScope,
	names: string[],
	from: string,
	to: string,
): Promise<Doc<"diary">[]> {
	const tenant = await callerTenant(ctx, scope);
	const perRange = await Promise.all(
		tenant.keys.flatMap((key) =>
			names.map((name) =>
				ctx.db
					.query("diary")
					.withIndex("by_org_orchestrator_date_clerk_id", (q) =>
						q
							.eq("clerkOrgId", key)
							.eq("orchestrator", name)
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
		// Transport-verified org of a service-account bearer: the write is made
		// for that org (ID roster, tenant row, stamp). See the header.
		verifiedOrg: v.optional(verifiedOrgValidator),
		// The agent the transport verified, by its agents-row ID: stored as the entry's
		// author BY ID (`createdById`), the key the erase rule reads.
		verifiedActor: v.optional(verifiedActorValidator),
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
		// The org the write is made FOR: the verified org's member scope for a
		// service-account bearer carrying one, else the caller's own scope.
		// `scope` stays the transport scope for the author and writer-role checks.
		// The member scope is the one `withOrgScope` itself returns for the
		// verified org's ACTIVE mapping (the briefingNotes:create pattern), never
		// the claim's own value.
		const actingMapping = await resolveVerifiedOrgMapping(
			ctx,
			scope,
			args.verifiedOrg,
			"diary:write",
		);
		let tenantScope = scope;
		if (actingMapping !== undefined) {
			tenantScope = await withOrgScope(ctx, {
				refuseWithoutThrow: true,
				actForOrgMapping: actingMapping,
			});
		}
		if (!(await orchestratorListed(ctx, tenantScope, args.orchestrator, "diary:write"))) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not write a diary entry for orchestrator "${args.orchestrator}" — ${JSON.stringify({ orgSlug: tenantScope.orgSlug, reason: "orchestrator-not-listed" })}`,
			);
		}
		// A person writes only with a writer role (data: convex/memberWriterRoles.ts);
		// the master is the transport-verified MCP server and carries no member role.
		if (!scope.isMaster) await requireMemberWriterRole(ctx, scope, "diary:write");
		// The author is the verified caller (below); a member's stamp needs
		// the org's permanent ID, or the row it wrote could never be read back.
		// The master is the transport-verified MCP server and passes the author of
		// the seat it authenticated; any other caller is a person, recorded as its
		// verified subject, and a claimed author that is anyone else is refused.
		const ownAuthor =
			scope.isMaster || scope.serviceTransport === true
				? undefined
				: memberActorOf(scope);
		if (ownAuthor !== undefined && args.createdBy !== undefined && args.createdBy !== ownAuthor) {
			throw new ConvexError(
				`RBAC_DENIED: the author of a diary entry is the verified caller — ${JSON.stringify({ reason: "author-not-caller", door: "diary:write", orgSlug: scope.orgSlug })}`,
			);
		}
		const createdBy = ownAuthor ?? args.createdBy;
		// The author BY ID: the verified agent (judged by the one agent-proof check), or the
		// verified person; a label alone is not an identity.
		const createdById =
			createdBy === undefined
				? undefined
				: memoryAuthorIdOf(
						createdBy,
						await seatAgentIdOf(ctx, scope, args.verifiedActor),
						ownAuthor === undefined,
					);
		if (!tenantScope.isMaster && tenantScope.orgClerkId === undefined) {
			throw new ConvexError(
				`RBAC_DENIED: caller's organisation has no permanent org ID to stamp a diary entry with — ${JSON.stringify({ reason: "org-id-missing", door: "diary:write", orgSlug: tenantScope.orgSlug })}`,
			);
		}

		const now = Date.now();

		// Check for existing entry
		const existing = await ownDiaryRow(ctx, tenantScope, args.orchestrator, args.date);

		if (existing !== null) {
			// R-52 — the row was selected as the caller's OWN (ownDiaryRow), so this
			// can only fire if that selection is ever loosened; it keeps the patch
			// bound to the row's server-stamped tenant. Master is unchanged.
			if (
				!tenantScope.isMaster &&
				!sameTenantStamp(
					orgRefOfRow(existing),
					orgRefOfScope(tenantScope),
					await fleetOperatorRef(ctx.db),
				)
			) {
				throw new ConvexError(
					`RBAC_DENIED: caller may not write diary entry ${existing._id} (orchestrator "${args.orchestrator}") — ${JSON.stringify({ orgSlug: tenantScope.orgSlug, reason: "row-not-in-caller-org" })}`,
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

		const fleetClerkOrgId = await fleetWriteClerkOrgId(ctx.db, tenantScope.isMaster);
		return await ctx.db.insert("diary", {
			date: args.date,
			orchestrator: args.orchestrator,
			content: args.content,
			highlights: args.highlights,
			blockers: args.blockers,
			createdBy,
			...(createdById === undefined ? {} : { createdById }),
			createdAt: now,
			// R-52 tenant stamp, derived from the verified scope. A master write is
			// fleet-owned: it carries the operator organisation's permanent ID.
			...(tenantScope.isMaster || tenantScope.orgSlug === null
				? fleetClerkOrgId === undefined
					? {}
					: { clerkOrgId: fleetClerkOrgId }
				: {
						orgId: tenantScope.orgSlug,
						clerkOrgId: tenantScope.orgClerkId,
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
		// Transport-verified org of a service-account bearer (see the header).
		verifiedOrg: v.optional(verifiedOrgValidator),
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
			createdById: v.optional(v.string()),
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
		const transportScope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(transportScope, "diary:get", { alsoRefusePreOrg: true });
		// A service-account bearer's verified org: the read runs under that org's
		// member scope (its tenant range, its ID roster), never the fleet range.
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			"diary:get",
		);
		if (!(await orchestratorListed(ctx, scope, args.orchestrator, "diary:get"))) {
			return null;
		}
		return await ownDiaryRow(ctx, scope, args.orchestrator, args.date);
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list diary entries by orchestrator, ordered by date desc
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The caller's filters, matched by the READ on the index range BEFORE the take:
 * the author (`createdBy`, auth-derived at write time, so a client cannot spoof
 * it) and the cursor anchor (`createdBefore`, rows strictly older than it). One
 * site for the master and the member paths alike.
 */
function callerFilter(
	q: FilterBuilder<NamedTableInfo<DataModel, "diary">>,
	createdBy: string | undefined,
	createdBefore: number | undefined,
) {
	return q.and(
		createdBy !== undefined ? q.eq(q.field("createdBy"), createdBy) : true,
		createdBefore !== undefined
			? q.lt(q.field("_creationTime"), createdBefore)
			: true,
	);
}

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
	createdById: v.optional(v.string()),
	createdAt: v.number(),
	orgId: v.optional(v.string()),
	clerkOrgId: v.optional(v.string()),
});

/**
 * The most rows one fleet-master `list` call reads when it filters by `createdBy`
 * without an `orchestrator`. 500 rows of ~9 KB stay well under Convex's per-call
 * read ceiling; a sparse author needs several calls, each carrying a cursor.
 */
export const DIARY_LIST_SCAN_CAP = 500;

export const list = query({
	args: {
	fields: v.optional(v.union(v.literal("lite"), v.literal("full"))), // v2.4.12 accept (no-op for now) — closes ArgumentValidationError from MCP wrappers passing fields
		orchestrator: v.optional(creatorValidator),
		// v2.4.8: filter by auth-derived author (distinct from orchestrator).
		// Applied by the read, before the take (see `callerFilter`).
		createdBy: v.optional(creatorValidator),
		limit: v.optional(v.number()),
		// S3.3 B8 follow-up batch 1 — cursor paging anchor (forward, newest-first).
		createdBefore: v.optional(v.number()),
		// Transport-verified org of a service-account bearer (see the header).
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	// The envelope arm is the refusal contract for the signed-in-no-organisation
	// caller (a mounted, subscribed render: never a throw, never the bytes of an
	// absence). An array is a served result.
	// The `partial` arm is the fleet master's capped page (see DIARY_LIST_SCAN_CAP):
	// fewer than `limit` matches were found inside the scan window, and
	// `nextCreatedBefore` is the cursor anchor that resumes the scan.
	returns: v.union(
		v.array(DIARY_LIST_ROW),
		v.object({ refused: v.literal(true), items: v.array(DIARY_LIST_ROW) }),
		v.object({
			partial: v.literal(true),
			items: v.array(DIARY_LIST_ROW),
			nextCreatedBefore: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const limit = args.limit ?? 20;

		// Fail-closed org scoping: a non-master caller reads only the rows its
		// organisation owns by permanent org ID (callerTenant), and only the
		// orchestrators its org's ID roster lists (rosterNames). No org-specific
		// literal is hardcoded: both come from the caller's resolved OrgScope.
		// R-50: reactively-subscribed public query — refuseWithoutThrow narrows
		// the signed-in-no-org branch to a typed refused scope (no org, no
		// roster), answered below with the refusal envelope, never a
		// throw.
		const transportScope = await withOrgScope(ctx, { refuseWithoutThrow: true });

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
		requireResolvedCaller(transportScope, "diary:list");
		// A service-account bearer's verified org: the read runs under that org's
		// member scope, so the member branch below (tenant-keyed index ranges of
		// the org's ID roster) IS the read and the master branch is not reached.
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			"diary:list",
		);
		if (!scope.isMaster && scope.orgSlug === null) {
			return { refused: true as const, items: [] };
		}

		if (!scope.isMaster && args.orchestrator !== undefined) {
			if (!(await orchestratorListed(ctx, scope, args.orchestrator, "diary:list"))) {
				return [];
			}
		}

		const orchestrator = args.orchestrator;
		const createdBy = args.createdBy;
		const before = args.createdBefore;
		// Every caller filter (the author, the cursor anchor) is applied by the READ,
		// before each take, never to the rows a take already cut: a page whose newest
		// rows belong to another author used to come back short, with no cursor,
		// while matching entries sat below. The page is therefore `limit` matching
		// rows (or fewer only when fewer exist), and the fetch is not widened.
		let rows: Doc<"diary">[];
		if (orchestrator !== undefined && scope.isMaster) {
			rows = await ctx.db
				.query("diary")
				.withIndex("by_orchestrator_date", (q) =>
					q.eq("orchestrator", orchestrator),
				)
				.order("desc")
				.filter((q) => callerFilter(q, createdBy, before))
				.take(limit);
		} else if (scope.isMaster) {
			// The table's own `_creationTime` order: the cursor anchor is an index
			// bound. `createdBy` is a NAME stamped on legacy rows too, so no ID-keyed
			// index serves it and a name-keyed one would count against R-53: the
			// author is matched by the read, inside a WINDOW of at most
			// DIARY_LIST_SCAN_CAP rows per call, never over the whole table. The window
			// is found first (its oldest `_creationTime`), then the filtered read is
			// confined to it by an index bound, so the filter still runs before the take.
			const window = await ctx.db
				.query("diary")
				.withIndex("by_creation_time", (q) =>
					before !== undefined ? q.lt("_creationTime", before) : q,
				)
				.order("desc")
				.take(DIARY_LIST_SCAN_CAP);
			if (createdBy === undefined) {
				rows = window;
			} else {
				const capped = window.length >= DIARY_LIST_SCAN_CAP;
				const oldest = capped ? window[window.length - 1]._creationTime : undefined;
				const matched = await ctx.db
					.query("diary")
					.withIndex("by_creation_time", (q) => {
						if (oldest !== undefined && before !== undefined) {
							return q.gte("_creationTime", oldest).lt("_creationTime", before);
						}
						if (oldest !== undefined) return q.gte("_creationTime", oldest);
						if (before !== undefined) return q.lt("_creationTime", before);
						return q;
					})
					.order("desc")
					.filter((q) => callerFilter(q, createdBy, undefined))
					.take(limit);
				if (oldest !== undefined && matched.length < limit) {
					// The cap was hit before the page filled: the rows found so far, plus
					// the `_creationTime` of the oldest row SCANNED (not of the last match),
					// from which the next call resumes with no gap.
					return {
						partial: true as const,
						items: matched,
						nextCreatedBefore: oldest,
					};
				}
				rows = matched;
			}
		} else {
			// Member (with or without an `orchestrator` argument). The tenant key is
			// the row's permanent org ID (callerTenant), the name key is the ID
			// roster (rosterNames): one bounded indexed read per (tenant, listed
			// orchestrator) instead of taking the table and filtering afterwards,
			// which both read other tenants' rows and let their volume starve the
			// member's page. The tenant ranges are disjoint (distinct clerkOrgId
			// values), so the merge needs no de-duplication; merged newest-first by
			// _creationTime, the order the table read used. Each range returns its
			// own `limit` newest MATCHING rows, so the merged top `limit` is exact.
			const names =
				orchestrator !== undefined
					? [orchestrator]
					: await rosterNames(ctx, scope, "diary:list");
			const tenant = await callerTenant(ctx, scope);
			const perRange = await Promise.all(
				tenant.keys.flatMap((key) =>
					names.map((name) =>
						ctx.db
							.query("diary")
							.withIndex("by_org_orchestrator_date_clerk_id", (q) =>
								q.eq("clerkOrgId", key).eq("orchestrator", name),
							)
							.order("desc")
							.filter((q) => callerFilter(q, createdBy, before))
							.take(limit),
					),
				),
			);
			rows = [];
			for (const row of perRange.flat()) if (tenant.owns(row)) rows.push(row);
			rows.sort((a, b) => b._creationTime - a._creationTime);
		}

		// The merged member ranges can hold more than one page.
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
		// can never pass orchestratorListed for ANY orchestrator —
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

		// HUMAN path (task k17d5k5bw741p3681bc0pq76ah8fk4sn): a dashboard org:admin
		// deletes an entry of its OWN organisation in its own name, whichever agent
		// wrote it. Destructive: admin only (same decision as messages:deleteMessage).
		if (args.callerOrchestrator === undefined && !scope.isMaster) {
			await resolveHumanActor(ctx, scope, {
				door: "diary:deleteDiary",
				row: { orgId: entry.orgId },
				rowKind: "diary entry",
				rowId: args.diaryId,
				tenantOnly: true,
				adminOnly: true,
			});
			await ctx.db.delete(args.diaryId);
			return { deleted: true };
		}

		if (!(await orchestratorListed(ctx, scope, entry.orchestrator, "diary:deleteDiary"))) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not delete diary entry ${args.diaryId} (orchestrator "${entry.orchestrator}") — ${JSON.stringify({ orgSlug: scope.orgSlug, reason: "orchestrator-not-listed" })}`,
			);
		}

		// A session typing an owner's name is still a person: it needs a writer role
		// (a viewer cannot delete by typing a name). The fleet is not a member.
		if (!scope.isMaster) await requireMemberWriterRole(ctx, scope, "diary:deleteDiary");
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
			createdById: v.optional(v.string()),
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
			if (!(await orchestratorListed(ctx, scope, orchestrator, "diary:listByDateRange"))) {
				return [];
			}
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
			await rosterNames(ctx, scope, "diary:listByDateRange"),
			args.from,
			args.to,
		);
	},
});
