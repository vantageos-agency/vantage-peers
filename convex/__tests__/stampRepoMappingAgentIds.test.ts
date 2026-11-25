/// <reference types="vite/client" />
// stampRepoMappingAgentIds — mission k577f8ksjx5ec3gq9bggc1brqd8jwkbh, S2
// (task k1730d1b6wzwepjyyth266xq958jxfv0). Poles: dry run writes nothing and lists
// what it could not resolve; apply stamps only resolvable labels and never
// overwrites a stored ID; a second apply is a no-op; revert restores exactly.

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedOrgAgents } from "../../tests/lib/seedFleetAgents";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

type T = ReturnType<typeof makeT>;
const makeT = () => convexTest(schema, modules);

async function seed(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			clerkOrgId: testClerkOrgId("org-a"),
			allowedOrchestrators: ["eta", "rev"],
			scopes: [],
			displayName: "org-a",
			isActive: true,
			createdAt: 1,
		});
	});
	await seedOrgAgents(t, [
		["org-a", "eta"],
		["org-a", "rev"],
	]);
	const eta = await t.run(async (ctx) =>
		(await ctx.db.query("agents").withIndex("by_org_normalized_name", (q) => q.eq("orgSlug", "org-a").eq("normalizedName", "eta")).first())?._id,
	);
	await t.run(async (ctx) => {
		const base = { project: "p", active: true, orgId: "org-a", clerkOrgId: testClerkOrgId("org-a") };
		await ctx.db.insert("githubRepoMapping", { ...base, repo: "org-a/legacy", orchestrator: "eta", reviewer: "rev" });
		await ctx.db.insert("githubRepoMapping", { ...base, repo: "org-a/ghost", orchestrator: "eta", reviewer: "nobody" });
		await ctx.db.insert("githubRepoMapping", { ...base, repo: "org-a/done", orchestrator: "eta", orchestratorAgentId: eta });
	});
	return eta;
}

const rowOf = (t: T, repo: string) =>
	t.run(async (ctx) =>
		ctx.db.query("githubRepoMapping").withIndex("by_repo", (q) => q.eq("repo", repo)).unique(),
	);

describe("migrations/stampRepoMappingAgentIds", () => {
	test("DRY RUN: lists what it would stamp and what it cannot resolve, writes nothing", async () => {
		const t = makeT();
		await seed(t);
		const r = await t.mutation(internal.migrations.stampRepoMappingAgentIds.run, {});
		expect(r.mode).toBe("dry-run");
		expect(r.stamped.map((s) => s.fields.length).sort()).toEqual([1, 2]);
		expect(r.unresolved).toEqual([{ repo: "org-a/ghost", role: "reviewerAgentId", label: "nobody" }]);
		expect((await rowOf(t, "org-a/legacy"))?.orchestratorAgentId).toBeUndefined();
	});

	test("APPLY stamps the resolvable labels, keeps a stored ID, is idempotent; REVERT restores", async () => {
		const t = makeT();
		const eta = await seed(t);
		const r = await t.mutation(internal.migrations.stampRepoMappingAgentIds.run, { apply: true });
		expect(r.mode).toBe("applied");
		const legacy = await rowOf(t, "org-a/legacy");
		expect(legacy?.orchestratorAgentId).toBeDefined();
		expect(legacy?.reviewerAgentId).toBeDefined();
		const ghost = await rowOf(t, "org-a/ghost");
		expect(ghost?.orchestratorAgentId).toBeDefined();
		expect(ghost?.reviewerAgentId).toBeUndefined();
		expect((await rowOf(t, "org-a/done"))?.orchestratorAgentId).toBe(eta);

		const again = await t.mutation(internal.migrations.stampRepoMappingAgentIds.run, { apply: true });
		expect(again.stamped).toEqual([]);

		const back = await t.mutation(internal.migrations.stampRepoMappingAgentIds.revert, { stamped: r.stamped });
		expect(back.reverted).toBe(2);
		expect((await rowOf(t, "org-a/legacy"))?.orchestratorAgentId).toBeUndefined();
		expect((await rowOf(t, "org-a/ghost"))?.orchestratorAgentId).toBeUndefined();
		expect((await rowOf(t, "org-a/done"))?.orchestratorAgentId).toBe(eta);
	});
});
