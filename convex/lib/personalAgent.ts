import { resolvePersonalAgent, sameOrg } from "@vantageos/cloud-identity";
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
// ONE AGENT PER AI CLIENT. A person holds several agents (Claude, ChatGPT, Grok);
// the agent a token acts as is the one CHOSEN at consent and stamped on the token
// row by ID. Resolution, in this order:
//   1. a stamped agent (`agentId`): acts as it ONLY while that agent is still
//      active, still in the token's organisation (by permanent ID) and still
//      designates the token's person; otherwise the person, never another agent;
//   2. the person decided "connect as myself" (`connectedAs`): the person;
//   3. a token minted before the choice existed: today's rule, exactly one
//      designating agent -> that agent, none or several -> the person.
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
	row: Pick<
		Doc<"oauth_access_tokens">,
		| "principal"
		| "userId"
		| "clerkOrgSlug"
		| "clerkOrgId"
		| "agentId"
		| "connectedAs"
	>,
	door: string,
): Promise<PersonalAgent | null> {
	if (row.principal !== "person") return null;
	if (row.clerkOrgSlug === undefined || row.clerkOrgSlug === "") return null;
	// (1) the agent stamped at consent, judged live; (2) a decision to connect as
	// the person is never overridden by a designation.
	// A stamped agent that is gone, or no longer in the token's organisation, leaves
	// the person acting as themselves: nobody else is put in its place. The
	// organisation is judged by PERMANENT ID (a side without one never matches);
	// active / designation are judged by the package below.
	const stamped =
		row.agentId === undefined ? null : await ctx.db.get(row.agentId);
	if (
		row.agentId !== undefined &&
		(stamped === null ||
			!sameOrg({ id: stamped.clerkOrgId }, { id: row.clerkOrgId }))
	) {
		return null;
	}
	if (stamped === null && row.connectedAs === "person") return null;
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
				// The stamped agent is the ONLY candidate when there is one: nothing else
				// is counted or picked in its place. The package judges active /
				// designation / organisation over what is returned.
				return rows
					.filter((a) => stamped === null || a._id === stamped._id)
					.map((a) => ({
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
