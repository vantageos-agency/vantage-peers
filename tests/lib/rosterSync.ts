import type { GenericMutationCtx } from "convex/server";
import { normalizeOrchestratorId } from "../../convex/_helpers/normalizeOrchestratorId";
import type { DataModel, Id } from "../../convex/_generated/dataModel";

/**
 * TEST FIXTURE ONLY. Module M7 batch B: a member's acting agent, an assignee and a
 * schedule's assignee are held to the org's roster BY AGENT ID
 * (`client_org_mapping.allowedAgentIds`), not by name. A test that seeded an
 * organisation by its legacy NAME roster (`allowedOrchestrators`) and registers
 * agents under those labels means "this agent is on the roster": this lists every
 * agent of `orgSlug` whose label the mapping's name roster carries, by ID, keeping
 * the IDs already listed. A mapping that does not exist yet is left alone (the
 * caller seeds the mapping first), and "*" names nobody.
 */
export async function syncRosterIdsFromNames(
	ctx: GenericMutationCtx<DataModel>,
	orgSlug: string,
): Promise<void> {
	const mapping = (await ctx.db.query("client_org_mapping").collect()).find(
		(m) => m.clerkOrgSlug === orgSlug,
	);
	if (mapping === undefined) return;
	const names = new Set(
		mapping.allowedOrchestrators
			.filter((n) => n !== "*")
			.map((n) => normalizeOrchestratorId(n)),
	);
	const agents = await ctx.db
		.query("agents")
		.withIndex("by_org", (q) => q.eq("orgSlug", orgSlug))
		.collect();
	const listed = new Set<Id<"agents">>(mapping.allowedAgentIds ?? []);
	for (const agent of agents) {
		if (names.has(agent.normalizedName ?? normalizeOrchestratorId(agent.name))) {
			listed.add(agent._id);
		}
	}
	await ctx.db.patch(mapping._id, { allowedAgentIds: [...listed] });
}

type Runner = {
	run: <Output>(
		func: (ctx: GenericMutationCtx<DataModel>) => Promise<Output>,
	) => Promise<Output>;
};

/**
 * TEST FIXTURE ONLY. `syncRosterIdsFromNames` for a test that registered its agents
 * through the production door (`agents:registerAgent`), which does not touch the
 * org's roster: lists, by ID, the agents of each given org whose label the
 * mapping's name roster carries.
 */
export async function listRegisteredAgentsOnRoster(
	t: Runner,
	orgSlugs: readonly string[],
): Promise<void> {
	await t.run(async (ctx) => {
		for (const orgSlug of orgSlugs) {
			await syncRosterIdsFromNames(ctx, orgSlug);
		}
	});
}
