/// <reference types="vite/client" />
// repoMappingTenant.test.ts — operator countermand: client orgs are not deferred.
//
// githubRepoMapping and issues carry an optional `orgId` (absent = fleet row).
// It is written server-side from the caller's verified scope, never from an
// argument. Every consumer of githubRepoMapping is pinned below, under ORDINARY
// org-member identities (never master / service account, except the explicit
// fleet pole).

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

// Scheduled jobs are recorded (read back from _scheduled_functions), never fired.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

const ORCH = "eta";
const NOTE = "Fixed the defect in commit abcdef1234567 with regression test, 3/3 pass";
const IRP_NOTE = "Root cause: bad join. Fix: scope by org. Files: convex/tasks.ts, convex/lib/x.ts";

const asOrg = (t: T, slug: string) =>
	t.withIdentity({ subject: `user-${slug}`, organizationId: slug } as Parameters<
		T["withIdentity"]
	>[0]);

async function seed(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", { key: "billableProjects", value: [], updatedAt: 0 });
		for (const slug of ["org-a", "org-b", "org-op"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [ORCH],
				scopes: [
					"view-own-tasks",
					"view-own-missions",
					...(slug === "org-a" ? ["manage-repo-mappings"] : []),
				],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
				...(slug === "org-op" ? { orgKind: "operator" as const } : {}),
			});
		}
		// GitHub-verified owner bindings (the proof add() requires of a member).
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("githubOwnerBindings", {
				owner: slug,
				orgId: slug,
				installationId: slug === "org-a" ? 1 : 2,
				accountType: "Organization",
				githubUserLogin: `gh-${slug}`,
				boundBy: `admin-${slug}`,
				boundAt: 1,
				active: true,
			});
		}
		// org-a and org-b BOTH map the SAME project slug; "only-b" is org-b's alone.
		const rows: Array<[string, string, string | undefined]> = [
			["org-a/repo", "shared-proj", "org-a"],
			["org-b/repo", "shared-proj", "org-b"],
			["org-b/other", "only-b", "org-b"],
			["fleet/repo", "fleet-proj", undefined],
		];
		for (const [repo, project, orgId] of rows) {
			await ctx.db.insert("githubRepoMapping", {
				repo,
				orchestrator: ORCH,
				project,
				active: true,
				...(orgId !== undefined ? { orgId } : {}),
			});
			await ctx.db.insert("issues", {
				repo,
				issueNumber: 5,
				title: `${repo} issue`,
				body: "",
				htmlUrl: `https://example.test/${repo}/5`,
				labels: [],
				status: "open",
				priority: "medium",
				assignedOrchestrator: ORCH,
				project,
				githubCreatedAt: 1,
				githubUpdatedAt: 1,
				...(orgId !== undefined ? { orgId } : {}),
			});
		}
	});
}

const issueOf = (t: T, repo: string, n = 5) =>
	t.run(async (ctx) =>
		ctx.db
			.query("issues")
			.withIndex("by_repo_number", (q) => q.eq("repo", repo).eq("issueNumber", n))
			.unique(),
	);

const mappingOf = (t: T, repo: string) =>
	t.run(async (ctx) =>
		ctx.db.query("githubRepoMapping").withIndex("by_repo", (q) => q.eq("repo", repo)).unique(),
	);

async function completes(
	caller: ReturnType<typeof asOrg>,
	project: string,
	title = "Fix flaky thing #5",
	note = NOTE,
) {
	const taskId = await caller.mutation(api.tasks.create, {
		title,
		assignedTo: ORCH,
		priority: "high",
		status: "todo",
		createdBy: ORCH,
		project,
	});
	await caller.mutation(api.tasks.complete, { taskId, callerOrchestrator: ORCH, completionNote: note });
	return taskId;
}

const scheduledJobs = (t: T) =>
	t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
const fixPatternCount = (t: T) =>
	t.run(async (ctx) => (await ctx.db.query("fixPatterns").collect()).length);

