/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// taskRoutingRefusal.test.ts — mission k577f8ksjx5ec3gq9bggc1brqd8jwkbh, S2
// (task k1730d1b6wzwepjyyth266xq958jxfv0).
//
// An org that ADOPTED explicit routing is refused a task whose `repo` is routed to
// another owner, a `repo` its table does not declare, and a review task naming a
// reviewer other than the routed one. A NON-adopted org keeps today's behaviour.
// Every pole runs as a scoped SEAT identity (org claim + agent credential), never
// the master / service identity, except the internal review-task door (no caller).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { actingWith, seedFleetAgents, seedOrgAgents } from "../../tests/lib/seedFleetAgents";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

const ORCH = "eta"; // the caller, and the owner of the repos routed to it
const OWNER = "owner-x"; // the owner a repo can be routed to instead
const secrets = new Map<string, string>();

const asOrg = (t: T, slug: string) => {
	const member = t.withIdentity({
		subject: `user-${slug}`,
		organizationId: slug,
		org_id: testClerkOrgId(slug),
	} as Parameters<T["withIdentity"]>[0]);
	const secret = secrets.get(`${slug}/${ORCH}`);
	return secret === undefined ? member : actingWith(member, secret);
};

// org-a: ADOPTED. org-b: NOT adopted. Same table shape in both.
async function seed(t: T) {
	await t.run(async (ctx) => {
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [ORCH, OWNER, "rev", "rev2", "stranger"],
				scopes: ["view-own-tasks", "manage-repo-mappings"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
		await ctx.db.insert("taskClosureConfig", {
			key: "reviewRoutingAdoptedOrgs",
			value: [`id:${testClerkOrgId("org-a")}`],
			updatedAt: 0,
		});
		for (const [i, slug] of ["org-a", "org-b"].entries()) {
			await ctx.db.insert("githubOwnerBindings", {
				owner: slug,
				orgId: slug,
				installationId: i + 1,
				accountType: "Organization",
				githubUserLogin: `gh-${slug}`,
				boundBy: `admin-${slug}`,
				boundAt: 1,
				active: true,
			});
		}
	});
	secrets.clear();
	for (const [k, val] of await seedOrgAgents(t, [
		["org-a", ORCH],
		["org-a", OWNER],
		["org-a", "rev"],
		["org-a", "rev2"],
		["org-a", "stranger"],
		["org-b", ORCH],
		["org-b", OWNER],
		["org-b", "rev"],
		["org-b", "rev2"],
		["org-b", "stranger"],
	])) {
		secrets.set(k, val);
	}
	await t.run(async (ctx) => {
		const stamp = (slug: string) => ({ orgId: slug, clerkOrgId: testClerkOrgId(slug) });
		for (const slug of ["org-a", "org-b"]) {
			const id = async (label: string) => {
				const agent = await ctx.db
					.query("agents")
					.withIndex("by_org_normalized_name", (q) => q.eq("orgSlug", slug).eq("normalizedName", label))
					.first();
				if (agent === null) throw new Error(`no agent ${slug}/${label}`);
				return agent._id;
			};
			const rows: Array<Record<string, unknown>> = [
				{
					repo: `${slug}/mine`,
					orchestrator: ORCH,
					reviewer: "rev",
					fallbackReviewer: "rev2",
					orchestratorAgentId: await id(ORCH),
					reviewerAgentId: await id("rev"),
					fallbackReviewerAgentId: await id("rev2"),
				},
				{
					repo: `${slug}/theirs`,
					orchestrator: OWNER,
					reviewer: "rev",
					orchestratorAgentId: await id(OWNER),
					reviewerAgentId: await id("rev"),
				},
				{ repo: `${slug}/unreviewed`, orchestrator: ORCH, orchestratorAgentId: await id(ORCH) },
				// The LABEL says ORCH, the stored ID is OWNER's: the ID decides.
				{
					repo: `${slug}/relabelled`,
					orchestrator: ORCH,
					reviewer: "rev",
					orchestratorAgentId: await id(OWNER),
					reviewerAgentId: await id("rev"),
				},
				// A row written before agent IDs were stored: labels only.
				{ repo: `${slug}/legacy`, orchestrator: ORCH, reviewer: "rev" },
			];
			for (const r of rows) {
				await ctx.db.insert("githubRepoMapping", { project: "p", active: true, ...stamp(slug), ...r } as never);
			}
		}
	});
}

const agentIdOf = (t: T, slug: string, label: string) =>
	t.run(async (ctx) => {
		const agent = await ctx.db
			.query("agents")
			.withIndex("by_org_normalized_name", (q) => q.eq("orgSlug", slug).eq("normalizedName", label))
			.first();
		if (agent === null) throw new Error(`no agent ${slug}/${label}`);
		return agent._id;
	});

const member = (t: T, slug: string) =>
	t.withIdentity({
		subject: `user-${slug}`,
		organizationId: slug,
		org_id: testClerkOrgId(slug),
	} as Parameters<T["withIdentity"]>[0]);

const create = (
	t: T,
	slug: string,
	over: { title?: string; assignedTo: string; repo?: string; tags?: string[] },
) =>
	asOrg(t, slug).mutation(api.tasks.create, {
		title: over.title ?? "work",
		project: "p",
		priority: "medium",
		status: "todo",
		createdBy: ORCH,
		assignedTo: over.assignedTo,
		...(over.tags !== undefined ? { tags: over.tags } : {}),
		...(over.repo !== undefined ? { repo: over.repo } : {}),
	} as never);

const refusal = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (e) {
		return String((e as { data?: unknown }).data ?? (e as Error).message);
	}
	throw new Error("expected a refusal, the call succeeded");
};

