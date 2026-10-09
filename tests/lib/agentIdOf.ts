import type { DataModel, Id } from "../../convex/_generated/dataModel";
import type { GenericMutationCtx } from "convex/server";
import { normalizeOrchestratorId } from "../../convex/_helpers/normalizeOrchestratorId";

type Runner = {
	run: <Output>(
		func: (ctx: GenericMutationCtx<DataModel>) => Promise<Output>,
	) => Promise<Output>;
};

/** TEST FIXTURE ONLY. The ID of the agent row an org holds under `name`, or null. */
export async function findAgentId(
	t: Runner,
	orgSlug: string,
	name: string,
): Promise<Id<"agents"> | null> {
	return await t.run(async (ctx) => {
		const key = normalizeOrchestratorId(name);
		const rows = await ctx.db
			.query("agents")
			.withIndex("by_org", (q) => q.eq("orgSlug", orgSlug))
			.collect();
		return rows.find((r) => normalizeOrchestratorId(r.name) === key)?._id ?? null;
	});
}

/**
 * TEST FIXTURE ONLY. The agent registry doors take an agent ID; a test that
 * seeded an agent by label reads the ID of the row it just created here. When no
 * row carries the label it returns a well-formed ID that names no row (a row is
 * inserted and deleted), so a test can exercise the "no such agent" refusal
 * without a malformed argument.
 */
export async function agentIdOf(
	t: Runner,
	orgSlug: string,
	name: string,
): Promise<Id<"agents">> {
	const hit = await findAgentId(t, orgSlug, name);
	if (hit) return hit;
	return await t.run(async (ctx) => {
		const id = await ctx.db.insert("agents", {
			orgSlug,
			name: `ghost-${normalizeOrchestratorId(name)}`,
			isActive: true,
			createdAt: 0,
		});
		await ctx.db.delete(id);
		return id;
	});
}

/** TEST FIXTURE ONLY. Seeds one ACTIVE agent row per [orgSlug, label] pair. */
export async function seedAgents(
	t: Runner,
	pairs: ReadonlyArray<readonly [orgSlug: string, name: string]>,
): Promise<void> {
	await t.run(async (ctx) => {
		for (const [orgSlug, name] of pairs) {
			await ctx.db.insert("agents", {
				orgSlug,
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: 1,
			});
		}
	});
}
