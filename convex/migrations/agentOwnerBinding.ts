// agentOwnerBinding -- READ-ONLY, NUMBERS-ONLY count of the owner binding of the agents of ONE
// organisation. Task k176v7x1xr5shra8j3d8v4rp718hs4n2 (Pi ruling (a): a count door to learn which
// case applies; no setAgentOwner write).
//
// Why. An agent credential resolves only for an agent that names a human owner and an
// organisation id, whose owner is a live member of that organisation
// (agentCredentials:resolveAgentCredential). Otherwise it is refused with one of the reasons
// `owner-missing`, `org-id-missing`, `agent-owner-not-member`, ... This door says, for one
// org, how many agents sit in each of those states, so an operator learns which refusal applies
// without reading a row.
//
// THE RULE IS NOT RE-IMPLEMENTED. `ownerIsLiveMember` is decided by `ownerBindingOfAgent`
// (convex/lib/agentIdentity.ts), the very composition the credential door runs after it has
// found the agent: @vantageos/cloud-identity `resolveCallerFromAgentCredential` over the
// organisation mapping and the live `orgMembership` rows. Membership lives in this deployment
// (the Clerk webhook keeps `orgMembership`), so it is decidable here and is always a number;
// there is no `null` path. An agent the rule refuses for any reason (retired, no owner, no org
// id, owner not a member or tombstoned, org inactive) is not counted live.
//
// FIELDS (all numbers, one boolean; no id, label, email, owner id or secret ever leaves):
//   agents              rows of the org, by the `orgSlug` label
//   activeAgents        of those, isActive
//   withOwnerPersonId   of those, ownerPersonId present
//   withClerkOrgId      of those, clerkOrgId present
//   ownerIsLiveMember   of those, the shared rule accepts the owner binding
//   activeCredentials   agent_credentials rows with isActive, tied to those agents by agentId
//   truncated           true when a bound was hit; every number is then a lower bound
//
// BOUNDS. Internal (deployment-admin only), one org per call. At most MAX_AGENTS agents are read
// and at most MAX_CREDENTIALS credential rows per agent; hitting either sets `truncated`.
//
//   bash .claude/scripts/convex-prod.sh run migrations/agentOwnerBinding:count '{"orgSlug":"<slug>"}'

import { ConvexError, v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { ownerBindingOfAgent } from "../lib/agentIdentity";

export const MAX_AGENTS = 2000;
export const MAX_CREDENTIALS = 200;

const DOOR = "migrations/agentOwnerBinding:count";

export const count = internalQuery({
	args: { orgSlug: v.string() },
	returns: v.object({
		agents: v.number(),
		activeAgents: v.number(),
		withOwnerPersonId: v.number(),
		withClerkOrgId: v.number(),
		ownerIsLiveMember: v.number(),
		activeCredentials: v.number(),
		truncated: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const orgSlug = args.orgSlug.trim();
		if (orgSlug === "") {
			throw new ConvexError(
				`${DOOR}: orgSlug is empty; refusing to answer an empty label as an empty org.`,
			);
		}
		const rows = await ctx.db
			.query("agents")
			.withIndex("by_org", (q) => q.eq("orgSlug", orgSlug))
			.take(MAX_AGENTS + 1);
		let truncated = rows.length > MAX_AGENTS;
		const agents = truncated ? rows.slice(0, MAX_AGENTS) : rows;

		let activeAgents = 0;
		let withOwnerPersonId = 0;
		let withClerkOrgId = 0;
		let ownerIsLiveMember = 0;
		let activeCredentials = 0;
		for (const agent of agents) {
			if (agent.isActive) activeAgents += 1;
			if (agent.ownerPersonId !== undefined) withOwnerPersonId += 1;
			if (agent.clerkOrgId !== undefined) withClerkOrgId += 1;
			if ((await ownerBindingOfAgent(ctx, agent, DOOR)).ok) {
				ownerIsLiveMember += 1;
			}
			const creds = await ctx.db
				.query("agent_credentials")
				.withIndex("by_agent", (q) => q.eq("agentId", agent._id))
				.take(MAX_CREDENTIALS + 1);
			if (creds.length > MAX_CREDENTIALS) truncated = true;
			activeCredentials += creds
				.slice(0, MAX_CREDENTIALS)
				.filter((c) => c.isActive).length;
		}
		return {
			agents: agents.length,
			activeAgents,
			withOwnerPersonId,
			withClerkOrgId,
			ownerIsLiveMember,
			activeCredentials,
			truncated,
		};
	},
});
