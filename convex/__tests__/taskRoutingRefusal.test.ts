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
import { actingWith, seedOrgAgents } from "../../tests/lib/seedFleetAgents";
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
		const stamp = (slug: string) => ({ orgId: slug, clerkOrgId: testClerkOrgId(slug) });
		const rows: Array<Record<string, unknown>> = [];
		for (const slug of ["org-a", "org-b"]) {
			rows.push(
				{ repo: `${slug}/mine`, orchestrator: ORCH, reviewer: "rev", fallbackReviewer: "rev2", ...stamp(slug) },
				{ repo: `${slug}/theirs`, orchestrator: OWNER, reviewer: "rev", ...stamp(slug) },
				{ repo: `${slug}/unreviewed`, orchestrator: ORCH, ...stamp(slug) },
			);
		}
		for (const r of rows) {
			await ctx.db.insert("githubRepoMapping", { project: "p", active: true, ...r } as never);
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
}

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

	test("ADMIT: the routed reviewer as override, and no override (resolved from data)", async () => {
		const t = makeT();
		await seed(t);
		expect(await t.mutation(internal.tasks.createOrUpdateReviewTask, args("rev"))).toBeTruthy();
		expect(await t.mutation(internal.tasks.createOrUpdateReviewTask, { ...args(undefined), prNumber: 8 })).toBeTruthy();
		expect(await taskCount(t)).toBe(2);
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
