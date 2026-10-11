import {
	type ActingPrincipal,
	assertTargetBelongsTo,
	type IdentityRefusal,
	type OrgKind,
	type PrincipalLookups,
	resolveActingPrincipal,
} from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { lookupOrgMapping, type OrgScope, type VerifiedActor } from "./auth";

// ─────────────────────────────────────────────────────────────────────────────
// actingPrincipal — the vantage-peers ADAPTER onto @vantageos/cloud-identity's
// principal-by-id resolver (backend standard R-53). It decides nothing about
// identity: it performs the indexed reads BY ID the package asks for, hands the
// package a credential built only from what the transport verified, and turns
// the package's typed refusal into this backend's RBAC_DENIED ConvexError.
//
// THE ORGANISATION ID. Every row of this backend is stamped with the org's
// `client_org_mapping.clerkOrgSlug` (`agents.orgSlug`, `messages.tenantId`,
// `messageReceipts.tenantId`, `tasks.orgId`); no other org key is stored
// anywhere. This adapter is the ONE place that says so: the package's `orgId`
// is that stored value. Moving the stamps to `client_org_mapping._id` is an
// expand-contract migration of every stamped table; when it lands, only
// `organisationById` / `orgKindOf` / `agentById` below change.
//
// ORG KIND. `orgKindOf` answers "operator" only for an ACTIVE mapping marked
// `orgKind: "operator"`; any other ACTIVE mapping (including the rows whose
// `orgKind` is unset) is "client"; a missing or inactive mapping is null (not
// the fleet, and `organisationById` refuses it anyway).
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

export function principalLookups(ctx: Ctx): PrincipalLookups {
	return {
		agentById: async (agentId) => {
			const id = ctx.db.normalizeId("agents", agentId);
			if (id === null) return null;
			// The built-in `by_id` index: the same single read as `ctx.db.get(id)`.
			const row = await ctx.db
				.query("agents")
				.withIndex("by_id", (q) => q.eq("_id", id))
				.unique();
			if (row === null) return null;
			return { id: row._id, orgId: row.orgSlug, active: row.isActive };
		},
		organisationById: async (orgId) => {
			const mapping = await lookupOrgMapping(ctx, orgId);
			if (mapping === null) return null;
			return { id: orgId, active: mapping.isActive };
		},
		orgKindOf: async (orgId): Promise<OrgKind | null> =>
			orgKindOfMapping(await lookupOrgMapping(ctx, orgId)),
	};
}

/**
 * The lookups for a reader that has ALREADY read a page of `agents` rows (one
 * indexed list of an organisation's agents) and judges several of them: the
 * agent is answered from that page instead of one `ctx.db.get` per ID. The
 * decision is the same as `principalLookups` (active row, stamped with the org
 * the credential names, in an active organisation); only the read differs.
 */
export function principalLookupsOverAgents(
	ctx: Ctx,
	agents: readonly Doc<"agents">[],
): PrincipalLookups {
	const byId = new Map<string, Doc<"agents">>(agents.map((a) => [a._id, a]));
	return {
		agentById: async (agentId) => {
			const row = byId.get(agentId);
			if (row === undefined) return null;
			return { id: row._id, orgId: row.orgSlug, active: row.isActive };
		},
		organisationById: async (orgId) => {
			const mapping = await lookupOrgMapping(ctx, orgId);
			if (mapping === null) return null;
			return { id: orgId, active: mapping.isActive };
		},
		orgKindOf: async (orgId): Promise<OrgKind | null> =>
			orgKindOfMapping(await lookupOrgMapping(ctx, orgId)),
	};
}

/**
 * The stored-orgKind -> OrgKind translation both lookup variants share (see ORG
 * KIND above): null for a missing or inactive mapping.
 */
function orgKindOfMapping(
	mapping: { isActive: boolean; orgKind?: string } | null,
): OrgKind | null {
	if (mapping === null || !mapping.isActive) return null;
	return mapping.orgKind === "operator" ? "operator" : "client";
}

