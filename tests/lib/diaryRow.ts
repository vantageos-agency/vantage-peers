// TEST FIXTURE ONLY. Since batch F1 a diary row names its orchestrator by AGENT ID
// (`agentId`): the doors select, key and admit on it, and a row without it is
// served to nobody. A test that seeds a diary row directly inserts it through this,
// which stamps `agentId` with the agent of the row's orchestrator LABEL in the
// row's OWN org (the operator org for an unstamped, fleet-owned row), exactly as
// migrations/backfill_diary_agent_ids does for the stored rows of a deployment.
// A label that names no agent there leaves the column unset (a legacy row).

import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx } from "../../convex/_generated/server";

type DiaryDoc = Omit<Doc<"diary">, "_id" | "_creationTime">;

export async function insertDiary(
	ctx: { db: MutationCtx["db"] },
	doc: DiaryDoc,
): Promise<Id<"diary">> {
	let orgId = doc.clerkOrgId;
	if (orgId === undefined) {
		const mappings = await ctx.db.query("client_org_mapping").collect();
		orgId = mappings.find((m) => m.orgKind === "operator" && m.isActive)
			?.clerkOrgId;
	}
	const agents = await ctx.db.query("agents").collect();
	const agent = agents.find(
		(a) =>
			a.name === doc.orchestrator &&
			orgId !== undefined &&
			a.clerkOrgId === orgId,
	);
	return await ctx.db.insert("diary", {
		...doc,
		...(agent === undefined || doc.agentId !== undefined
			? {}
			: { agentId: agent._id }),
	});
}
