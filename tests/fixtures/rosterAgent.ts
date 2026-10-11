// TEST FIXTURE ONLY. Since module M10b the diary judges the orchestrator a member
// may reach by AGENT ID: the name is an `agents` row of the member's own org and
// that row's id is an entry of the org's `allowedAgentIds`. A fixture that models
// an org by its slug and a roster NAME calls this once per name, after the
// `client_org_mapping` row exists, so the name resolves to an agent and the agent
// is on the stored ID roster, exactly as a provisioned org does.

import type { Id } from "../../convex/_generated/dataModel";
import type { MutationCtx } from "../../convex/_generated/server";
import { normalizeOrchestratorId } from "../../convex/_helpers/normalizeOrchestratorId";

export async function seedRosterAgent(
	ctx: Pick<MutationCtx, "db">,
	orgSlug: string,
	name: string,
): Promise<Id<"agents">> {
	const mapping = await ctx.db
		.query("client_org_mapping")
		.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", orgSlug))
		.first();
	if (mapping === null) {
		throw new Error(`seedRosterAgent: no client_org_mapping for "${orgSlug}"`);
	}
	const agentId = await ctx.db.insert("agents", {
		orgSlug,
		...(mapping.clerkOrgId !== undefined ? { clerkOrgId: mapping.clerkOrgId } : {}),
		name,
		normalizedName: normalizeOrchestratorId(name),
		isActive: true,
		createdAt: 0,
	});
	await ctx.db.patch(mapping._id, {
		allowedAgentIds: [...(mapping.allowedAgentIds ?? []), agentId],
	});
	return agentId;
}
