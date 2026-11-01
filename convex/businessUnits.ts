import { v, ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./lib/functions";
import {
	isFleetStamp,
	sameOrg,
	sameTenantStamp,
} from "@vantageos/cloud-identity";
import { requireId } from "./lib/ids";
import {
	requireResolvedCaller,
	type OrgScope,
	withOrgScope,
} from "./lib/auth";
import { hasFleetStanding, requireFleetDoor } from "./lib/fleetStanding";
import { isFleetSystemCaller } from "./lib/systemCaller";
import { fleetOperatorRef } from "./lib/operatorOrg";
import { orgRefOfRow, orgRefOfScope } from "./lib/authOrgMapping";
import {
	agentIdOfLabelInOrg,
	isAgentOnScopeRoster,
	isAgentOwnerOfRow,
	type LabelOrg,
	requireLabelOnScopeRoster,
} from "./lib/rosterLabels";
import {
	resolveVerifiedOrgMapping,
	resolveVerifiedOrgScope,
	verifiedOrgValidator,
} from "./lib/verifiedOrg";
import { resolveHumanActor } from "./lib/humanActor";
import { requireMemberWriterRole } from "./memberWriterRoles";

// ─────────────────────────────────────────────────────────────────────────────
// Business units decide on AGENT IDs and ORG IDs, never on names (module M10f).
//
// A unit stores its lead orchestrator as an agents-row ID (`ownerId`, the agent
// `orchestratorId` names in the unit's own organisation; the operator org for a
// fleet-owned unit). `orchestratorId` stays the display label. Every decision
// is the package's (@vantageos/cloud-identity), reached through the repo's
// adapters:
//   - which organisation a unit is in: `sameOrg` / `sameTenantStamp` over the
//     stored org IDs (never a slug);
//   - whether an agent is on the caller's roster: `assertPrincipalListed` over
//     `allowedAgentIds` (lib/rosterLabels.ts, lib/rosterIds.ts);
//   - whether the caller is the fleet: the package's `fleet` standing
//     (lib/fleetStanding.ts), not a flag read off the resolved scope;
//   - whether a member may write at all: the writer-role allowlist held as data
//     (memberWriterRoles.ts, `resolveWriterRole` in the package).
//
// History (authority attached to an anonymously-registered object, see
// .claude/rules/authority-attached-to-anonymous-object.md): `create` used to
// insert whatever `orchestratorId` the caller supplied with no check at all;
// `update` authorized solely on a client-supplied `callerOrchestrator` STRING;
// `remove` performed no check. A Clerk-org member may now only write a unit
// whose owner is an agent of its own roster, and only with a writer role.
// ─────────────────────────────────────────────────────────────────────────────

// The organisation a unit's labels are looked up in: its own stamp (slug and
// permanent ID), or the operator org for a fleet-owned, unstamped unit.
function orgOfRow(row: { orgId?: string; clerkOrgId?: string }): LabelOrg {
	return {
		orgSlug: row.orgId ?? null,
		...(row.clerkOrgId !== undefined ? { clerkOrgId: row.clerkOrgId } : {}),
	};
}

// The organisation of a verified member scope.
function orgOfScope(scope: OrgScope): LabelOrg {
	return {
		orgSlug: scope.orgSlug,
		...(scope.orgClerkId !== undefined ? { clerkOrgId: scope.orgClerkId } : {}),
	};
}

/**
 * Does an ORG MEMBER see this unit? The unit's organisation is the caller's (by
 * org ID, the package's `sameTenantStamp`) AND its owner is on the caller's
 * roster by agent ID. A unit with no stored owner names nobody and is withheld
 * until migrations/backfill_business_unit_owner_ids has filled it.
 */
async function memberMaySeeUnit(
	ctx: QueryCtx,
	scope: OrgScope,
	bu: Doc<"businessUnits">,
	door: string,
): Promise<boolean> {
	if (
		!sameTenantStamp(
			orgRefOfRow(bu),
			orgRefOfScope(scope),
			await fleetOperatorRef(ctx.db),
		)
	) {
		return false;
	}
	return (
		bu.ownerId !== undefined &&
		(await isAgentOnScopeRoster(ctx, scope, bu.ownerId, door))
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators
// ─────────────────────────────────────────────────────────────────────────────

const buStatusValidator = v.union(
	v.literal("idea"),
	v.literal("building"),
	v.literal("live"),
	v.literal("revenue"),
);

const revenueProjectionsValidator = v.object({
	y1: v.number(),
	y2: v.number(),
	y3: v.number(),
});

const coreTeamValidator = v.object({
	agents: v.array(v.string()),
	skills: v.array(v.string()),
	hooks: v.array(v.string()),
	plugins: v.array(v.string()),
});

// Full BU object shape — used in query returns
const buObject = v.object({
	_id: v.id("businessUnits"),
	_creationTime: v.number(),
	name: v.string(),
	description: v.string(),
	purpose: v.string(),
	domain: v.optional(v.string()),
	orchestratorId: v.string(),
	status: buStatusValidator,
	businessModel: v.string(),
	targetCustomers: v.string(),
	services: v.array(v.string()),
	pricing: v.string(),
	revenueProjections: revenueProjectionsValidator,
	coreTeam: coreTeamValidator,
	coreProcesses: v.array(v.string()),
	dependencies: v.array(v.string()),
	kpis: v.array(v.string()),
	managementFee: v.number(),
	createdAt: v.number(),
	updatedAt: v.number(),
	orgId: v.optional(v.string()),
	clerkOrgId: v.optional(v.string()),
	ownerId: v.optional(v.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// create — insert a new business unit
// ─────────────────────────────────────────────────────────────────────────────

export const create = mutation({
	args: {
		name: v.string(),
		description: v.string(),
		purpose: v.string(),
		domain: v.optional(v.string()),
		orchestratorId: v.string(),
		status: buStatusValidator,
		businessModel: v.string(),
		targetCustomers: v.string(),
		services: v.array(v.string()),
		pricing: v.string(),
		revenueProjections: revenueProjectionsValidator,
		coreTeam: coreTeamValidator,
		coreProcesses: v.array(v.string()),
		dependencies: v.array(v.string()),
		kpis: v.array(v.string()),
		managementFee: v.optional(v.number()),
		// The organisation the MCP transport VERIFIED for a bearer that reaches
		// Convex as the fleet service account (convex/lib/verifiedOrg.ts), believed
		// from the service account only. The door then acts as that org's member,
		// never as the fleet; the bearer's writer tier is the MCP guard's.
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	returns: v.id("businessUnits"),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("businessUnits:create", …) at mcp-server/src/tools.ts:7477 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
		// withOrgScope is called WITHOUT allowNoIdentityMaster: the MCP server
		// always presents a real identity (the caller's own org JWT or its
		// service-account token), so the fail-closed default never breaks that
		// live path. An anonymous caller is refused by raising.
		const door = "businessUnits:create";
		const transportScope = await withOrgScope(ctx);
		requireResolvedCaller(transportScope, door, { alsoRefusePreOrg: true });
		// The org a bearer acts for is the ACTIVE mapping the transport's claim
		// names, believed from the service account only (the guarded helper refuses
		// anyone else). The scope this door writes the tenant stamp from is the one
		// `withOrgScope` itself returns for that mapping: the stamp is the verified
		// scope's, never the claim's.
		const actingMapping = await resolveVerifiedOrgMapping(
			ctx,
			transportScope,
			args.verifiedOrg,
			door,
		);
		let scope = transportScope;
		if (actingMapping !== undefined) {
			scope = await withOrgScope(ctx, {
				refuseWithoutThrow: true,
				actForOrgMapping: actingMapping,
			});
		}
		const acting = actingMapping !== undefined;
		const fleet = !acting && (await hasFleetStanding(ctx, door));
		// The owner BY ID. A member names an agent of its OWN org that is on its
		// roster by ID, with a writer role; the fleet resolves the label in the
		// operator org (a label with no agent there leaves the column unset).
		let ownerId: string | undefined;
		if (fleet) {
			ownerId = await agentIdOfLabelInOrg(
				ctx,
				{ orgSlug: null },
				args.orchestratorId,
				door,
			);
		} else {
			if (!acting) await requireMemberWriterRole(ctx, scope, door);
			ownerId = await requireLabelOnScopeRoster(
				ctx,
				scope,
				args.orchestratorId,
				"owner",
				door,
			);
		}

		const now = Date.now();
		return await ctx.db.insert("businessUnits", {
			name: args.name,
			description: args.description,
			purpose: args.purpose,
			domain: args.domain,
			orchestratorId: args.orchestratorId,
			status: args.status,
			businessModel: args.businessModel,
			targetCustomers: args.targetCustomers,
			services: args.services,
			pricing: args.pricing,
			revenueProjections: args.revenueProjections,
			coreTeam: args.coreTeam,
			coreProcesses: args.coreProcesses,
			dependencies: args.dependencies,
			kpis: args.kpis,
			managementFee: args.managementFee ?? 10,
			...(ownerId !== undefined ? { ownerId } : {}),
			createdAt: now,
			updatedAt: now,
			// R-52 tenant stamp, derived from the verified scope and never from an
			// argument. A fleet write is fleet-owned (unstamped), as `tasks` does.
			...(fleet || scope.orgSlug === null
				? {}
				: {
						orgId: scope.orgSlug,
						clerkOrgId: scope.orgClerkId,
					}),
		});
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// update — partial update of BU fields
// ─────────────────────────────────────────────────────────────────────────────

export const update = mutation({
	args: {
		buId: v.id("businessUnits"),
		// RBAC: caller identity claiming ownership — DISTINCT from the
		// `orchestratorId` field below, which is the new lead-orchestrator
		// VALUE being written. Cross-tenant fix (S0 campaign
		// k17b9z5yjgd8301r6dfawefpzs8b3a03): the MCP layer previously reused
		// `orchestratorId` as both the caller's claimed identity AND the
		// write payload, and only checked that claim against the caller's own
		// OAuth allowlist — never against the TARGET row's actual owner. A
		// caller could claim its own identity and still rewrite anyone's BU.
		// Authorization must be derived from the row being targeted
		// (bu.orchestratorId), never from a value the caller supplies.
		// Optional: a HUMAN org member omits it and acts in its own name (writer
		// role + its own organisation's unit); the agent / fleet path still names it.
		callerOrchestrator: v.optional(v.string()),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		purpose: v.optional(v.string()),
		domain: v.optional(v.string()),
		orchestratorId: v.optional(v.string()),
		status: v.optional(buStatusValidator),
		businessModel: v.optional(v.string()),
		targetCustomers: v.optional(v.string()),
		services: v.optional(v.array(v.string())),
		pricing: v.optional(v.string()),
		revenueProjections: v.optional(revenueProjectionsValidator),
		coreTeam: v.optional(coreTeamValidator),
		coreProcesses: v.optional(v.array(v.string())),
		dependencies: v.optional(v.array(v.string())),
		kpis: v.optional(v.array(v.string())),
		managementFee: v.optional(v.number()),
		// The organisation the MCP transport VERIFIED for a bearer that reaches
		// Convex as the fleet service account (convex/lib/verifiedOrg.ts), believed
		// from the service account only. The door then acts as that org's member,
		// never as the fleet; the bearer's writer tier is the MCP guard's.
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("businessUnits:update", …) at mcp-server/src/tools.ts:7746 (imperative), never a subscribing pre-org client shell; the RBAC_DENIED throw is an R-16 refusal the MCP layer catches, not an uncaught Server Error.
		//
		// `callerOrchestrator` is a bare STRING ASSERTION with no identity behind
		// it, so it authorises nothing alone: withOrgScope resolves the VERIFIED
		// identity BEFORE ctx.db.get (a non-existent buId cannot be told from an
		// existing-but-foreign one by an unauthenticated caller), the target row
		// decides the tenant and the owner, and the asserted label is resolved to
		// an agent ID and judged against the row's stored owner by the package.
		const door = "businessUnits:update";
		const transportScope = await withOrgScope(ctx);
		requireResolvedCaller(transportScope, door, { alsoRefusePreOrg: true });
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			door,
		);
		const acting = args.verifiedOrg !== undefined;
		const fleet = !acting && (await hasFleetStanding(ctx, door));
		// The caller named no orchestrator: only a person acting in its own name
		// may omit it. The fleet and a bearer acting for its verified org name one.
		const callerOrchestrator = args.callerOrchestrator;
		const asMember = callerOrchestrator === undefined;
		if (asMember && (fleet || acting)) {
			throw new ConvexError(
				`RBAC_DENIED: callerOrchestrator is required — omitting it is refused, not exempted — ${JSON.stringify({ registration: door, orgSlug: scope.orgSlug, reason: "caller-orchestrator-required" })}`,
			);
		}

		const bu = await ctx.db.get(args.buId);
		if (bu === null) {
			throw new Error(`Business unit ${args.buId} not found`);
		}

		// R-52 -- the row's own server-stamped tenant must be the caller's, by org
		// ID. An unstamped row is fleet-owned or not yet backfilled and is refused to
		// every org caller; the fleet is unchanged.
		if (
			!fleet &&
			!sameTenantStamp(
				orgRefOfRow(bu),
				orgRefOfScope(scope),
				await fleetOperatorRef(ctx.db),
			)
		) {
			throw new ConvexError(
				`RBAC_DENIED: caller may not update business unit ${args.buId} — ${JSON.stringify({ orgSlug: scope.orgSlug, reason: "row-not-in-caller-org" })}`,
			);
		}

		let newOwnerId: string | undefined;
		if (!fleet) {
			// A member writes only with a writer role (a bearer acting for its verified
			// org carries its writer tier in the MCP guard).
			if (!acting) await requireMemberWriterRole(ctx, scope, door);
			// The TARGET ROW's stored owner must be on the caller's roster by agent
			// ID -- authorization is derived from the row, never from the caller's
			// claim.
			// A person in its own name is judged by its organisation (above) and its
			// role, not by an owner it never claimed.
			if (
				!asMember &&
				(bu.ownerId === undefined ||
					!(await isAgentOnScopeRoster(ctx, scope, bu.ownerId, door)))
			) {
				throw new ConvexError(
					`RBAC_DENIED: caller may not update business unit ${args.buId} — ${JSON.stringify({ orgSlug: scope.orgSlug, reason: "owner-not-on-roster" })}`,
				);
			}
			// A reassignment must ALSO land on an agent of the caller's own roster.
			if (args.orchestratorId !== undefined) {
				newOwnerId = await requireLabelOnScopeRoster(
					ctx,
					scope,
					args.orchestratorId,
					"owner",
					door,
				);
			}
		} else if (args.orchestratorId !== undefined) {
			// The fleet reassigns within the unit's own organisation (the operator
			// org for a fleet-owned unit); a label with no agent there unsets the owner.
			newOwnerId = await agentIdOfLabelInOrg(
				ctx,
				orgOfRow(bu),
				args.orchestratorId,
				door,
			);
		}

		// The asserted caller must be the unit's owner (or the fleet's own system
		// caller): the label is resolved to an agent ID in the row's organisation
		// and the package judges it against the stored owner.
		if (callerOrchestrator !== undefined && !isFleetSystemCaller(scope, callerOrchestrator)) {
			const callerId = await agentIdOfLabelInOrg(
				ctx,
				orgOfRow(bu),
				callerOrchestrator,
				door,
			);
			if (
				callerId === undefined ||
				!(await isAgentOwnerOfRow(ctx, bu, callerId, door))
			) {
				throw new ConvexError(
					`RBAC_DENIED: ${callerOrchestrator} is not the owning orchestrator (${bu.orchestratorId}) of business unit ${args.buId} — ${JSON.stringify({ reason: "caller-not-owner", door })}`,
				);
			}
		}

		const {
			buId,
			callerOrchestrator: _callerOrchestrator,
			verifiedOrg: _verifiedOrg,
			...fields
		} = args;

		// Build patch object with only provided fields
		const patch: Record<string, unknown> = { updatedAt: Date.now() };
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				patch[key] = value;
			}
		}

		// The owner BY ID follows a reassignment; the label above is display only.
		if (args.orchestratorId !== undefined) patch.ownerId = newOwnerId;

		await ctx.db.patch(buId, patch);
		return null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// remove — delete a business unit by ID
// ─────────────────────────────────────────────────────────────────────────────

export const remove = mutation({
	args: {
		buId: v.id("businessUnits"),
		// The organisation the MCP transport VERIFIED for a bearer that reaches
		// Convex as the fleet service account (convex/lib/verifiedOrg.ts). It is the
		// only way the fleet deletes a unit stamped with a client org: a claimless
		// service account deletes the fleet's own units only.
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	returns: v.object({ deleted: v.boolean() }),
	handler: async (ctx, args) => {
		// write-contract: MCP-transport-only — issued via mcp-server client.mutation("businessUnits:remove", …) at mcp-server/src/tools.ts:7837 (imperative), 0 hits in vantage-peers-dashboard {app,components,hooks,lib,contexts,providers} (measured 2026-10-01 at origin/main e2dc58f and 0466fac); never a subscribing pre-org client shell. The no-org throw is a refusal at an imperative MCP call, never at a render.
		// Deletion is the fleet's or an org:admin's of the unit's own organisation
		// (the MCP server's `delete_bu` tool restricts it to
		// master; that transport-layer gate is not a defence for this class, see
		// .claude/rules/authority-attached-to-anonymous-object.md, so Convex
		// re-derives it). The fleet is the package's `fleet` standing, not a flag.
		const door = "businessUnits:remove";
		const scope = await withOrgScope(ctx);
		if (!(await hasFleetStanding(ctx, door))) {
			// HUMAN path (task k17d5k5bw741p3681bc0pq76ah8fk4sn): an org:admin of the
			// unit's OWN organisation deletes it in its own name. The caller is
			// resolved first (anonymous and pre-org raise, never "not found").
			requireResolvedCaller(scope, door, { alsoRefusePreOrg: true });
			await resolveHumanActor(ctx, scope, { door, adminOnly: true });
			const own = await ctx.db.get(args.buId);
			if (!own) throw new Error("Business unit not found");
			if (!sameOrg(orgRefOfRow(own), orgRefOfScope(scope))) {
				throw new ConvexError(
					`RBAC_DENIED: caller may not delete business unit ${args.buId} — ${JSON.stringify({ orgSlug: scope.orgSlug, reason: "row-not-in-caller-org" })}`,
				);
			}
			await ctx.db.delete(args.buId);
			return { deleted: true };
		}
		await requireFleetDoor(ctx, scope, door, { masterOnly: true });

		const bu = await ctx.db.get(args.buId);
		if (!bu) throw new Error("Business unit not found");
		// R-52: the fleet deletes what is the fleet's (unstamped, or stamped with
		// the operator org). A unit stamped with a client org is that org's: it is
		// deleted only on the transport's verified claim naming that same org.
		if (!isFleetStamp(orgRefOfRow(bu), await fleetOperatorRef(ctx.db))) {
			const acting = await resolveVerifiedOrgScope(
				ctx,
				scope,
				args.verifiedOrg,
				door,
			);
			if (!sameOrg(orgRefOfRow(bu), orgRefOfScope(acting))) {
				throw new ConvexError(
					`RBAC_DENIED: caller may not delete business unit ${args.buId} — ${JSON.stringify({ orgSlug: acting.orgSlug, reason: "row-not-in-caller-org" })}`,
				);
			}
		}
		await ctx.db.delete(args.buId);
		return { deleted: true };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// get — fetch a single BU by ID
// ─────────────────────────────────────────────────────────────────────────────

export const get = query({
	// Accept a raw string, not `v.id("businessUnits")`: the v.id() validator
	// runs BEFORE the handler, so a wrong-table ID is rejected with a message
	// Convex redacts in prod (`Server Error`, `error.data` undefined —
	// measured). Narrowing inside the handler via requireId() throws a
	// ConvexError whose payload survives redaction. Same contract as PR #1072
	// (tasks.getById).
	args: { buId: v.string(), verifiedOrg: v.optional(verifiedOrgValidator) },
	returns: v.union(buObject, v.null()),
	handler: async (ctx, args) => {
		const buId = requireId(
			ctx,
			"businessUnits",
			args.buId,
			"buId",
			"Use the full 32-char buId returned by businessUnits.list or businessUnits.create.",
		);
		// GATE — CLOSED (org-scoped): this door served any business unit by id
		// to a caller presenting NO CREDENTIAL AT ALL. The fleet reads every unit
		// (the package's `fleet` standing; the operator human is the fleet for
		// READS). An ordinary member reads a unit of its OWN organisation (by org
		// ID) whose owner is on its roster by agent ID; a unit of another org reads
		// as null (no existence leak across tenants).
		// isolation-contract: no reactive subscriber. Enumerated by command
		// against vantage-peers-dashboard:
		//   grep -rn "api\.businessUnits\.get\b" --include=*.tsx --include=*.ts \
		//     app components hooks lib contexts providers  -> 0 hits
		// (`businessUnits:list` IS subscribed; this door is not.) The MCP tool
		// reads it one-shot.
		const door = "businessUnits:get";
		const transportScope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(transportScope, door, { alsoRefusePreOrg: true });
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			door,
		);
		const bu = await ctx.db.get(buId);
		if (bu === null) return null;
		if (
			args.verifiedOrg === undefined &&
			(await hasFleetStanding(ctx, door, { operatorHumanMayRead: true }))
		) {
			return bu;
		}
		return (await memberMaySeeUnit(ctx, scope, bu, door)) ? bu : null;
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// list — list BUs with optional filters, newest first
// PR-A envelope safety: { items, nextCursor } envelope, limit default 20,
// cap 200, fields=lite|full projection, cursor-based paging.
// ─────────────────────────────────────────────────────────────────────────────

// returns-projection: list-view card summary, full BU fetched via businessUnits.get
const liteValidator = v.object({
	_id: v.id("businessUnits"),
	_creationTime: v.number(),
	name: v.string(),
	status: buStatusValidator,
	orchestratorId: v.string(),
});

interface CursorPayload {
	time: number;
	id: string;
}

function encodeCursor(time: number, id: string): string {
	return btoa(JSON.stringify({ time, id }));
}

function decodeCursor(cursor: string | undefined): CursorPayload | undefined {
	if (!cursor) return undefined;
	try {
		const raw = atob(cursor);
		const parsed = JSON.parse(raw) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"time" in parsed &&
			"id" in parsed &&
			typeof (parsed as Record<string, unknown>).time === "number" &&
			typeof (parsed as Record<string, unknown>).id === "string"
		) {
			return {
				time: (parsed as Record<string, unknown>).time as number,
				id: (parsed as Record<string, unknown>).id as string,
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export const BUSINESS_UNITS_LIST_SCAN_CAP = 2000;

// returns-projection: fields="lite" returns a list-view card summary (liteValidator), not the full BU document
export const list = query({
	args: {
		fields: v.optional(v.union(v.literal("lite"), v.literal("full"))),
		orchestratorId: v.optional(v.string()),
		status: v.optional(buStatusValidator),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
		// back-compat: keep createdBefore accepted; cursor takes precedence when both passed
		createdBefore: v.optional(v.number()),
		// The organisation the MCP transport VERIFIED for a bearer that reaches
		// Convex as the fleet service account. Believed from the service account
		// only; the read then runs under that org's member scope, so the roster's
		// index ranges below ARE the read (convex/lib/verifiedOrg.ts).
		verifiedOrg: v.optional(verifiedOrgValidator),
	},
	returns: v.object({
		items: v.union(v.array(buObject), v.array(liteValidator)),
		nextCursor: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		// Fail-closed READ counterpart of this file's WRITE gates. Measured against
		// LIVE production at commit bd8c60e9: this query served a business unit to
		// a caller presenting NO CREDENTIAL AT ALL.
		//
		// This table is ORG-SCOPED, not fleet-internal. The fleet (the package's
		// `fleet` standing; the operator human is the fleet for READS) reads every
		// unit. An ordinary org member reads the units of its OWN organisation
		// (the org ID leads the index range) whose owner is an agent on its roster
		// by ID (the owner ID is the next index key): a foreign unit is never read
		// and cannot occupy a slot of the page. A caller with no verified
		// organisation has no org ID and no roster, so the same range yields
		// nothing without a second code path.
		// REFUSAL SHAPE: the typed empty ENVELOPE for the signed-in-no-org caller
		// (reactively-subscribed public READ, R-50/R-51; `alsoRefusePreOrg` is NOT
		// passed); an anonymous caller is refused by RAISING
		// (.claude/rules/refusal-is-distinguishable-from-absence.md,
		// `missions:list` has raised at this pole in production all along).
		const door = "businessUnits:list";
		const transportScope = await withOrgScope(ctx, { refuseWithoutThrow: true });
		requireResolvedCaller(transportScope, door);
		const scope = await resolveVerifiedOrgScope(
			ctx,
			transportScope,
			args.verifiedOrg,
			door,
		);
		// A bearer acting for a verified org reads as that org's member, never as
		// the fleet, even though the credential on the wire is the service account.
		const fleet =
			args.verifiedOrg === undefined &&
			(await hasFleetStanding(ctx, door, { operatorHumanMayRead: true }));

		const DEFAULT_LIMIT = 20;
		const CAP = 200;
		const fields = args.fields ?? "full";
		const requested = args.limit ?? DEFAULT_LIMIT;
		const limit = Math.max(1, Math.min(requested, CAP));

		// Decode cursor payload; fall back to createdBefore legacy anchor
		const cursorPayload = decodeCursor(args.cursor);

		// PR #635 wide-scan-cap pattern (see convex/tasks.ts TASK_LIST_SCAN_CAP,
		// convex/profiles.ts PROFILES_LIST_SCAN_CAP, lot 1 mission k574p02m).
		// mission k574p02m DEFECT 2, lot 2 — the previous `limit * 4 + 10` fixed
		// multiplier is a FALLIBLE buffer: `.take(fetchLimit)` always re-reads
		// only the TOP `fetchLimit` rows of the WHOLE ordering (not an offset
		// continuation), so once the cursor anchor's true position exceeds this
		// fixed window the anchor is never found, every row is filtered out,
		// and the page comes back empty before the true end. Widen the fetch to
		// the same scan cap the other carriers use instead of a multiplier that
		// degrades with page depth.
		// mission k574p02m lot 2 — Eta REVISE: widen on EITHER cursor source.
		// The legacy `createdBefore` back-compat path also filters after
		// `.take(fetchLimit)`, so it must widen too or it undershoots deep
		// pages the same way the cursor path used to.
		const wide = cursorPayload !== undefined || args.createdBefore !== undefined;
		const fetchLimit = wide ? BUSINESS_UNITS_LIST_SCAN_CAP + 1 : limit + 1;

		// R-11: the caller's scope is applied INSIDE the read. The fleet reads the
		// fleet (by status, or all; by owner ID when an orchestrator is asked for,
		// resolved in the operator org). An org member reads one index range per
		// agent on its roster by ID, under its own org ID, and merges the ranges
		// newest-first.
		const status = args.status;
		let rows: Doc<"businessUnits">[] = [];
		if (fleet && args.orchestratorId === undefined) {
			rows =
				status !== undefined
					? await ctx.db
							.query("businessUnits")
							.withIndex("by_status", (q) => q.eq("status", status))
							.order("desc")
							.take(fetchLimit)
					: await ctx.db
							.query("businessUnits")
							.order("desc")
							.take(fetchLimit);
		} else {
			// The owner IDs to read: the one asked for (a label resolved in ONE org:
			// the operator org for the fleet, the caller's own for a member, which
			// must also be on its roster), else, for a member, its whole roster.
			let owners: string[] = [];
			if (args.orchestratorId !== undefined) {
				const asked = await agentIdOfLabelInOrg(
					ctx,
					fleet ? { orgSlug: null } : orgOfScope(scope),
					args.orchestratorId,
					door,
				);
				if (
					asked !== undefined &&
					(fleet || (await isAgentOnScopeRoster(ctx, scope, asked, door)))
				) {
					owners = [asked];
				}
			} else {
				for (const id of new Set(scope.allowedAgentIds)) {
					if (await isAgentOnScopeRoster(ctx, scope, id, door)) owners.push(id);
				}
			}
			const orgClerkId = scope.orgClerkId;
			for (const ownerId of owners) {
				if (fleet) {
					rows.push(
						...(status !== undefined
							? await ctx.db
									.query("businessUnits")
									.withIndex("by_ownerId_status", (q) =>
										q.eq("ownerId", ownerId).eq("status", status),
									)
									.order("desc")
									.take(fetchLimit)
							: await ctx.db
									.query("businessUnits")
									.withIndex("by_ownerId_status", (q) => q.eq("ownerId", ownerId))
									.order("desc")
									.take(fetchLimit)),
					);
				} else if (orgClerkId !== undefined) {
					rows.push(
						...(status !== undefined
							? await ctx.db
									.query("businessUnits")
									.withIndex("by_clerkOrgId_ownerId_status", (q) =>
										q
											.eq("clerkOrgId", orgClerkId)
											.eq("ownerId", ownerId)
											.eq("status", status),
									)
									.order("desc")
									.take(fetchLimit)
							: await ctx.db
									.query("businessUnits")
									.withIndex("by_clerkOrgId_ownerId_status", (q) =>
										q.eq("clerkOrgId", orgClerkId).eq("ownerId", ownerId),
									)
									.order("desc")
									.take(fetchLimit)),
					);
				}
			}
			// Merge the ranges newest-first and keep the fetch window.
			rows = rows
				.sort((x, y) => y._creationTime - x._creationTime)
				.slice(0, fetchLimit);
		}

		// Defence in depth for a member: every row read is stamped with the
		// caller's org ID (the package's `sameOrg`), whatever the index returned.
		if (!fleet) {
			rows = rows.filter((r) =>
				sameOrg(orgRefOfRow(r), orgRefOfScope(scope)),
			);
		}

		// Apply cursor filter: exclude rows at or before the cursor anchor.
		// Cursor encodes { time, id } — exclude rows strictly "before" in desc order:
		//   time > cursor.time → already seen (newer, came before in desc order)
		//   time === cursor.time AND id === cursor.id → the exact last-seen row
		//   time === cursor.time AND id !== cursor.id → same-ms peers, keep them
		// We order desc, so "already seen" = _creationTime >= cursor.time (for the anchor row).
		// Precise rule: skip if (_creationTime > cursor.time) OR (_creationTime === cursor.time AND _id === cursor.id) or older same-ms seen peers.
		// Simplest correct rule for desc ordering: skip all rows up to and including cursor.id.
		if (cursorPayload !== undefined) {
			let pastAnchor = false;
			rows = rows.filter((r) => {
				if (pastAnchor) return true;
				if (r._id === cursorPayload.id) {
					pastAnchor = true;
					return false; // skip the anchor row itself
				}
				return false; // skip rows before anchor (newer in desc order)
			});
		} else if (args.createdBefore !== undefined) {
			// Legacy back-compat: filter by createdBefore timestamp
			const before = args.createdBefore;
			rows = rows.filter((r) => r._creationTime < before);
		}

		// Detect next page
		const hasMore = rows.length > limit;
		const pageRows = rows.slice(0, limit);

		const nextCursor =
			hasMore || (cursorPayload !== undefined && pageRows.length === limit)
				? encodeCursor(
						pageRows[pageRows.length - 1]._creationTime,
						pageRows[pageRows.length - 1]._id,
					)
				: null;

		// Apply projection
		if (fields === "lite") {
			const liteItems = pageRows.map((r) => ({
				_id: r._id,
				_creationTime: r._creationTime,
				name: r.name,
				status: r.status,
				orchestratorId: r.orchestratorId,
			}));
			return { items: liteItems, nextCursor };
		}

		return { items: pageRows, nextCursor };
	},
});