/**
 * The lookups for a PERSON whose session a door has verified, every organisation
 * read keyed by the permanent org ID (the ID-keyed sibling of `principalLookups`).
 * The person row is the verified session itself (this backend keeps no separate
 * person table), so `personById` answers only for the verified subject. An org
 * ID that two mapping rows claim is undecidable (`lookupOrgMapping` answers
 * null), hence not an organisation here.
 */
export function personPrincipalLookups(
	ctx: Pick<Ctx, "db">,
	verifiedSubject?: string,
): PrincipalLookups {
	return {
		// With a subject, only that subject is a member. Without one, the id the
		// package asks about is the VERIFIED claim's own subject (it is the
		// argument `resolveCallerFromClaims` passes), so there is nothing to
		// compare it with.
		personById: (personId, orgId) =>
			verifiedSubject === undefined || personId === verifiedSubject
				? { id: personId, orgId, active: true }
				: null,
		organisationById: async (orgId) => {
			const mapping = await lookupOrgMapping(ctx, { clerkOrgId: orgId });
			return mapping === null ? null : { id: orgId, active: mapping.isActive };
		},
		orgKindOf: async (orgId): Promise<OrgKind | null> =>
			orgKindOfMapping(await lookupOrgMapping(ctx, { clerkOrgId: orgId })),
	};
}

/**
 * The lookups for the FLEET SERVICE ACCOUNT: the `agents` row the operator org's
 * mapping names, read by ID. The row answers only when it is a `kind: "service"`
 * row that carries exactly the verified subject as its `authSubject`; any other
 * row, kind or subject is a miss, which the package turns into a typed refusal.
 * The organisation reads are the same ID-keyed ones the person path uses.
 */
export function serviceAccountPrincipalLookups(
	ctx: Pick<Ctx, "db">,
	verifiedSubject: string,
): PrincipalLookups {
	const { organisationById, orgKindOf } = personPrincipalLookups(
		ctx,
		verifiedSubject,
	);
	return {
		organisationById,
		orgKindOf,
		serviceAccountById: async (serviceAccountId) => {
			const agentId = ctx.db.normalizeId("agents", serviceAccountId);
			if (agentId === null) return null;
			const row = await ctx.db.get(agentId);
			if (row === null) return null;
			if (row.kind !== "service" || row.authSubject !== verifiedSubject) {
				return null;
			}
			return {
				id: row._id,
				orgId: row.clerkOrgId ?? null,
				active: row.isActive,
			};
		},
	};
}

// The verifiedActor refusals already carry stable codes every door shares
// (convex/__tests__/verifiedActorProof.test.ts pins them across the task doors
// and sendMessage). R-16: a code never changes meaning between versions, so the
// package's refusal is surfaced under that same code, with the package's own
// `reason` carried beside it. Every other refusal keeps the package's code.
const STABLE_CODE: Partial<Record<IdentityRefusal["reason"], string>> = {
	"principal-not-found": "VERIFIED_ACTOR_UNKNOWN",
	"principal-inactive": "VERIFIED_ACTOR_INACTIVE",
	"other-organisation": "ORG_MISMATCH",
	"target-other-organisation": "ORG_MISMATCH",
};

export function refuseWith(refusal: IdentityRefusal): never {
	const code = STABLE_CODE[refusal.reason] ?? refusal.code;
	throw new ConvexError(
		`${code}: ${refusal.detail} — ${JSON.stringify({ reason: refusal.reason, door: refusal.door })}`,
	);
}

/**
 * The acting AGENT behind a `verifiedActor` the MCP transport forwarded, resolved
 * BY ID through the package, or a thrown RBAC_DENIED.
 *
 *   - Believed from the fleet service account only (the transport that verified
 *     it); any other caller presenting it is refused, never ignored.
 *   - The credential is `{ kind: "agent", agentId, verifiedOrgId }`: the agent
 *     row is read by its ID and must be ACTIVE, stamped with the org the
 *     transport verified it in, and that org must be an active organisation.
 *     No name is read.
 */
