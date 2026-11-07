import type { GenericMutationCtx } from "convex/server";
import type { DataModel } from "../../convex/_generated/dataModel";

type Runner = {
	run: <Output>(
		func: (ctx: GenericMutationCtx<DataModel>) => Promise<Output>,
	) => Promise<Output>;
};

/**
 * Seeds the `billableProjects` closure config (empty: no project is billable)
 * if it is absent. tasks:create now refuses a task without a project, and
 * closing a task WITH a project reads this config, so a suite that creates a
 * task and then completes it needs the row. Idempotent.
 */
export async function seedBillableProjects(t: Runner): Promise<void> {
	await t.run(async (ctx) => {
		const existing = await ctx.db
			.query("taskClosureConfig")
			.withIndex("by_key", (q) => q.eq("key", "billableProjects"))
			.first();
		if (existing === null) {
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: 0,
			});
		}
	});
}