describe("auto-link: a client org links ITS OWN issues and only its own", () => {
	test("PRESENT: org-a on a project slug both orgs map links org-a's issue, not org-b's", async () => {
		const t = makeT();
		await seed(t);
		const b0 = await issueOf(t, "org-b/repo");
		const taskId = await completes(asOrg(t, "org-a"), "shared-proj");
		const a = await issueOf(t, "org-a/repo");
		expect(a?.status).toBe("fixed");
		expect(a?.linkedTaskIds).toEqual([taskId]);
		expect(await issueOf(t, "org-b/repo")).toEqual(b0);
	});

	test("REFUSED: org-a naming a project only org-b maps leaves org-b's issue untouched", async () => {
		const t = makeT();
		await seed(t);
		const b0 = await issueOf(t, "org-b/other");
		await completes(asOrg(t, "org-a"), "only-b");
		expect(await issueOf(t, "org-b/other")).toEqual(b0);
	});

	test("REFUSED: org-a naming the FLEET's project leaves the fleet issue untouched", async () => {
		const t = makeT();
		await seed(t);
		const f0 = await issueOf(t, "fleet/repo");
		await completes(asOrg(t, "org-a"), "fleet-proj");
		expect(await issueOf(t, "fleet/repo")).toEqual(f0);
	});

	test("REFUSED: org-a's mapping but an issue stamped for another tenant is not patched", async () => {
		const t = makeT();
		await seed(t);
		await t.run(async (ctx) => {
			const i = await ctx.db
				.query("issues")
				.withIndex("by_repo_number", (q) => q.eq("repo", "org-a/repo").eq("issueNumber", 5))
				.unique();
			if (i) await ctx.db.patch(i._id, { orgId: "org-b" });
		});
		const before = await issueOf(t, "org-a/repo");
		await completes(asOrg(t, "org-a"), "shared-proj");
		expect(await issueOf(t, "org-a/repo")).toEqual(before);
	});

	test("FLEET: operator-org member and service account still link the fleet issue", async () => {
		const t = makeT();
		await seed(t);
		const taskId = await completes(asOrg(t, "org-op"), "fleet-proj");
		const f = await issueOf(t, "fleet/repo");
		expect(f?.status).toBe("fixed");
		expect(f?.linkedTaskIds).toEqual([taskId]);
		const t2 = makeT();
		await seed(t2);
		const svc = t2.withIdentity({ subject: "test-service-account-user-id" });
		const id2 = await completes(svc as never, "fleet-proj");
		expect((await issueOf(t2, "fleet/repo"))?.linkedTaskIds).toEqual([id2]);
	});

	test("REFUSED: operator-org naming a CLIENT org's project does not touch that org's issue", async () => {
		const t = makeT();
		await seed(t);
		const b0 = await issueOf(t, "org-b/other");
		await completes(asOrg(t, "org-op"), "only-b");
		expect(await issueOf(t, "org-b/other")).toEqual(b0);
	});
});

describe("IRP comment + fixPattern", () => {
	const irp = (caller: ReturnType<typeof asOrg>, project: string, step: number, note: string) =>
		completes(caller, project, `[#5] T${step} — step`, note);

	test("PRESENT: org-a on its own mapping schedules the comment for ITS repo; no global fixPattern", async () => {
		const t = makeT();
		await seed(t);
		const a = asOrg(t, "org-a");
		await irp(a, "shared-proj", 6, NOTE);
		await irp(a, "shared-proj", 7, IRP_NOTE);
		const jobs = (await scheduledJobs(t)).filter((j) => j.name.includes("postComment"));
		expect(jobs.length).toBe(1);
		expect(JSON.stringify(jobs[0].args)).toContain("org-a/repo");
		expect(JSON.stringify(jobs[0].args)).not.toContain("org-b/repo");
		// fixPatterns + its RAG entry are a global fleet corpus: a client org never writes it.
		expect(await fixPatternCount(t)).toBe(0);
		expect((await scheduledJobs(t)).filter((j) => j.name.includes("FixPatternRagEntry"))).toEqual([]);
	});

	test("REFUSED: org-a naming org-b's project schedules nothing and writes no fixPattern", async () => {
		const t = makeT();
		await seed(t);
		const a = asOrg(t, "org-a");
		for (const step of [6, 8, 11]) await irp(a, "only-b", step, NOTE);
		await irp(a, "only-b", 7, IRP_NOTE);
		expect((await scheduledJobs(t)).filter((j) => j.name.includes("postComment"))).toEqual([]);
		expect(await fixPatternCount(t)).toBe(0);
	});

	test("FLEET: operator-org T7 on a fleet mapping still creates 1 fixPattern and T6 a comment", async () => {
		const t = makeT();
		await seed(t);
		const op = asOrg(t, "org-op");
		await irp(op, "fleet-proj", 7, IRP_NOTE);
		expect(await fixPatternCount(t)).toBe(1);
		await irp(op, "fleet-proj", 6, NOTE);
		expect((await scheduledJobs(t)).filter((j) => j.name.includes("postComment")).length).toBe(1);
	});
});