export async function requireVerifiedActorPrincipal(
	ctx: Ctx,
	transportScope: OrgScope,
	verifiedActor: VerifiedActor,
	door: string,
): Promise<ActingPrincipal> {
	if (
		!(
			transportScope.isMaster &&
			transportScope.masterSource === "service-account"
		)
	) {
		throw new ConvexError(
			`RBAC_DENIED: verifiedActor is a transport-verified claim and is accepted only from the fleet service account — ${JSON.stringify({ reason: "verified-actor-not-trusted", door })}`,
		);
	}
	const resolved = await resolveActingPrincipal(
		{
			kind: "agent",
			agentId: verifiedActor.agentId,
			verifiedOrgId: verifiedActor.orgSlug,
		},
		principalLookups(ctx),
		door,
	);
	if (!resolved.ok) return refuseWith(resolved.refusal);
	return resolved.principal;
}

/**
 * The target organisation of a call checked against the resolved principal BY
 * the stored org ID, through the package (`assertTargetBelongsTo`). An absent
 * org, another org, or the fleet's org for a client principal is refused.
 */
export async function requireTargetOrgOfPrincipal(
	ctx: Ctx,
	principal: ActingPrincipal,
	targetOrgId: string | null | undefined,
	door: string,
): Promise<void> {
	const verdict = await assertTargetBelongsTo(
		principal,
		{ orgId: targetOrgId },
		principalLookups(ctx),
		{ door },
	);
	if (!verdict.ok) refuseWith(verdict.refusal);
}

/**
 * The recipient scope of a resolved agent principal: its OWN organisation's
 * roster, read from the mapping row of the principal's org ID. A message sent by
 * an agent of a client org therefore reaches only that org (and the coordinators
 * that org's mapping names), never the fleet-wide set the service-account
 * transport would otherwise carry.
 */
export async function recipientScopeOfPrincipal(
	ctx: Ctx,
	transportScope: OrgScope,
	principal: ActingPrincipal,
	door: string,
): Promise<OrgScope> {
	const mapping = await lookupOrgMapping(ctx, principal.orgId);
	if (mapping === null || !mapping.isActive) {
		throw new ConvexError(
			`RBAC_DENIED: the acting agent's organisation is not an active organisation — ${JSON.stringify({ reason: "organisation-not-active", door })}`,
		);
	}
	return {
		userId: transportScope.userId,
		orgSlug: principal.orgId,
		// The org's permanent ID, from the mapping row resolved above, so row
		// ownership compares IDs (M4: no label fallback on a row compare).
		...(mapping.clerkOrgId !== undefined
			? { orgClerkId: mapping.clerkOrgId }
			: {}),
		allowedOrchestrators: mapping.allowedOrchestrators,
		allowedAgentIds: mapping.allowedAgentIds ?? [],
		fleetWide: false,
		scopes: mapping.scopes,
		isMaster: false,
	};
}

/**
 * The refusal for an ASSIGNMENT target that is not an agent of the organisation
 * the task row lives in (unknown, or registered only in another organisation).
 * Same RBAC_DENIED code and `{reason, door}` payload shape as every other
 * identity refusal of this module; the target is named so the caller can fix it.
 */
export function assigneeNotInOrgRefusal(
	assignee: string,
	orgId: string | undefined,
	door: string,
): ConvexError<string> {
	return new ConvexError(
		`RBAC_DENIED: assignee "${assignee}" has no agent row in this organisation — an assignment resolves to an agents-row ID of the task's own org, a label that names no agent there (or only in another org) is refused — ${JSON.stringify({ reason: "assignee-not-an-agent-of-org", orgId: orgId ?? null, door })}`,
	);
}

/**
 * An assignee agent row already resolved by ID, checked through the package
 * (active, stamped with the org, in an active organisation). The package's
 * refusal is surfaced under this backend's stable codes.
 */
export async function requireAssigneeAgentActive(
	ctx: Ctx,
	agentId: string,
	orgId: string,
	door: string,
): Promise<void> {
	const resolved = await resolveActingPrincipal(
		{ kind: "agent", agentId, verifiedOrgId: orgId },
		principalLookups(ctx),
		door,
	);
	if (!resolved.ok) refuseWith(resolved.refusal);
}
