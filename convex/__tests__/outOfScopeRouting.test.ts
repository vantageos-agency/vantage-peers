/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// outOfScopeRouting.test.ts — task k179tb3srh93pkqk0hwanxkqax8jw8xf.
//
// A repo no station owns is recorded on its mapping row: `outOfScope: { reason }`.
// A row is either routed OR out of scope. Poles:
//   add          out-of-scope with no orchestrator accepted; out-of-scope beside an
//                orchestrator / agent IDs / reviewer refused (INVALID_ROUTE); a reason
//                under 10 characters (trimmed) refused; routed <-> out-of-scope
//                conversion leaves no half-state
//   getRoute     { state: "out-of-scope", reason } for the caller's own org only
//   tasks:create an ADOPTED org's task naming an out-of-scope repo is refused
//                (`repo-out-of-scope`); a NON-adopted org is unchanged
// Every pole runs as a scoped SEAT / member identity, never the master identity.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { actingWith, seedOrgAgents } from "../../tests/lib/seedFleetAgents";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

const ORCH = "eta";
const REASON = "no owning station, no activity in 30 days";
const secrets = new Map<string, string>();

const member = (t: T, slug: string) =>
	t.withIdentity({
		subject: `user-${slug}`,
		organizationId: slug,
		org_id: testClerkOrgId(slug),
	} as Parameters<T["withIdentity"]>[0]);

const seat = (t: T, slug: string) => {
	const secret = secrets.get(`${slug}/${ORCH}`);
	return secret === undefined ? member(t, slug) : actingWith(member(t, slug), secret);
};