describe("resolveStaleDeployTasks / createDeployTaskWithDedup read only the task's own tenant's mapping", () => {
	const DEPLOY_TITLE = "[Deploy] PR #3 merged — deploy shared-proj to prod";
	const stampDeploy = (t: T, repo: string, sha: string) =>
		t.run(async (ctx) => {
			const m = await ctx.db
				.query("githubRepoMapping")
				.withIndex("by_repo", (q) => q.eq("repo", repo))
				.unique();
			if (m) await ctx.db.patch(m._id, { lastDeployedAt: Date.now() + 60_000, lastDeployedSHA: sha });
		});
	const deployTask = (t: T) =>
		asOrg(t, "org-a").mutation(api.tasks.create, {
			title: DEPLOY_TITLE,
			assignedTo: ORCH,
			priority: "low",
			status: "todo",
			createdBy: ORCH,
		});

	test("REFUSED: org-a's deploy-titled task is NOT closed from org-b's lastDeployedAt/SHA", async () => {
		const t = makeT();
		await seed(t);
		await stampDeploy(t, "org-b/repo", "b-secret-sha");
		const id = await deployTask(t);
		await t.mutation(internal.tasks.resolveStaleDeployTasks, {});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.status).toBe("todo");
		expect(row?.completionNote ?? "").not.toContain("b-secret-sha");
	});

	test("PRESENT: org-a's task IS closed from org-a's own mapping", async () => {
		const t = makeT();
		await seed(t);
		await stampDeploy(t, "org-a/repo", "a-own-sha");
		const id = await deployTask(t);
		await t.mutation(internal.tasks.resolveStaleDeployTasks, {});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.status).toBe("done");
		expect(row?.completionNote).toContain("a-own-sha");
	});

	test("REAL: createDeployTaskWithDedup (fleet automation) ignores a client org's newer lastDeployedAt", async () => {
		const t = makeT();
		await seed(t);
		await stampDeploy(t, "org-b/repo", "b-sha");
		const id = await t.mutation(internal.tasks.createDeployTaskWithDedup, {
			title: DEPLOY_TITLE,
			assignedTo: ORCH,
			priority: "low",
			createdBy: "system",
			prMergedAt: Date.now(),
		});
		expect(id).not.toBeNull();
	});
});

describe("githubRepoMapping.add / remove / list are tenant-stamped", () => {
	const denied = (e: unknown) => {
		expect(e).toBeInstanceOf(ConvexError);
		expect((e as ConvexError<string>).message).toContain("RBAC_DENIED");
	};

	test("PRESENT: a scoped org-a member adds a mapping; orgId is stamped from its scope", async () => {
		const t = makeT();
		await seed(t);
		await asOrg(t, "org-a").mutation(api.githubRepoMapping.add, {
			repo: "org-a/new",
			orchestrator: ORCH,
			project: "new-proj",
		});
		expect((await mappingOf(t, "org-a/new"))?.orgId).toBe("org-a");
	});

	test("an orgId argument is not accepted at all", async () => {
		const t = makeT();
		await seed(t);
		const err = await asOrg(t, "org-a")
			.mutation(api.githubRepoMapping.add, {
				repo: "org-a/forge",
				orchestrator: ORCH,
				project: "p",
				orgId: "org-b",
			} as never)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(await mappingOf(t, "org-a/forge")).toBeNull();
	});

	test("REFUSED: member without the manage-repo-mappings scope", async () => {
		const t = makeT();
		await seed(t);
		denied(
			await asOrg(t, "org-b")
				.mutation(api.githubRepoMapping.add, { repo: "org-b/new", orchestrator: ORCH, project: "p" })
				.catch((e: unknown) => e),
		);
		expect(await mappingOf(t, "org-b/new")).toBeNull();
	});

	test("REFUSED: org-a cannot take over org-b's or the fleet's repo, nor remove them", async () => {
		const t = makeT();
		await seed(t);
		const a = asOrg(t, "org-a");
		for (const repo of ["org-b/repo", "fleet/repo"]) {
			const before = await mappingOf(t, repo);
			denied(
				await a
					.mutation(api.githubRepoMapping.add, { repo, orchestrator: ORCH, project: "hijack" })
					.catch((e: unknown) => e),
			);
			denied(await a.mutation(api.githubRepoMapping.remove, { repo }).catch((e: unknown) => e));
			expect(await mappingOf(t, repo)).toEqual(before);
		}
	});

	test("PRESENT: org-a removes its own mapping", async () => {
		const t = makeT();
		await seed(t);
		const r = await asOrg(t, "org-a").mutation(api.githubRepoMapping.remove, { repo: "org-a/repo" });
		expect(r).toEqual({ deleted: true });
		expect(await mappingOf(t, "org-a/repo")).toBeNull();
	});

	test("list: org-a sees exactly its own rows, master sees all", async () => {
		const t = makeT();
		await seed(t);
		const mine = (await asOrg(t, "org-a").query(api.githubRepoMapping.list, {})) as {
			items: Array<{ repo: string }>;
		};
		expect(mine.items.map((r) => r.repo)).toEqual(["org-a/repo"]);
		const svc = t.withIdentity({ subject: "test-service-account-user-id" });
		const all = (await svc.query(api.githubRepoMapping.list, {})) as { items: unknown[] };
		expect(all.items.length).toBe(4);
	});
});

