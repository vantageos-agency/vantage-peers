import type { GenericMutationCtx } from "convex/server";
import type { DataModel } from "../../convex/_generated/dataModel";

type Runner = {
	run: <Output>(
		func: (ctx: GenericMutationCtx<DataModel>) => Promise<Output>,
	) => Promise<Output>;
};

/**
 * TEST FIXTURE ONLY. The operator organisation's permanent ID, read from its active
 * `orgKind: "operator"` mapping: what a fleet-master write is stamped with (task
 * k176x68sj2jkwx46nshvtt40e18ht1xh).
 */
export async function operatorClerkOrgId(t: Runner): Promise<string | undefined> {
	return await t.run(
		async (ctx) =>
			(await ctx.db.query("client_org_mapping").collect()).find(
				(r) => r.orgKind === "operator" && r.isActive,
			)?.clerkOrgId,
	);
}