const taskCount = (t: T) => t.run(async (ctx) => (await ctx.db.query("tasks").collect()).length);

describe("ADOPTED org: tasks:create against a routed repo", () => {
	test("ADMIT: a repo whose route names the assignee as owner is created", async () => {
		const t = makeT();
		await seed(t);
		const id = await create(t, "org-a", { assignedTo: ORCH, repo: "org-a/mine" });
		expect(id).toBeTruthy();
		expect(await taskCount(t)).toBe(1);
	});

	test("DENY: a repo routed to another owner is refused naming that owner", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(create(t, "org-a", { assignedTo: ORCH, repo: "org-a/theirs" }));
		expect(msg).toContain("RBAC_DENIED");
		expect(msg).toContain("repo-routed-to-other-owner");
		expect(msg).toMatch(new RegExp(`owner \\\\*"${OWNER}`));
		expect(await taskCount(t)).toBe(0);
	});

	test("DENY: a repo absent from the org's table is refused, 'declare it first'", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(create(t, "org-a", { assignedTo: ORCH, repo: "org-a/never-declared" }));
		expect(msg).toContain("RBAC_DENIED");
		expect(msg).toContain("repo-not-declared");
		expect(msg).toContain("declare it first");
		expect(msg).toContain("add_repo_mapping");
		expect(await taskCount(t)).toBe(0);
	});

	test("DENY: another org's row is answered as absent, with none of its content", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(create(t, "org-a", { assignedTo: ORCH, repo: "org-b/mine" }));
		expect(msg).toContain("repo-not-declared");
		expect(msg).not.toContain("rev2");
	});

	test("ADMIT: no repo named -> unchanged", async () => {
		const t = makeT();
		await seed(t);
		expect(await create(t, "org-a", { assignedTo: "stranger" })).toBeTruthy();
	});
});

describe("ADOPTED org: a [REVIEW] task and its reviewer", () => {
	test("ADMIT: a review task assigned to the routed reviewer is created", async () => {
		const t = makeT();
		await seed(t);
		expect(
			await create(t, "org-a", { title: "[REVIEW] a PR", assignedTo: "rev", repo: "org-a/mine" }),
		).toBeTruthy();
	});

	test("ADMIT: the row's own fallback reviewer is also the routed reviewer", async () => {
		const t = makeT();
		await seed(t);
		expect(
			await create(t, "org-a", { title: "[REVIEW] a PR", assignedTo: "rev2", repo: "org-a/mine" }),
		).toBeTruthy();
	});

	test("DENY: a review task naming any other reviewer is refused naming the routed reviewer", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(
			create(t, "org-a", { title: "[REVIEW] a PR", assignedTo: "stranger", repo: "org-a/mine" }),
		);
		expect(msg).toContain("RBAC_DENIED");
		expect(msg).toContain("reviewer-not-routed");
		expect(msg).toMatch(/reviewer \\*"rev\\*"/);
		expect(await taskCount(t)).toBe(0);
	});

	test("DENY: a review task tagged `review` is judged the same way", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(
			create(t, "org-a", { assignedTo: "stranger", repo: "org-a/mine", tags: ["review"] }),
		);
		expect(msg).toContain("reviewer-not-routed");
	});

	test("DENY: a review task on a repo whose row names no reviewer is refused", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(
			create(t, "org-a", { title: "[REVIEW] a PR", assignedTo: "rev", repo: "org-a/unreviewed" }),
		);
		expect(msg).toContain("repo-has-no-reviewer");
	});

	test("DENY: the repo is read from the [Review] title when `repo` is not passed", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(
			create(t, "org-a", {
				title: "[Review] org-a/mine PR #4: x",
				assignedTo: "stranger",
			}),
		);
		expect(msg).toContain("reviewer-not-routed");
	});
});

