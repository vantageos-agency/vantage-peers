import {
	type ActingPrincipal,
	type AgentCallerDeps,
	assertRecipientAddressable,
	assertTargetBelongsTo,
	filterTargetsInPersonScope,
	hasFleetRead,
	type IdentityRefusal,
	isServiceAccountScope,
	type OrgKind,
	type PrincipalLookups,
	type RecipientLookups,
	resolveActingPrincipal,
	scopeStanding,
} from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	lookupOrgMapping,
	memberScopeOfMapping,
	type OrgScope,
	type VerifiedActor,
} from "./auth";
import { orgMappingLookups } from "./authOrgMapping";

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
			// Read through the primary-key index (one row by ID): the same read as
			// `db.get`, but a keyed probe, so a list door that proves its pilots
			// stays a list in the tool inventory instead of a list-and-get mix.
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

/**
 * The reads `resolveCallerFromAgentCredential` asks for, every one a plain
 * indexed read BY ID (no decision here):
 *   - orgById          the mapping row of a permanent org ID;
 *   - agentById        the agents row, with the org ID and owner it STORES;
 *   - personById       the owner's `orgMembership` row of that org, by (org ID,
 *                      person ID); `active` while it carries no `deactivatedAt`;
 *   - organisationById / orgKindOf   the same ID-keyed mapping reads the person
 *                      path uses.
 */
export function agentCallerDeps(ctx: Ctx): AgentCallerDeps {
	const { organisationById, orgKindOf } = personPrincipalLookups(ctx, "");
	return {
		orgLookups: orgMappingLookups(ctx),
		principalLookups: {
			agentById: async (agentId) => {
				const id = ctx.db.normalizeId("agents", agentId);
				if (id === null) return null;
				const row = await ctx.db
					.query("agents")
					.withIndex("by_id", (q) => q.eq("_id", id))
					.unique();
				if (row === null) return null;
				return {
					id: row._id,
					// The org ID the row stores. A row not yet reached by
					// migrations/backfill_org_clerk_id is stamped with no org the package
					// can match, so it is refused.
					orgId: row.clerkOrgId ?? null,
					active: row.isActive,
					ownerPersonId: row.ownerPersonId ?? null,
				};
			},
			personById: async (personId, orgId) => {
				const row = await ctx.db
					.query("orgMembership")
					.withIndex("by_org_user_clerk_id", (q) =>
						q.eq("clerkOrgId", orgId).eq("clerkUserId", personId),
					)
					.unique();
				if (row === null) return null;
				return {
					id: row.clerkUserId,
					orgId: row.clerkOrgId ?? null,
					active: row.deactivatedAt === undefined,
				};
			},
			organisationById,
			orgKindOf,
		},
	};
}

/**
 * A row the roster read judges: stamped with its organisation (`clerkOrgId`, the
 * permanent ID) and naming its agent by ID (a mission's pilot, a task's assignee).
 */
export type RosterRow = {
	orgId?: string;
	clerkOrgId?: string;
	pilotId?: string;
	assignedToId?: string;
};

/**
 * The row filter of a roster-scoped READ, decided by the package. GLUE ONLY: it
 * builds the inputs `@vantageos/cloud-identity` asks for and says its refusal in
 * this backend's wire shape; every decision is the package's.
 *
 *   - the fleet (`hasFleetRead`) sees every row;
 *   - an organisation member is a person principal of its verified org
 *     (`resolveActingPrincipal`), and `filterTargetsInPersonScope` keeps the
 *     rows of that organisation (by permanent org ID) whose agent ID is an entry
 *     of the organisation's stored roster `allowedAgentIds`. An organisation
 *     that stores no roster, a scope with no organisation and a row naming no
 *     agent are the package's refusals / drops, not decided here.
 *
 * The principal is resolved ONCE; the returned filter may be called per row or
 * per page.
 */
