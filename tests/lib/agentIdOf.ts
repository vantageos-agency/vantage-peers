import type { DataModel, Id } from "../../convex/_generated/dataModel";
import type { GenericMutationCtx } from "convex/server";
import { normalizeOrchestratorId } from "../../convex/_helpers/normalizeOrchestratorId";
import { syncRosterIdsFromNames } from "./rosterSync";

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
			const mapping = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", orgSlug))
				.first();
			await ctx.db.insert("agents", {
				orgSlug,
				...(mapping?.clerkOrgId !== undefined
					? { clerkOrgId: mapping.clerkOrgId }
					: {}),
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: 1,
			});
		}
		// Module M7 batch B: an agent registered under a label its org's mapping
		// lists by NAME is on the org's roster by ID too.
		for (const orgSlug of new Set(pairs.map(([slug]) => slug))) {
			await syncRosterIdsFromNames(ctx, orgSlug);
		}
	});
}

/**
 * TEST FIXTURE ONLY. The ID of the agent row an org holds under `name`, read
 * inside a `t.run` callback (`findAgentId` above takes the test client). Absent
 * when the org holds no such agent. A fixture that inserts a task or a mission
 * row directly stamps `assignedToId` / `pilotId` with it, as the write doors do.
 */
export async function agentIdInCtx(
	ctx: Pick<GenericMutationCtx<DataModel>, "db">,
	orgSlug: string,
	name: string,
): Promise<Id<"agents"> | undefined> {
	const key = normalizeOrchestratorId(name);
	const rows = await ctx.db
		.query("agents")
		.withIndex("by_org", (q) => q.eq("orgSlug", orgSlug))
		.collect();
	return rows.find((r) => normalizeOrchestratorId(r.name) === key)?._id;
}