describe("ADOPTED org: createOrUpdateReviewTask's assignedTo override", () => {
	const args = (assignedTo: string | undefined, repoFullName = "org-a/mine") => ({
		repoFullName,
		prNumber: 7,
		prTitle: "t",
		priority: "medium" as const,
		createdBy: "system",
		...(assignedTo !== undefined ? { assignedTo } : {}),
	});

	test("DENY: an override other than the routed reviewer is refused, nothing inserted", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(t.mutation(internal.tasks.createOrUpdateReviewTask, args("stranger")));
		expect(msg).toContain("reviewer-not-routed");
		expect(await taskCount(t)).toBe(0);
	});

	test("DENY: the same through the delivery mirror", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(
			t.mutation(internal.tasks.createOrUpdateReviewTaskDelivery, {
				...args("stranger"),
				delivery: { deliveryId: "d1", step: "review", repo: "org-a/mine", eventType: "pull_request" },
			} as never),
		);
		expect(msg).toContain("reviewer-not-routed");
		expect(await taskCount(t)).toBe(0);
	});

	test("DENY: even the routed reviewer's label as override is refused for a client org (the row is stored on the fleet, not under the org's agents)", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(t.mutation(internal.tasks.createOrUpdateReviewTask, args("rev")));
		expect(msg).toContain("reviewer-not-routed");
		expect(await taskCount(t)).toBe(0);
	});

	test("ADMIT: no override (the reviewer is resolved from data)", async () => {
		const t = makeT();
		await seed(t);
		expect(await t.mutation(internal.tasks.createOrUpdateReviewTask, args(undefined))).toBeTruthy();
		expect(await taskCount(t)).toBe(1);
	});

	test("ADMIT / DENY on an adopted OPERATOR org: the stored assignee ID is the routed reviewer's", async () => {
		const t = makeT();
		const ids = await seedFleetAgents(t, ["eta", "rev", "stranger"]);
		await t.run(async (ctx) => {
			await ctx.db.insert("githubRepoMapping", {
				repo: "fleet/one",
				orchestrator: "eta",
				project: "p",
				active: true,
				reviewer: "rev",
				orchestratorAgentId: ids.eta,
				reviewerAgentId: ids.rev,
			});
		});
		await t.mutation(internal.clientOrgMapping.setReviewRoutingAdopted, {
			clerkOrgSlug: "fleet-operator",
			adopted: true,
		});
		const msg = await refusal(
			t.mutation(internal.tasks.createOrUpdateReviewTask, args("stranger", "fleet/one")),
		);
		expect(msg).toContain("reviewer-not-routed");
		expect(await t.mutation(internal.tasks.createOrUpdateReviewTask, args("rev", "fleet/one"))).toBeTruthy();
		expect(await taskCount(t)).toBe(1);
	});
});

describe("NOT ADOPTED org: today's behaviour, exactly", () => {
	test("a repo routed to another owner is created", async () => {
		const t = makeT();
		await seed(t);
		expect(await create(t, "org-b", { assignedTo: ORCH, repo: "org-b/theirs" })).toBeTruthy();
	});

	test("a repo absent from the table is created", async () => {
		const t = makeT();
		await seed(t);
		expect(await create(t, "org-b", { assignedTo: ORCH, repo: "org-b/never-declared" })).toBeTruthy();
	});

	test("a review task naming any reviewer is created", async () => {
		const t = makeT();
		await seed(t);
		expect(
			await create(t, "org-b", { title: "[REVIEW] a PR", assignedTo: "stranger", repo: "org-b/mine" }),
		).toBeTruthy();
	});

	test("createOrUpdateReviewTask keeps its override", async () => {
		const t = makeT();
		await seed(t);
		expect(
			await t.mutation(internal.tasks.createOrUpdateReviewTask, {
				repoFullName: "org-b/mine",
				prNumber: 7,
				prTitle: "t",
				priority: "medium",
				createdBy: "system",
				assignedTo: "stranger",
			}),
		).toBeTruthy();
	});
});

