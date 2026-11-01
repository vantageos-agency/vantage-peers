import type { GenericMutationCtx } from "convex/server";
import { normalizeOrchestratorId } from "../../convex/_helpers/normalizeOrchestratorId";
import type { DataModel, Id } from "../../convex/_generated/dataModel";
import { testClerkOrgId } from "../fixtures/testClerkOrgId";

type Runner = {
	run: <Output>(
		func: (ctx: GenericMutationCtx<DataModel>) => Promise<Output>,
	) => Promise<Output>;
};

/**
 * TEST FIXTURE ONLY. Since module M10e a mission door judges a pilot, a
 * participant and a creator by agents-row ID. A test that seeded an
 * organisation by its legacy NAME roster (`allowedOrchestrators`) calls this
 * once after seeding its `client_org_mapping` rows: every active mapping gets
 * one ACTIVE agents row per roster name (skipping "*" and names that already
 * have a row) and its `allowedAgentIds` set to those rows, in roster order.
 * Returns the agents-row ID by `<orgSlug>/<name>` for tests that insert
 * mission rows directly.
 */
export async function seedRosterAgents(
	t: Runner,
): Promise<Record<string, Id<"agents">>> {
	return await t.run(async (ctx) => {
		const ids: Record<string, Id<"agents">> = {};
		const mappings = await ctx.db.query("client_org_mapping").collect();
		for (const mapping of mappings) {
			if (!mapping.isActive) continue;
			const rosterIds: Id<"agents">[] = [];
			for (const name of mapping.allowedOrchestrators) {
				if (name === "*") continue;
				const key = normalizeOrchestratorId(name);
				const existing = (
					await ctx.db
						.query("agents")
						.withIndex("by_org", (q) => q.eq("orgSlug", mapping.clerkOrgSlug))
						.collect()
				).find((a) => a.normalizedName === key);
				const id =
					existing?._id ??
					(await ctx.db.insert("agents", {
						orgSlug: mapping.clerkOrgSlug,
						...(mapping.clerkOrgId !== undefined
							? { clerkOrgId: mapping.clerkOrgId }
							: {}),
						name,
						normalizedName: key,
						isActive: true,
						createdAt: 1,
					}));
				ids[`${mapping.clerkOrgSlug}/${name}`] = id;
				rosterIds.push(id);
			}
			await ctx.db.patch(mapping._id, { allowedAgentIds: rosterIds });
		}
		return ids;
	});
}

/**
 * TEST FIXTURE ONLY. A fleet-master door resolves a label in the OPERATOR org
 * (nothing else can name an agent for a master). Ensures one active operator
 * `client_org_mapping` row (slug `slug`, created once) and one ACTIVE agents row
 * per `names` entry in it; returns the agents-row ID by name. Idempotent.
 */
export async function seedOperatorOrg(
	t: Runner,
	names: readonly string[],
	slug = "operator-fixture-org",
): Promise<Record<string, Id<"agents">>> {
	return await t.run(async (ctx) => {
		// An operator org already seeded (the service-account fixture creates one)
		// is reused: two active operator orgs name no fleet at all.
		const operator = (await ctx.db.query("client_org_mapping").collect()).find(
			(m) => m.orgKind === "operator" && m.isActive,
		);
		if (operator === undefined) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: 1,
				orgKind: "operator",
			});
		}
		const orgSlug = operator?.clerkOrgSlug ?? slug;
		const ids: Record<string, Id<"agents">> = {};
		for (const name of names) {
			const key = normalizeOrchestratorId(name);
			const row = (
				await ctx.db
					.query("agents")
					.withIndex("by_org", (q) => q.eq("orgSlug", orgSlug))
					.collect()
			).find((a) => a.normalizedName === key);
			ids[name] =
				row?._id ??
				(await ctx.db.insert("agents", {
					orgSlug,
					clerkOrgId: operator?.clerkOrgId ?? testClerkOrgId(slug),
					name,
					normalizedName: key,
					isActive: true,
					createdAt: 1,
				}));
		}
		return ids;
	});
}
