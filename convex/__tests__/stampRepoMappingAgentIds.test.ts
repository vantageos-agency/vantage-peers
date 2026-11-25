/// <reference types="vite/client" />
// stampRepoMappingAgentIds — mission k577f8ksjx5ec3gq9bggc1brqd8jwkbh, S2
// (task k1730d1b6wzwepjyyth266xq958jxfv0). The operator supplies the map; nothing
// is looked up by name. Poles: another org's agent refused; valid IDs stamped;
// dry run writes nothing; a stored ID kept (a different one refused); a role with
// no label refused; revert restores exactly; repos absent from the input listed.

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

const agentId = (t: T, slug: string, label: string) =>
	t.run(async (ctx) => {
		const a = await ctx.db
			.query("agents")
			.withIndex("by_org_normalized_name", (q) => q.eq("orgSlug", slug).eq("normalizedName", label))
			.first();
		if (a === null) throw new Error(`no agent ${slug}/${label}`);
		return a._id;
	});

async function seed(t: T) {
	await t.run(async (ctx) => {
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: ["eta", "rev"],
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: 1,
			});
		}
	});
	await seedOrgAgents(t, [
		["org-a", "eta"],
		["org-a", "rev"],
		["org-b", "eta"],
	]);
	await t.run(async (ctx) => {
		const base = { project: "p", active: true, orgId: "org-a", clerkOrgId: testClerkOrgId("org-a") };
		await ctx.db.insert("githubRepoMapping", { ...base, repo: "org-a/legacy", orchestrator: "eta", reviewer: "rev" });
		await ctx.db.insert("githubRepoMapping", { ...base, repo: "org-a/noreviewer", orchestrator: "eta" });
		await ctx.db.insert("githubRepoMapping", { ...base, repo: "org-a/forgotten", orchestrator: "eta" });
	});
}

const rowOf = (t: T, repo: string) =>
	t.run(async (ctx) =>
		ctx.db.query("githubRepoMapping").withIndex("by_repo", (q) => q.eq("repo", repo)).unique(),
	);

describe("migrations/stampRepoMappingAgentIds", () => {
	test("DRY RUN: reports what it would stamp, writes nothing", async () => {
		const t = makeT();
		await seed(t);
		const rows = [
			{
				repo: "org-a/legacy",
				orchestratorAgentId: await agentId(t, "org-a", "eta"),
				reviewerAgentId: await agentId(t, "org-a", "rev"),
			},
		];
		const r = await t.mutation(internal.migrations.stampRepoMappingAgentIds.run, { rows });
		expect(r.mode).toBe("dry-run");
		expect(r.stamped).toHaveLength(1);
		expect(r.stamped[0]?.fields).toEqual(["orchestratorAgentId", "reviewerAgentId"]);
		expect((await rowOf(t, "org-a/legacy"))?.orchestratorAgentId).toBeUndefined();
	});

	test("APPLY stamps valid IDs, lists repos absent from the input, and REVERT restores exactly", async () => {
		const t = makeT();
		await seed(t);
		const eta = await agentId(t, "org-a", "eta");
		const rev = await agentId(t, "org-a", "rev");
		const rows = [{ repo: "org-a/legacy", orchestratorAgentId: eta, reviewerAgentId: rev }];
		const r = await t.mutation(internal.migrations.stampRepoMappingAgentIds.run, { apply: true, rows });
		expect(r.mode).toBe("applied");
		const legacy = await rowOf(t, "org-a/legacy");
		expect(legacy?.orchestratorAgentId).toBe(eta);
		expect(legacy?.reviewerAgentId).toBe(rev);
		expect(r.absentFromInput.sort()).toEqual(["org-a/forgotten", "org-a/noreviewer"]);

		const again = await t.mutation(internal.migrations.stampRepoMappingAgentIds.run, { apply: true, rows });
		expect(again.stamped).toEqual([]);
		expect(again.refused).toEqual([]);

		const back = await t.mutation(internal.migrations.stampRepoMappingAgentIds.revert, { stamped: r.stamped });
		expect(back.reverted).toBe(1);
		const restored = await rowOf(t, "org-a/legacy");
		expect(restored?.orchestratorAgentId).toBeUndefined();
		expect(restored?.reviewerAgentId).toBeUndefined();
	});

	test("REFUSED: another org's agent is not stamped", async () => {
		const t = makeT();
		await seed(t);
		const foreign = await agentId(t, "org-b", "eta");
		const r = await t.mutation(internal.migrations.stampRepoMappingAgentIds.run, {
			apply: true,
			rows: [{ repo: "org-a/legacy", orchestratorAgentId: foreign }],
		});
		expect(r.refused).toEqual([
			{ repo: "org-a/legacy", role: "orchestratorAgentId", agentId: foreign, reason: "agent-not-in-org" },
		]);
		expect(r.stamped).toEqual([]);
		expect((await rowOf(t, "org-a/legacy"))?.orchestratorAgentId).toBeUndefined();
	});

	test("REFUSED: a reviewer ID for a row with no reviewer label; a DIFFERENT stored ID is kept", async () => {
		const t = makeT();
		await seed(t);
		const eta = await agentId(t, "org-a", "eta");
		const rev = await agentId(t, "org-a", "rev");
		const noLabel = await t.mutation(internal.migrations.stampRepoMappingAgentIds.run, {
			rows: [{ repo: "org-a/noreviewer", orchestratorAgentId: eta, reviewerAgentId: rev }],
		});
		expect(noLabel.refused.map((x) => x.reason)).toEqual(["no-label-for-role"]);
		await t.mutation(internal.migrations.stampRepoMappingAgentIds.run, {
			apply: true,
			rows: [{ repo: "org-a/forgotten", orchestratorAgentId: eta }],
		});
		const differs = await t.mutation(internal.migrations.stampRepoMappingAgentIds.run, {
			apply: true,
			rows: [{ repo: "org-a/forgotten", orchestratorAgentId: rev }],
		});
		expect(differs.refused.map((x) => x.reason)).toEqual(["stored-id-differs"]);
		expect((await rowOf(t, "org-a/forgotten"))?.orchestratorAgentId).toBe(eta);
	});

	test("an input repo with no row is listed, not guessed", async () => {
		const t = makeT();
		await seed(t);
		const r = await t.mutation(internal.migrations.stampRepoMappingAgentIds.run, {
			rows: [{ repo: "org-a/nope", orchestratorAgentId: await agentId(t, "org-a", "eta") }],
		});
		expect(r.unknownRepos).toEqual(["org-a/nope"]);
	});
});
