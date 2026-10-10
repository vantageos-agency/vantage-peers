import {
	type ActingPrincipal,
	assertPrincipalListed,
	type IdentityRefusal,
	type PrincipalIdList,
	resolveActingPrincipal,
} from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { principalLookups } from "./actingPrincipal";

// ─────────────────────────────────────────────────────────────────────────────
// rosterIds — the vantage-peers ADAPTER onto @vantageos/cloud-identity's
// `assertPrincipalListed` (module M1, rosters by agent ID).
//
// A roster is a list of agent IDs stored under one organisation
// (`client_org_mapping.allowedAgentIds`, `addressableFleetCoordinatorIds`).
// Whether an agent is on it is decided HERE and nowhere else, by the package:
// byte-equal IDs, the list's org equal to the agent's org, no wildcard, refused
// by default. This file compares nothing itself and reads no name.
//
// The principal is built by `resolveActingPrincipal` from the agent's own
// stored row (read by ID: it must exist, be active, be stamped with the org it
// is judged in, and that org must be an active organisation).
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

export type RosterVerdict =
	| { ok: true; principal: ActingPrincipal }
	| { ok: false; refusal: IdentityRefusal };

/**
 * Is the agent `agentId`, of organisation `agentOrgId`, an entry of the roster
 * `list` stored under `list.orgId`? `list` undefined (no roster stored) refuses.
 * `door` is carried on the refusal.
 */
export async function agentListedOnRoster(
	ctx: Ctx,
	agent: { agentId: string; agentOrgId: string },
	list: PrincipalIdList | undefined,
	door: string,
): Promise<RosterVerdict> {
	const resolved = await resolveActingPrincipal(
		{ kind: "agent", agentId: agent.agentId, verifiedOrgId: agent.agentOrgId },
		principalLookups(ctx),
		door,
	);
	if (!resolved.ok) return resolved;
	const listed = assertPrincipalListed(resolved.principal, list, { door });
	if (!listed.ok) return listed;
	return { ok: true, principal: resolved.principal };
}

/** A roster stored under `orgId`; `ids` undefined means none is stored. */
export function rosterOf(
	orgId: string | null,
	ids: readonly Id<"agents">[] | readonly string[] | undefined,
): PrincipalIdList | undefined {
	if (orgId === null || ids === undefined) return undefined;
	return { orgId, principalIds: ids };
}

/**
 * Is the agent `agentId` an operator-org agent that the client organisation
 * `ownerOrgId` may address directly, i.e. an entry of that client's stored
 * `addressableFleetCoordinatorIds`?
 *
 * The list is STORED under the client's mapping row but holds OPERATOR-org
 * IDs, and the package requires the list's org to be the principal's. So the
 * agent's org is first proven to be an ACTIVE operator org by the stored
 * `orgKind` (read from data, never a typed slug); only then is the list judged,
 * under that org, by `assertPrincipalListed`. A client agent, or an agent of
 * another client, is never a coordinator. Resolves to the same verdict shape.
 */
export async function agentListedAsCoordinator(
	ctx: Ctx,
	agentId: string,
	coordinatorIds: readonly string[] | undefined,
	door: string,
): Promise<RosterVerdict> {
	const id = ctx.db.normalizeId("agents", agentId);
	const row = id === null ? null : await ctx.db.get(id);
	if (row === null) {
		return agentListedOnRoster(
			ctx,
			{ agentId, agentOrgId: "" },
			undefined,
			door,
		);
	}
	const kind = await principalLookups(ctx).orgKindOf?.(row.orgSlug);
	return agentListedOnRoster(
		ctx,
		{ agentId: row._id, agentOrgId: row.orgSlug },
		kind === "operator" ? rosterOf(row.orgSlug, coordinatorIds) : undefined,
		door,
	);
}

/**
 * Writer-side guard: every ID is an ACTIVE `agents` row stamped with `orgSlug`
 * (the roster's own organisation), de-duplicated in order. A roster can only be
 * written with the agents of its own org, so a fleet agent or another org's
 * agent cannot be listed by construction. Throws `AGENT_NOT_IN_ORG`.
 */
export async function requireAgentsOfOrg(
	ctx: Ctx,
	orgSlug: string,
	ids: readonly Id<"agents">[],
): Promise<Id<"agents">[]> {
	const out: Id<"agents">[] = [];
	for (const id of ids) {
		const agent = await ctx.db.get(id);
		if (agent === null || !agent.isActive || agent.orgSlug !== orgSlug) {
			throw new ConvexError(
				`AGENT_NOT_IN_ORG: "${id}" is not an active agent of org "${orgSlug}"; a roster lists the agents of its own organisation only`,
			);
		}
		if (!out.includes(id)) out.push(id);
	}
	return out;
}