// org-a ADOPTED, org-b NOT. Both own a routed repo and an out-of-scope repo.
async function seed(t: T) {
	await t.run(async (ctx) => {
		for (const [i, slug] of ["org-a", "org-b"].entries()) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [ORCH, "rev"],
				scopes: ["view-own-tasks", "manage-repo-mappings"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
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
		await ctx.db.insert("taskClosureConfig", {
			key: "reviewRoutingAdoptedOrgs",
			value: [`id:${testClerkOrgId("org-a")}`],
			updatedAt: 0,
		});
	});
	secrets.clear();
	for (const [k, val] of await seedOrgAgents(t, [
		["org-a", ORCH],
		["org-a", "rev"],
		["org-b", ORCH],
		["org-b", "rev"],
	])) {
		secrets.set(k, val);
	}
	await t.run(async (ctx) => {
		for (const slug of ["org-a", "org-b"]) {
			const agent = await ctx.db
				.query("agents")
				.withIndex("by_org_normalized_name", (q) => q.eq("orgSlug", slug).eq("normalizedName", ORCH))
				.first();
			const stamp = { orgId: slug, clerkOrgId: testClerkOrgId(slug), project: "p", active: true };
			await ctx.db.insert("githubRepoMapping", {
				...stamp,
				repo: `${slug}/mine`,
				orchestrator: ORCH,
				orchestratorAgentId: agent?._id,
			});
			await ctx.db.insert("githubRepoMapping", {
				...stamp,
				repo: `${slug}/fork`,
				outOfScope: { reason: REASON },
			});
		}
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

const refusal = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (e) {
		return String((e as { data?: unknown }).data ?? (e as Error).message);
	}
	throw new Error("expected a refusal, the call succeeded");
};

const create = (t: T, slug: string, over: { title?: string; assignedTo: string; repo?: string }) =>
	seat(t, slug).mutation(api.tasks.create, {
		title: over.title ?? "work",
		project: "p",
		priority: "medium",
		status: "todo",
		createdBy: ORCH,
		assignedTo: over.assignedTo,
		...(over.repo !== undefined ? { repo: over.repo } : {}),
	} as never);

describe("githubRepoMapping:add records an out-of-scope repo", () => {
	test("ADMIT: outOfScope with no orchestrator is stored, the reason trimmed", async () => {
		const t = makeT();
		await seed(t);
		await member(t, "org-a").mutation(api.githubRepoMapping.add, {
			repo: "org-a/old",
			project: "p",
			outOfScope: { reason: `  ${REASON}  ` },
		} as never);
		const row = await rowOf(t, "org-a/old");
		expect(row?.outOfScope).toEqual({ reason: REASON });
		expect(row?.orchestrator).toBeUndefined();
	});

	test("ADMIT in an ADOPTED org: no reviewer is required for an out-of-scope row", async () => {
		const t = makeT();
		await seed(t);
		await expect(
			member(t, "org-a").mutation(api.githubRepoMapping.add, {
				repo: "org-a/old2",
				project: "p",
				outOfScope: { reason: REASON },
			} as never),
		).resolves.toBeTruthy();
	});

	test("DENY: outOfScope beside an orchestrator, an agent ID, or a reviewer is INVALID_ROUTE", async () => {
		const t = makeT();
		await seed(t);
		const id = await agentId(t, "org-b", ORCH);
		for (const extra of [
			{ orchestrator: ORCH },
			{ orchestratorAgentId: id },
			{ reviewer: "rev" },
			{ fallbackReviewer: "rev" },
		]) {
			const msg = await refusal(
				member(t, "org-b").mutation(api.githubRepoMapping.add, {
					repo: "org-b/both",
					project: "p",
					outOfScope: { reason: REASON },
					...extra,
				} as never),
			);
			expect(msg).toContain("INVALID_ROUTE");
		}
		expect(await rowOf(t, "org-b/both")).toBeNull();
	});

	test("DENY: a reason under 10 characters once trimmed is refused", async () => {
		const t = makeT();
		await seed(t);
		for (const reason of ["", "   short   ", "123456789"]) {
			const msg = await refusal(
				member(t, "org-a").mutation(api.githubRepoMapping.add, {
					repo: "org-a/short",
					project: "p",
					outOfScope: { reason },
				} as never),
			);
			expect(msg).toContain("INVALID_ROUTE");
		}
		expect(await rowOf(t, "org-a/short")).toBeNull();
	});

	test("DENY: a routed row needs an orchestrator", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(
			member(t, "org-b").mutation(api.githubRepoMapping.add, {
				repo: "org-b/noowner",
				project: "p",
			} as never),
		);
		expect(msg).toContain("INVALID_ROUTE");
	});

	test("a routed row becomes out of scope without leaving half of the route behind, and back", async () => {
		const t = makeT();
		await seed(t);
		await member(t, "org-b").mutation(api.githubRepoMapping.add, {
			repo: "org-b/mine",
			project: "p",
			outOfScope: { reason: REASON },
		} as never);
		const out = await rowOf(t, "org-b/mine");
		expect(out?.outOfScope).toEqual({ reason: REASON });
		expect(out?.orchestrator).toBeUndefined();
		expect(out?.orchestratorAgentId).toBeUndefined();
		expect(out?.reviewer).toBeUndefined();

		await member(t, "org-b").mutation(api.githubRepoMapping.add, {
			repo: "org-b/mine",
			project: "p",
			orchestrator: ORCH,
		} as never);
		const back = await rowOf(t, "org-b/mine");
		expect(back?.outOfScope).toBeUndefined();
		expect(back?.orchestrator).toBe(ORCH);
	});
});

describe("githubRepoMapping:getRoute states out-of-scope", () => {
	test("ADMIT: the caller's own org reads { state: out-of-scope, reason }", async () => {
		const t = makeT();
		await seed(t);
		expect(await member(t, "org-a").query(api.githubRepoMapping.getRoute, { repo: "org-a/fork" })).toEqual({
			state: "out-of-scope",
			reason: REASON,
		});
	});

	test("DENY: another org's out-of-scope row is answered as absent, with none of its content", async () => {
		const t = makeT();
		await seed(t);
		expect(await member(t, "org-b").query(api.githubRepoMapping.getRoute, { repo: "org-a/fork" })).toEqual({
			state: "absent",
		});
	});

	test("a routed repo is unchanged", async () => {
		const t = makeT();
		await seed(t);
		const r = await member(t, "org-a").query(api.githubRepoMapping.getRoute, { repo: "org-a/mine" });
		expect(r.state).toBe("unreviewed");
	});
});

describe("tasks:create against an out-of-scope repo", () => {
	test("DENY in an ADOPTED org: repo-out-of-scope names the reason and how to route it", async () => {
		const t = makeT();
		await seed(t);
		const msg = await refusal(create(t, "org-a", { assignedTo: ORCH, repo: "org-a/fork" }));
		expect(msg).toContain("RBAC_DENIED");
		expect(msg).toContain("repo-out-of-scope");
		expect(msg).toContain(REASON);
		expect(msg).toContain("add_repo_mapping");
		const review = await refusal(
			create(t, "org-a", { title: "[REVIEW] PR #3 org-a/fork — scope", assignedTo: "rev" }),
		);
		expect(review).toContain("repo-out-of-scope");
		expect(await t.run(async (ctx) => (await ctx.db.query("tasks").collect()).length)).toBe(0);
	});

	test("NOT ADOPTED: unchanged, the task is created", async () => {
		const t = makeT();
		await seed(t);
		expect(await create(t, "org-b", { assignedTo: ORCH, repo: "org-b/fork" })).toBeTruthy();
	});
});
