import type { GenericMutationCtx } from "convex/server";
import { normalizeOrchestratorId } from "../../convex/_helpers/normalizeOrchestratorId";
import type { DataModel } from "../../convex/_generated/dataModel";
import { testClerkOrgId } from "../fixtures/testClerkOrgId";

type Runner = {
	run: <Output>(
		func: (ctx: GenericMutationCtx<DataModel>) => Promise<Output>,
	) => Promise<Output>;
};

/**
 * TEST FIXTURE ONLY. Since module M10c a briefing note's author and participants
 * are judged by agents-row ID, so a test that hand-seeds notes whose
 * `createdBy` / `participants` are bare labels calls this once after seeding:
 * every label becomes an ACTIVE agents row of the note's OWN org (the operator
 * org, created if absent, for an unstamped fleet note). Idempotent; a person
 * ("user:...") needs no row.
 */
export async function seedBriefingNoteAgents(t: Runner): Promise<void> {
	await t.run(async (ctx) => {
		const mappings = await ctx.db.query("client_org_mapping").collect();
		let operatorSlug = mappings.find(
			(m) => m.isActive && m.orgKind === "operator",
		)?.clerkOrgSlug;
		for (const note of await ctx.db.query("briefingNotes").collect()) {
			let slug = note.orgId;
			if (slug === undefined) {
				if (operatorSlug === undefined) {
					operatorSlug = "fleet-operator";
					await ctx.db.insert("client_org_mapping", {
						clerkOrgSlug: operatorSlug,
						clerkOrgId: testClerkOrgId(operatorSlug),
						allowedOrchestrators: [],
						scopes: [],
						displayName: operatorSlug,
						isActive: true,
						createdAt: 1,
						orgKind: "operator",
					});
				}
				slug = operatorSlug;
			}
			const orgSlug = slug;
			const labels = new Set([note.createdBy, ...note.participants]);
			for (const name of labels) {
				if (name.startsWith("user:")) continue;
				const key = normalizeOrchestratorId(name);
				const existing = await ctx.db
					.query("agents")
					.withIndex("by_org_normalized_name", (q) =>
						q.eq("orgSlug", orgSlug).eq("normalizedName", key),
					)
					.first();
				if (existing !== null) continue;
				await ctx.db.insert("agents", {
					orgSlug,
					...(note.clerkOrgId !== undefined || note.orgId === undefined
						? { clerkOrgId: note.clerkOrgId ?? testClerkOrgId(orgSlug) }
						: {}),
					name,
					normalizedName: key,
					isActive: true,
					createdAt: 1,
				});
			}
		}
	});
}
