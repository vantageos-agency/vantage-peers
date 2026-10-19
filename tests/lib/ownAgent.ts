import type { DataModel } from "../../convex/_generated/dataModel";
import type { GenericMutationCtx } from "convex/server";
import { testClerkOrgId } from "../fixtures/testClerkOrgId";

type Runner = {
	run: <Output>(
		func: (ctx: GenericMutationCtx<DataModel>) => Promise<Output>,
	) => Promise<Output>;
};

/** TEST FIXTURE ONLY. The Clerk user ID the fixtures give every agent of `orgSlug` as its owner. */
export const ownerOf = (orgSlug: string): string => `user_owner${orgSlug.replace(/[^A-Za-z0-9]/g, "")}`;

/**
 * TEST FIXTURE ONLY. Binds the agent `name` of `orgSlug` to a human owner who is
 * a LIVE member of that organisation: sets `agents.ownerPersonId` and inserts the
 * `orgMembership` row keyed (clerkOrgId, clerkUserId) that the Clerk webhook
 * would keep. An agent credential resolves only for an agent seeded this way.
 */
export async function ownAgent(
	t: Runner,
	orgSlug: string,
	name: string,
	clerkOrgId: string = testClerkOrgId(orgSlug),
): Promise<void> {
	await t.run(async (ctx) => {
		const agent = await ctx.db
			.query("agents")
			.withIndex("by_org", (q) => q.eq("orgSlug", orgSlug))
			.collect()
			.then((rows) => rows.find((r) => r.name === name));
		if (!agent) throw new Error(`fixture: no agent ${orgSlug}/${name}`);
		const owner = ownerOf(orgSlug);
		await ctx.db.patch(agent._id, { ownerPersonId: owner });
		const existing = await ctx.db
			.query("orgMembership")
			.withIndex("by_org_user_clerk_id", (q) =>
				q.eq("clerkOrgId", clerkOrgId).eq("clerkUserId", owner),
			)
			.unique();
		if (existing === null) {
			await ctx.db.insert("orgMembership", {
				clerkOrgSlug: orgSlug,
				clerkOrgId,
				clerkUserId: owner,
				role: "member",
				createdAt: 1,
				updatedAt: 1,
			});
		}
	});
}

/** TEST FIXTURE ONLY. Tombstones the owner's membership of `orgSlug`, as the Clerk webhook does on a delete. */
export async function tombstoneOwnerMembership(
	t: Runner,
	orgSlug: string,
	deletedAt: number,
): Promise<void> {
	await t.run(async (ctx) => {
		const row = await ctx.db
			.query("orgMembership")
			.withIndex("by_org_user_clerk_id", (q) =>
				q.eq("clerkOrgId", testClerkOrgId(orgSlug)).eq("clerkUserId", ownerOf(orgSlug)),
			)
			.unique();
		if (row === null) throw new Error(`fixture: no membership row for ${orgSlug}`);
		await ctx.db.patch(row._id, { deletedAt });
	});
}
