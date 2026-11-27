/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// clientOrgRows.test.ts — task k170nabwrnahjcey4zayn7an3h8jxjg5.
//
// A client's repos are routed in that client's org, never the operator's. Poles:
//   migration  moveRepoMappingToOrg: dry run writes nothing; apply re-keys ONE row to
//              the target org and stamps the IDs; an agent of another org, an unknown
//              target org, an inactive agent and a role with no label are refused and
//              change nothing; revert restores the exact prior org and fields
//   door       routedElsewhere (operator org only): lists the caller's repos that have a
//              row in ANOTHER org; a client org gets `applicable: false`; getRoute for
//              the operator org keeps answering absent (no leak)
// Every pole runs as a scoped member identity, never the master / service identity,
// except the migration (an internal, operator door).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedOrgAgents } from "../../tests/lib/seedFleetAgents";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

const member = (t: T, slug: string) =>
	t.withIdentity({
		subject: `user-${slug}`,
		organizationId: slug,
		org_id: testClerkOrgId(slug),
	} as Parameters<T["withIdentity"]>[0]);

// org-op: the OPERATOR org. org-c: a client org. org-x: another client org.
async function seed(t: T) {
	await t.run(async (ctx) => {
		for (const slug of ["org-op", "org-c", "org-x"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: ["eta", "atlas", "rev"],
				scopes: ["view-own-tasks", "manage-repo-mappings"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
				...(slug === "org-op" ? { orgKind: "operator" as const } : {}),
			});
		}
	});
	await seedOrgAgents(t, [
		["org-op", "eta"],
		["org-c", "atlas"],
		["org-c", "rev"],
		["org-x", "atlas"],
	]);
	await t.run(async (ctx) => {
		const stamp = (slug: string) => ({ orgId: slug, clerkOrgId: testClerkOrgId(slug), project: "p", active: true });
		// Rows the operator org holds for a client: the agents are the client's.
		await ctx.db.insert("githubRepoMapping", { ...stamp("org-op"), repo: "ops/client-ws", orchestrator: "atlas", reviewer: "rev" });
		await ctx.db.insert("githubRepoMapping", { ...stamp("org-op"), repo: "ops/own", orchestrator: "eta" });
		await ctx.db.insert("githubRepoMapping", { project: "p", active: true, repo: "ops/unstamped", orchestrator: "eta" });
		await ctx.db.insert("githubRepoMapping", { ...stamp("org-c"), repo: "client/own", orchestrator: "atlas" });
	});
}

const agentId = (t: T, slug: string, label: string) =>
	t.run(async (ctx) => {
		const a = await ctx.db
			.query("agents")
			.withIndex("by_org_normalized_name", (q) => q.eq("orgSlug", slug).eq("normalizedName", label))
			.first();
		if (a === null) throw new Error(`no agent ${slug}/${label}`);
		return a._id;
	});

const rowOf = (t: T, repo: string) =>
	t.run(async (ctx) =>
		ctx.db.query("githubRepoMapping").withIndex("by_repo", (q) => q.eq("repo", repo)).unique(),
	);

const rowCount = (t: T) => t.run(async (ctx) => (await ctx.db.query("githubRepoMapping").collect()).length);

const refusal = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (e) {
		return String((e as { data?: unknown }).data ?? (e as Error).message);
	}
	throw new Error("expected a refusal, the call succeeded");
};

const toC = testClerkOrgId("org-c");

