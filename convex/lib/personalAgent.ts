import { resolvePersonalAgent } from "@vantageos/cloud-identity";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { principalLookups, refuseWith } from "./actingPrincipal";

// ─────────────────────────────────────────────────────────────────────────────
// personalAgent — the vantage-peers ADAPTER onto @vantageos/cloud-identity's
// `resolvePersonalAgent`. It decides nothing about identity: it performs the
// indexed read BY ID the package asks for (the agent rows of the token's own
// organisation that designate the token's own person) and turns the package's
// typed refusal into this backend's RBAC_DENIED ConvexError. Task
// k17ee3efn6xz4zpapcg68sgvnh8h43gt.
//
// A refusal is RAISED, never turned into "the person": a read that failed must
// not silently change who is acting.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

/** Rows read for one person in one org. Over the cap the read FAILS (fail closed), never truncates. */
const DESIGNATED_AGENTS_CAP = 50;

export type PersonalAgent = {
	agentId: Doc<"agents">["_id"];
	orgId: string;
	agentName: string;
};

/**
 * The agent a PERSON token acts as, or null when the person stays the person
 * (not a person token, no organisation on it, none / ambiguous / inactive).
 * The person and organisation are the TOKEN ROW's own stored values.
 */
export async function personalAgentOfToken(
	ctx: Ctx,
	row: Pick<Doc<"oauth_access_tokens">, "principal" | "userId" | "clerkOrgSlug">,
	door: string,
): Promise<PersonalAgent | null> {
	if (row.principal !== "person") return null;
	if (row.clerkOrgSlug === undefined || row.clerkOrgSlug === "") return null;
	const resolved = await resolvePersonalAgent(
		{ personId: row.userId, orgId: row.clerkOrgSlug },
		{
			designatedAgents: async (personId, orgId) => {
				const rows = await ctx.db
					.query("agents")
					.withIndex("by_personal_agent_of", (q) =>
						q.eq("personalAgentOf", personId).eq("orgSlug", orgId),
					)
					.take(DESIGNATED_AGENTS_CAP + 1);
				if (rows.length > DESIGNATED_AGENTS_CAP) {
					throw new Error("designation scan cap exceeded");
				}
				return rows.map((a) => ({
					id: a._id,
					orgId: a.orgSlug,
					active: a.isActive,
					personalAgentOf: personId,
				}));
			},
			principalLookups: principalLookups(ctx),
		},
		{ door },
	);
	if (!resolved.ok) refuseWith(resolved.refusal);
	if (resolved.actingAs !== "agent") return null;
	const id = ctx.db.normalizeId("agents", resolved.principal.principalId);
	const agent = id === null ? null : await ctx.db.get(id);
	if (agent === null) return null;
	return { agentId: agent._id, orgId: agent.orgSlug, agentName: agent.name };
}