describe("issues.upsertFromGitHub stamps the issue from the mapping", () => {
	const upsert = (t: T, repo: string) =>
		t.mutation(internal.issues.upsertFromGitHub, {
			repo,
			issueNumber: 9,
			title: "t",
			body: "b",
			htmlUrl: "https://example.test/9",
			labels: [],
			status: "open",
			githubCreatedAt: 1,
			githubUpdatedAt: 1,
		});

	test("client repo -> issue.orgId = mapping.orgId; fleet repo -> unstamped", async () => {
		const t = makeT();
		await seed(t);
		await upsert(t, "org-a/repo");
		await upsert(t, "fleet/repo");
		// issue #5 exists; #9 is new on both
		expect((await issueOf(t, "org-a/repo", 9))?.orgId).toBe("org-a");
		expect((await issueOf(t, "fleet/repo", 9))?.orgId).toBeUndefined();
	});
});

describe("SAFE consumers (keyed by the exact, globally unique repo; no caller-chosen project string)", () => {
	test("getByRepo (public): a member is served ITS OWN row, REFUSED another org's and the fleet's, null for no row", async () => {
		const t = makeT();
		await seed(t);
		const a = asOrg(t, "org-a");
		const own = await a.query(api.githubRepoMapping.getByRepo, { repo: "org-a/repo" });
		expect(own?.orgId).toBe("org-a");
		for (const repo of ["org-b/repo", "fleet/repo"]) {
			const err = await a.query(api.githubRepoMapping.getByRepo, { repo }).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(ConvexError);
			expect(String((err as ConvexError<string>).data)).toContain("RBAC_DENIED");
			expect(String((err as ConvexError<string>).data)).toContain("githubRepoMapping:getByRepo");
		}
		expect(await a.query(api.githubRepoMapping.getByRepo, { repo: "org-a/none" })).toBeNull();
		const svc = t.withIdentity({ subject: "test-service-account-user-id" });
		expect((await svc.query(api.githubRepoMapping.getByRepo, { repo: "org-b/repo" }))?.orgId).toBe("org-b");
	});

	test("webhook routing (getByRepoInternal) returns exactly the row of the named repo, with its tenant", async () => {
		const t = makeT();
		await seed(t);
		const a = await t.query(internal.githubRepoMapping.getByRepoInternal, { repo: "org-a/repo" });
		const b = await t.query(internal.githubRepoMapping.getByRepoInternal, { repo: "org-b/repo" });
		expect(a?.orgId).toBe("org-a");
		expect(b?.orgId).toBe("org-b");
		expect(a?.project).toBe(b?.project); // same slug, distinct rows
		expect(a?._id).not.toBe(b?._id);
	});

	test("review routing resolves each repo's own reviewer, never another org's", async () => {
		const t = makeT();
		await seed(t);
		await t.run(async (ctx) => {
			for (const [repo, reviewer] of [
				["org-a/repo", "rev-a"],
				["org-b/repo", "rev-b"],
			]) {
				const m = await ctx.db
					.query("githubRepoMapping")
					.withIndex("by_repo", (q) => q.eq("repo", repo))
					.unique();
				if (m) await ctx.db.patch(m._id, { reviewer });
			}
		});
		expect(await t.query(internal.reviewRouting.resolveForRepo, { repo: "org-a/repo" })).not.toBe("rev-b");
		expect(await t.query(internal.reviewRouting.resolveForRepo, { repo: "org-b/repo" })).not.toBe("rev-a");
	});

	test("recordDeployment (deploy key) patches only the named repo's row", async () => {
		const t = makeT();
		await seed(t);
		await t.mutation(internal.githubRepoMapping.recordDeployment, { repo: "org-a/repo", sha: "sha-a" });
		expect((await mappingOf(t, "org-a/repo"))?.lastDeployedSHA).toBe("sha-a");
		expect((await mappingOf(t, "org-b/repo"))?.lastDeployedSHA).toBeUndefined();
	});
});