describe("migrations/moveRepoMappingToOrg", () => {
	test("DRY RUN: reports the move, writes nothing", async () => {
		const t = makeT();
		await seed(t);
		const rows = [
			{
				repo: "ops/client-ws",
				toClerkOrgId: toC,
				orchestratorAgentId: await agentId(t, "org-c", "atlas"),
				reviewerAgentId: await agentId(t, "org-c", "rev"),
			},
		];
		const r = await t.mutation(internal.migrations.moveRepoMappingToOrg.run, { rows });
		expect(r.mode).toBe("dry-run");
		expect(r.moved).toHaveLength(1);
		const row = await rowOf(t, "ops/client-ws");
		expect(row?.orgId).toBe("org-op");
		expect(row?.orchestratorAgentId).toBeUndefined();
	});

	test("APPLY re-keys the one row to the target org with the IDs; the client org reads it, the operator org does not", async () => {
		const t = makeT();
		await seed(t);
		const atlas = await agentId(t, "org-c", "atlas");
		const rev = await agentId(t, "org-c", "rev");
		const before = await rowCount(t);
		const r = await t.mutation(internal.migrations.moveRepoMappingToOrg.run, {
			apply: true,
			rows: [{ repo: "ops/client-ws", toClerkOrgId: toC, orchestratorAgentId: atlas, reviewerAgentId: rev }],
		});
		expect(r.moved).toHaveLength(1);
		expect(await rowCount(t)).toBe(before);
		const row = await rowOf(t, "ops/client-ws");
		expect(row?.orgId).toBe("org-c");
		expect(row?.clerkOrgId).toBe(toC);
		expect(row?.orchestratorAgentId).toBe(atlas);
		expect(row?.reviewerAgentId).toBe(rev);
		expect(await member(t, "org-c").query(api.githubRepoMapping.getRoute, { repo: "ops/client-ws" })).toMatchObject({
			state: "routed",
			owner: "atlas",
			reviewer: "rev",
		});
		expect(await member(t, "org-op").query(api.githubRepoMapping.getRoute, { repo: "ops/client-ws" })).toEqual({
			state: "absent",
		});
		const again = await t.mutation(internal.migrations.moveRepoMappingToOrg.run, {
			apply: true,
			rows: [{ repo: "ops/client-ws", toClerkOrgId: toC, orchestratorAgentId: atlas, reviewerAgentId: rev }],
		});
		expect(again.moved).toEqual([]);
		expect(again.unchanged).toEqual(["ops/client-ws"]);
	});

	test("REFUSED: an agent of another org (or the operator's own) is not accepted, nothing changes", async () => {
		const t = makeT();
		await seed(t);
		for (const wrong of [await agentId(t, "org-x", "atlas"), await agentId(t, "org-op", "eta")]) {
			const r = await t.mutation(internal.migrations.moveRepoMappingToOrg.run, {
				apply: true,
				rows: [{ repo: "ops/client-ws", toClerkOrgId: toC, orchestratorAgentId: wrong }],
			});
			expect(r.refused.map((x) => x.reason)).toEqual(["agent-not-in-org"]);
			expect(r.moved).toEqual([]);
		}
		expect((await rowOf(t, "ops/client-ws"))?.orgId).toBe("org-op");
	});

	test("REFUSED: an unknown target org, an inactive agent, a reviewer ID for a row with no reviewer label", async () => {
		const t = makeT();
		await seed(t);
		const atlas = await agentId(t, "org-c", "atlas");
		const noOrg = await t.mutation(internal.migrations.moveRepoMappingToOrg.run, {
			apply: true,
			rows: [{ repo: "ops/client-ws", toClerkOrgId: "org_does_not_exist", orchestratorAgentId: atlas }],
		});
		expect(noOrg.refused.map((x) => x.reason)).toEqual(["target-org-not-found"]);

		await t.run(async (ctx) => ctx.db.patch(atlas, { isActive: false }));
		const inactive = await t.mutation(internal.migrations.moveRepoMappingToOrg.run, {
			apply: true,
			rows: [{ repo: "ops/client-ws", toClerkOrgId: toC, orchestratorAgentId: atlas }],
		});
		expect(inactive.refused.map((x) => x.reason)).toEqual(["agent-not-in-org"]);
		await t.run(async (ctx) => ctx.db.patch(atlas, { isActive: true }));

		const noLabel = await t.mutation(internal.migrations.moveRepoMappingToOrg.run, {
			apply: true,
			rows: [
				{
					repo: "ops/own",
					toClerkOrgId: toC,
					orchestratorAgentId: atlas,
					reviewerAgentId: await agentId(t, "org-c", "rev"),
				},
			],
		});
		expect(noLabel.refused.map((x) => x.reason)).toEqual(["no-label-for-role"]);
		expect((await rowOf(t, "ops/client-ws"))?.orgId).toBe("org-op");
		expect((await rowOf(t, "ops/own"))?.orgId).toBe("org-op");
	});

	test("an input repo with no row is listed, not created", async () => {
		const t = makeT();
		await seed(t);
		const before = await rowCount(t);
		const r = await t.mutation(internal.migrations.moveRepoMappingToOrg.run, {
			apply: true,
			rows: [{ repo: "ops/nope", toClerkOrgId: toC, orchestratorAgentId: await agentId(t, "org-c", "atlas") }],
		});
		expect(r.unknownRepos).toEqual(["ops/nope"]);
		expect(await rowCount(t)).toBe(before);
	});

	test("REVERT restores the exact prior org and fields", async () => {
		const t = makeT();
		await seed(t);
		const prior = await rowOf(t, "ops/client-ws");
		const r = await t.mutation(internal.migrations.moveRepoMappingToOrg.run, {
			apply: true,
			rows: [
				{
					repo: "ops/client-ws",
					toClerkOrgId: toC,
					orchestratorAgentId: await agentId(t, "org-c", "atlas"),
					reviewerAgentId: await agentId(t, "org-c", "rev"),
				},
			],
		});
		const back = await t.mutation(internal.migrations.moveRepoMappingToOrg.revert, { moved: r.moved });
		expect(back.reverted).toBe(1);
		const restored = await rowOf(t, "ops/client-ws");
		expect(restored?.orgId).toBe(prior?.orgId);
		expect(restored?.clerkOrgId).toBe(prior?.clerkOrgId);
		expect(restored?.orchestratorAgentId).toBeUndefined();
		expect(restored?.reviewerAgentId).toBeUndefined();
		expect(restored?.orchestrator).toBe("atlas");
	});
});

