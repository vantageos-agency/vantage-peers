import {
	type ActingPrincipal,
	assertPrincipalListed,
	type IdentityRefusal,
	type PrincipalIdList,
	resolveActingPrincipal,
} from "@vantageos/cloud-identity";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	permanentOrgIdOfSlug,
	principalLookups,
	principalLookupsOverAgents,
} from "./actingPrincipal";

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

// A bound on the roster entries read for one organisation. An org whose roster
// holds more IDs than this has the surplus unseen, which fails closed (not listed).
export const ROSTER_AGENT_SCAN_CAP = 500;

/**
 * The agents of organisation `orgSlug` that its stored ID roster lists, each
 * judged by `resolveActingPrincipal` + `assertPrincipalListed`. The roster IS
 * the list of IDs, so each entry is read as ONE keyed probe of the primary-key
 * index (`by_id`), never a scan of the org's agents. This function compares no
 * organisation itself: an agent stamped with another organisation is refused by
 * `resolveActingPrincipal` (`other-organisation`) and dropped here, as is an
 * unlisted, inactive or unknown one; nothing is matched by a name.
 */
export async function listedAgentsOfOrg(
	ctx: Ctx,
	orgClerkId: string | undefined,
	rosterIds: readonly string[],
	door: string,
): Promise<Doc<"agents">[]> {
	// An organisation with no permanent ID lists nobody (never matched by slug).
	if (orgClerkId === undefined) return [];
	if (rosterIds.length === 0) return [];
	const agents: Doc<"agents">[] = [];
	for (const entry of new Set(rosterIds)) {
		if (agents.length >= ROSTER_AGENT_SCAN_CAP) break;
		const id = ctx.db.normalizeId("agents", entry);
		if (id === null) continue;
		const agent = await ctx.db
			.query("agents")
			.withIndex("by_id", (q) => q.eq("_id", id))
			.unique();
		if (agent !== null) agents.push(agent);
	}
	const lookups = principalLookupsOverAgents(ctx, agents);
	const list = rosterOf(orgClerkId, rosterIds);
	const out: Doc<"agents">[] = [];
	for (const agent of agents) {
		const resolved = await resolveActingPrincipal(
			{ kind: "agent", agentId: agent._id, verifiedOrgId: orgClerkId },
			lookups,
			door,
		);
		if (!resolved.ok) continue;
		if (!assertPrincipalListed(resolved.principal, list, { door }).ok) continue;
		out.push(agent);
	}
	return out;
}

/** A roster stored under `orgId`; `ids` undefined means none is stored. */
export function rosterOf(
	orgId: string | null | undefined,
	ids: readonly Id<"agents">[] | readonly string[] | undefined,
): PrincipalIdList | undefined {
	if (orgId === null || orgId === undefined || ids === undefined) return undefined;
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
	// The agent's org is its stored permanent ID; a row with none is no coordinator.
	const rowOrgId = row.clerkOrgId;
	const kind =
		rowOrgId === undefined
			? undefined
			: await principalLookups(ctx).orgKindOf?.(rowOrgId);
	return agentListedOnRoster(
		ctx,
		{ agentId: row._id, agentOrgId: rowOrgId ?? "" },
		kind === "operator" && rowOrgId !== undefined
			? rosterOf(rowOrgId, coordinatorIds)
			: undefined,
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
	orgClerkId?: string,
): Promise<Id<"agents">[]> {
	const out: Id<"agents">[] = [];
	// The roster's organisation is its permanent ID: the one the caller holds,
	// else the one the label names now. With none, no agent can be listed.
	const orgId = orgClerkId ?? (await permanentOrgIdOfSlug(ctx, orgSlug));
	if (orgId === undefined && ids.length > 0) {
		throw new ConvexError(
			`AGENT_NOT_IN_ORG: org "${orgSlug}" has no permanent organisation ID, so no agent can be listed on its roster`,
		);
	}
	for (const id of ids) {
		// The package decides: the agent is read by ID and must be active and
		// stamped with `orgSlug`, in an active organisation. Nothing is compared here.
		const resolved = await resolveActingPrincipal(
			{ kind: "agent", agentId: id, verifiedOrgId: orgId ?? "" },
			principalLookups(ctx),
			"rosterIds:requireAgentsOfOrg",
		);
		if (!resolved.ok) {
			throw new ConvexError(
				`AGENT_NOT_IN_ORG: "${id}" is not an active agent of org "${orgSlug}"; a roster lists the agents of its own organisation only`,
			);
		}
		if (!out.includes(id)) out.push(id);
	}
	return out;
}