export async function scopedRowFilter(
	ctx: Ctx,
	scope: OrgScope,
	door: string,
): Promise<<T extends RosterRow>(rows: readonly T[]) => Promise<T[]>> {
	if (hasFleetRead(scope)) return async (rows) => [...rows];
	// A scope the package reads as "refused" (anonymous, signed in without an
	// organisation, self-contradicting) sees no row: the typed-empty answer the
	// subscribed reads have always given such a caller (R-50). The doors that must
	// RAISE for it do so before they reach a row.
	if (scopeStanding(scope) === "refused") return async () => [];
	const lookups = personPrincipalLookups(ctx, scope.userId);
	const caller = await resolveActingPrincipal(
		{
			kind: "person",
			personId: scope.userId,
			verifiedOrgId: scope.orgClerkId ?? "",
		},
		lookups,
		door,
	);
	if (!caller.ok) return refuseWith(caller.refusal);
	return async <T extends RosterRow>(rows: readonly T[]): Promise<T[]> => {
		const verdict = await filterTargetsInPersonScope(
			caller.principal,
			rows.map((row) => ({ orgId: row.clerkOrgId, row })),
			{
				orgKindOf: lookups.orgKindOf,
				scopeOf: () => ({
					kind: "keys",
					keys: new Set(scope.allowedAgentIds),
				}),
				rowScopeKeys: (target) => target.row.pilotId ?? target.row.assignedToId,
			},
			{ door },
		);
		if (!verdict.ok) return refuseWith(verdict.refusal);
		return verdict.rows.map((target) => target.row);
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
	// The package's standing gate: the fleet SERVICE ACCOUNT (not the internal
	// opt-in, not the operator human).
	if (!isServiceAccountScope(transportScope)) {
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
	// The org's member scope, from the mapping row resolved above (its permanent
	// ID rides beside the slug, so row ownership compares IDs; M4: no label
	// fallback on a row compare).
	return memberScopeOfMapping(mapping, { userId: transportScope.userId });
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

/**
 * The lookups `assertRecipientAddressable` reads, both keyed by the stored org:
 * the organisation kind (operator or client, from the mapping row) and the
 * roster of OPERATOR-org agent IDs the client organisation stores
 * (`addressableFleetCoordinatorIds`). No roster stored answers null, which the
 * package refuses (`list-absent`).
 */
export function recipientLookups(ctx: Ctx): RecipientLookups {
	return {
		orgKindOf: async (orgId): Promise<OrgKind | null> =>
			orgKindOfMapping(await lookupOrgMapping(ctx, orgId)),
		rosterOf: async (orgId) => {
			const mapping = await lookupOrgMapping(ctx, orgId);
			if (mapping === null || mapping.addressableFleetCoordinatorIds === undefined) {
				return null;
			}
			return { orgId, principalIds: mapping.addressableFleetCoordinatorIds };
		},
	};
}

export type RecipientAddress =
	| {
			ok: true;
			/**
			 * Where the recipient stands relative to the sender, decided by the
			 * package from the two stored org IDs and their stored kinds.
			 */
			direction:
				| "same-organisation"
				| "client-to-operator"
				| "operator-to-client";
	  }
	| { ok: false; refusal: IdentityRefusal };

/**
 * May the resolved AGENT `sender` address the agents row `recipient`, in either
 * direction across organisations, by ID only? The recipient is first resolved
 * through the package from its own stored row (active, stamped with the org it
 * is judged in, that org active); the address decision is then
 * `assertRecipientAddressable`, which owns every rule: same organisation,
 * client to a listed operator agent, operator agent to a client that lists it,
 * and nothing else. This function reads no name and decides nothing itself.
 */
export async function addressRecipientById(
	ctx: Ctx,
	sender: ActingPrincipal,
	recipient: { _id: string; orgSlug: string },
	door: string,
): Promise<RecipientAddress> {
	const lookups = principalLookups(ctx);
	const resolved = await resolveActingPrincipal(
		{ kind: "agent", agentId: recipient._id, verifiedOrgId: recipient.orgSlug },
		lookups,
		door,
	);
	if (!resolved.ok) return resolved;
	const verdict = await assertRecipientAddressable(
		sender,
		{ agentId: resolved.principal.principalId, orgId: resolved.principal.orgId },
		recipientLookups(ctx),
		{ door },
	);
	if (!verdict.ok) return verdict;
	if (resolved.principal.orgId === sender.orgId) {
		return { ok: true, direction: "same-organisation" };
	}
	const senderKind = await lookups.orgKindOf?.(sender.orgId);
	return {
		ok: true,
		direction:
			senderKind === "operator" ? "operator-to-client" : "client-to-operator",
	};
}
