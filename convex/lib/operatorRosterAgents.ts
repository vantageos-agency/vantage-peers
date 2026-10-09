// operatorRosterAgents — a client org addresses a fleet agent BY ID.
//
// A client organisation T lists fleet coordinators by NAME on its roster
// (`client_org_mapping.allowedOrchestrators`, e.g. "pi"), but the agent that
// reads that mail is an `agents` row of the OPERATOR org. A receipt written in
// tenant T to "pi" carried no recipientId, and the operator org's verified
// reader (matched by ID, legacy names only inside ITS OWN org) never saw it.
//
// Identity by ID, never by name. The name is resolved ONCE, at write time (or in
// the backfill), INSIDE ONE ORG: the operator org. Nothing here is a read-time
// name match across orgs; the stamped ID is the proof the reader later presents.
//
// Rules (shared by sendMessage, recipientAgentIds and backfill_actor_ids):
//   - T's OWN agent of that name wins; callers consult this module only when T
//     has no agent of that name.
//   - the name must be on T's roster (normalised; "*" names nobody);
//   - exactly ONE active operator-org agent carries the name; zero or 2+ is
//     undecidable and the caller leaves the ID unset (as before);
//   - T must be a client org: the operator org addressing itself is the plain
//     in-org resolution, not this one.

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import { fleetOperatorSlug } from "./operatorOrg";

type Ctx = QueryCtx | MutationCtx;

/** Is `name` on this roster (normalised compare; "*" names nobody)? */
export function isNameOnRoster(
	roster: readonly string[],
	name: string,
): boolean {
	const claimed = normalizeOrchestratorId(name);
	return roster.some(
		(entry) => entry !== "*" && normalizeOrchestratorId(entry) === claimed,
	);
}

/**
 * The ONE active agent of `orgSlug` carrying `name` (normalised), or undefined
 * when there is none or more than one. Both name indexes are probed so a legacy
 * row without `normalizedName` is counted, and a row is counted once.
 */
export async function uniqueActiveAgentInOrg(
	ctx: Ctx,
	orgSlug: string,
	name: string,
): Promise<Doc<"agents"> | undefined> {
	const normalized = normalizeOrchestratorId(name);
	const byNormalized = await ctx.db
		.query("agents")
		.withIndex("by_org_normalized_name", (q) =>
			q.eq("orgSlug", orgSlug).eq("normalizedName", normalized),
		)
		.take(3);
	const byName = await ctx.db
		.query("agents")
		.withIndex("by_org_name", (q) => q.eq("orgSlug", orgSlug).eq("name", name))
		.take(3);
	const found = new Map<string, Doc<"agents">>();
	for (const row of [...byNormalized, ...byName]) {
		if (normalizeOrchestratorId(row.name) === normalized && row.isActive) {
			found.set(row._id, row);
		}
	}
	return found.size === 1 ? [...found.values()][0] : undefined;
}

/**
 * The operator-org agent a client tenant's roster name denotes, or undefined.
 * `roster` is the tenant's `allowedOrchestrators`. Undefined when the tenant is
 * the operator org itself, when there is not exactly one active operator org,
 * when the name is not on the roster, or when it does not resolve to exactly one
 * active operator-org agent.
 */
export async function operatorAgentForRosterName(
	ctx: Ctx,
	tenantSlug: string,
	roster: readonly string[],
	name: string,
): Promise<Doc<"agents"> | undefined> {
	if (!isNameOnRoster(roster, name)) return undefined;
	const operator = await fleetOperatorSlug(ctx.db);
	if (operator === undefined || operator === tenantSlug) return undefined;
	return await uniqueActiveAgentInOrg(ctx, operator, name);
}
