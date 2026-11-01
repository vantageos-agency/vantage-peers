// appendAgentsToRoster -- the one append of agents to an organisation's roster, shared
// by clientOrgMapping:addRosterMembers (client orgs) and
// clientOrgMapping:addOperatorRosterMember (the operator org), so the two cannot
// drift on what "listed" means. The CALLER has already settled which mapping row
// is edited and whether this path may edit it; this function only validates the
// agents and writes.
//
// BY AGENT ID: the roster is `allowedAgentIds`. Every agent must be ACTIVE and
// stamped with the row's own org, so an org cannot list another org's agent.
// APPEND ONLY: nothing is removed or reordered, an id already present is a no-op.
// The whole call is validated before the single patch, so a refusal leaves the
// roster untouched, and a call that changes nothing writes nothing.
//
// EXPAND-PHASE DUAL WRITE. The legacy NAME roster (`allowedOrchestrators`) still
// feeds the readers that compare a stored name, so the agent's exact stored name
// is appended there too (deduped spelling-insensitively). That copy is a label
// snapshot, never an authority: nothing that decides on an agent reads it.

import { ConvexError } from "convex/values";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { OrgMappingView } from "./authOrgMapping";

export type RosterAppend = {
	previous: Id<"agents">[];
	current: Id<"agents">[];
	added: boolean;
};

export async function appendAgentsToRoster(
	ctx: MutationCtx,
	row: OrgMappingView,
	agentIds: readonly Id<"agents">[],
): Promise<RosterAppend> {
	const previous = row.allowedAgentIds ?? [];
	const current: Id<"agents">[] = [...previous];
	const labels = [...row.allowedOrchestrators];
	for (const id of agentIds) {
		const agent = await ctx.db.get(id);
		if (agent === null || !agent.isActive || agent.orgSlug !== row.clerkOrgSlug) {
			throw new ConvexError(
				`AGENT_NOT_IN_ORG: "${id}" is not an active agent of org "${row.clerkOrgSlug}"; a roster lists the agents of its own organisation only`,
			);
		}
		if (!current.includes(id)) current.push(id);
		const label = normalizeOrchestratorId(agent.name);
		if (!labels.some((entry) => normalizeOrchestratorId(entry) === label)) {
			labels.push(agent.name);
		}
	}
	const added =
		current.length !== previous.length ||
		labels.length !== row.allowedOrchestrators.length;
	if (added) {
		await ctx.db.patch(row._id, {
			allowedAgentIds: current,
			allowedOrchestrators: labels,
		});
	}
	return { previous, current, added };
}