describe("migrations/moveRepoMappingToOrg — review blockers (M1, M2)", () => {
	test("M2: an ID the input omits for a role is CLEARED on the moved row, and revert restores it byte for byte", async () => {
		const t = makeT();
		await seed(t);
		const opEta = await agentId(t, "org-op", "eta");
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("githubRepoMapping")
				.withIndex("by_repo", (q) => q.eq("repo", "ops/client-ws"))
				.unique();
			if (row === null) throw new Error("seed row missing");
			await ctx.db.patch(row._id, { reviewerAgentId: opEta, fallbackReviewerAgentId: opEta });
		});
		const prior = await rowOf(t, "ops/client-ws");
		expect(prior?.reviewerAgentId).toBe(opEta);
		const r = await t.mutation(internal.migrations.moveRepoMappingToOrg.run, {
			apply: true,
			rows: [
				{
					repo: "ops/client-ws",
					toClerkOrgId: toC,
					orchestratorAgentId: await agentId(t, "org-c", "atlas"),
				},
			],
		});
		expect(r.moved).toHaveLength(1);
		const moved = await rowOf(t, "ops/client-ws");
		expect(moved?.orgId).toBe("org-c");
		expect(moved?.reviewerAgentId).toBeUndefined();
		expect(moved?.fallbackReviewerAgentId).toBeUndefined();
		expect("reviewerAgentId" in (moved ?? {})).toBe(false);
		const back = await t.mutation(internal.migrations.moveRepoMappingToOrg.revert, { moved: r.moved });
		expect(back.reverted).toBe(1);
		expect(await rowOf(t, "ops/client-ws")).toEqual(prior);
	});

	test("M1: one apply naming the same repo twice refuses BOTH entries (duplicate-repo) and writes nothing", async () => {
		const t = makeT();
		await seed(t);
		const prior = await rowOf(t, "ops/client-ws");
		const r = await t.mutation(internal.migrations.moveRepoMappingToOrg.run, {
			apply: true,
			rows: [
				{
					repo: "ops/client-ws",
					toClerkOrgId: toC,
					orchestratorAgentId: await agentId(t, "org-c", "atlas"),
				},
				{
					repo: "ops/client-ws",
					toClerkOrgId: testClerkOrgId("org-x"),
					orchestratorAgentId: await agentId(t, "org-x", "atlas"),
				},
			],
		});
		expect(r.refused.map((x) => [x.repo, x.reason])).toEqual([
			["ops/client-ws", "duplicate-repo"],
			["ops/client-ws", "duplicate-repo"],
		]);
		expect(r.moved).toEqual([]);
		expect(await rowOf(t, "ops/client-ws")).toEqual(prior);
	});

	test("M1: revert of a hand-built two-step moved list lands on the FIRST prior", async () => {
		const t = makeT();
		await seed(t);
		const first = await rowOf(t, "ops/client-ws");
		if (first === null) throw new Error("seed row missing");
		const pick = (r: typeof first) => ({
			orgId: r.orgId,
			clerkOrgId: r.clerkOrgId,
			orchestratorAgentId: r.orchestratorAgentId,
			reviewerAgentId: r.reviewerAgentId,
			fallbackReviewerAgentId: r.fallbackReviewerAgentId,
		});
		const priorA = pick(first);
		const priorB = { ...priorA, orgId: "org-c", clerkOrgId: toC };
		await t.run(async (ctx) =>
			ctx.db.patch(first._id, { orgId: "org-x", clerkOrgId: testClerkOrgId("org-x") }),
		);
		await t.mutation(internal.migrations.moveRepoMappingToOrg.revert, {
			moved: [
				{ id: first._id, prior: priorA },
				{ id: first._id, prior: priorB },
			],
		});
		const after = await rowOf(t, "ops/client-ws");
		expect(after?.orgId).toBe("org-op");
		expect(after?.clerkOrgId).toBe(first.clerkOrgId);
	});
});

describe("githubRepoMapping:routedElsewhere", () => {
	test("ADMIT: the operator org learns which of its listed repos have a row in ANOTHER org", async () => {
		const t = makeT();
		await seed(t);
		const r = await member(t, "org-op").query(api.githubRepoMapping.routedElsewhere, {
			repos: ["client/own", "ops/own", "ops/unstamped", "nobody/nothing"],
		});
		expect(r).toEqual({ applicable: true, elsewhere: ["client/own"] });
	});

	test("a client org is told the question does not apply to it, never an empty absence", async () => {
		const t = makeT();
		await seed(t);
		const r = await member(t, "org-c").query(api.githubRepoMapping.routedElsewhere, {
			repos: ["ops/own", "ops/client-ws"],
		});
		expect(r).toEqual({ applicable: false, elsewhere: [] });
	});

	test("DENY: no credential is refused", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(t.query(api.githubRepoMapping.routedElsewhere, { repos: ["client/own"] }));
		expect(msg).toContain("RBAC_DENIED");
	});

	test("getRoute for the operator org keeps answering absent for another org's row (no leak)", async () => {
		const t = makeT();
		await seed(t);
		expect(await member(t, "org-op").query(api.githubRepoMapping.getRoute, { repo: "client/own" })).toEqual({
			state: "absent",
		});
	});
});