describe("ADOPTED org: the stored agent ID decides, not the label", () => {
	test("DENY: the label matches the assignee but the stored ID is another agent's", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(create(t, "org-a", { assignedTo: ORCH, repo: "org-a/relabelled" }));
		expect(msg).toContain("repo-routed-to-other-owner");
		expect(await taskCount(t)).toBe(0);
	});

	test("ADMIT: the stored ID matches the assignee although the label names someone else", async () => {
		const t = makeT();
		await seed(t);
		expect(await create(t, "org-a", { assignedTo: OWNER, repo: "org-a/relabelled" })).toBeTruthy();
	});

	test("DENY: a row with no stored IDs is refused, whoever is assigned", async () => {
		const t = makeT();
		await seed(t);
		for (const assignedTo of [ORCH, OWNER]) {
			const msg = await refusal(create(t, "org-a", { assignedTo, repo: "org-a/legacy" }));
			expect(msg).toContain("route-has-no-agent-ids");
		}
		const review = await refusal(
			create(t, "org-a", { title: "[REVIEW] x", assignedTo: "rev", repo: "org-a/legacy" }),
		);
		expect(review).toContain("route-has-no-agent-ids");
		expect(await taskCount(t)).toBe(0);
	});

	test("NOT ADOPTED: a row with no IDs, or the wrong ID, changes nothing", async () => {
		const t = makeT();
		await seed(t);
		expect(await create(t, "org-b", { assignedTo: ORCH, repo: "org-b/legacy" })).toBeTruthy();
		expect(await create(t, "org-b", { assignedTo: ORCH, repo: "org-b/relabelled" })).toBeTruthy();
	});
});

describe("githubRepoMapping:add stores the agent IDs", () => {
	const base = { repo: "org-a/fresh", project: "p" };

	test("ADMIT: the IDs of the org's own agents are stored and served by getRoute", async () => {
		const t = makeT();
		await seed(t);
		const orchestratorAgentId = await agentIdOf(t, "org-a", ORCH);
		const reviewerAgentId = await agentIdOf(t, "org-a", "rev");
		await member(t, "org-a").mutation(api.githubRepoMapping.add, {
			...base,
			orchestrator: ORCH,
			reviewer: "rev",
			orchestratorAgentId,
			reviewerAgentId,
		});
		expect(await member(t, "org-a").query(api.githubRepoMapping.getRoute, { repo: "org-a/fresh" })).toEqual({
			state: "routed",
			owner: ORCH,
			reviewer: "rev",
			ownerAgentId: orchestratorAgentId,
			reviewerAgentId,
		});
		expect(await create(t, "org-a", { assignedTo: ORCH, repo: "org-a/fresh" })).toBeTruthy();
	});

	test("DENY: another org's agent ID is refused, nothing written", async () => {
		const t = makeT();
		await seed(t);
		const foreign = await agentIdOf(t, "org-b", ORCH);
		const msg = await refusal(
			member(t, "org-a").mutation(api.githubRepoMapping.add, {
				...base,
				orchestrator: ORCH,
				reviewer: "rev",
				orchestratorAgentId: foreign,
			}),
		);
		expect(msg).toContain("route-agent-not-in-org");
		const row = await t.run(async (ctx) =>
			ctx.db.query("githubRepoMapping").withIndex("by_repo", (q) => q.eq("repo", "org-a/fresh")).unique(),
		);
		expect(row).toBeNull();
	});

	test("DENY: a reviewer ID without its reviewer label is refused", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(
			member(t, "org-b").mutation(api.githubRepoMapping.add, {
				repo: "org-b/fresh",
				project: "p",
				orchestrator: ORCH,
				reviewerAgentId: await agentIdOf(t, "org-b", "rev"),
			}),
		);
		expect(msg).toContain("INVALID_ROUTE");
	});

	test("an update restates the IDs: re-saving with labels only clears them, so the route is refused until they are given again", async () => {
		const t = makeT();
		await seed(t);
		const orchestratorAgentId = await agentIdOf(t, "org-a", ORCH);
		await member(t, "org-a").mutation(api.githubRepoMapping.add, {
			repo: "org-a/mine",
			project: "p",
			orchestrator: ORCH,
			reviewer: "rev",
			orchestratorAgentId,
		});
		expect(await create(t, "org-a", { assignedTo: ORCH, repo: "org-a/mine" })).toBeTruthy();
		await member(t, "org-a").mutation(api.githubRepoMapping.add, {
			repo: "org-a/mine",
			project: "p",
			orchestrator: ORCH,
			reviewer: "rev",
		});
		const msg = await refusal(create(t, "org-a", { assignedTo: ORCH, repo: "org-a/mine" }));
		expect(msg).toContain("route-has-no-agent-ids");
	});
});
