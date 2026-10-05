/// <reference types="vite/client" />
// completeAutoLinkTenantScope.test.ts — task k17bata5fx4pvdc8rh45r0d01n8fp70a
//
// QUESTION: `tasks.complete` auto-links "#NNN" tasks to a row of the GLOBAL
// `issues` table, resolving the repo through `githubRepoMapping` keyed on
// `task.project` — a string the member sets on its own task. Can an org-a
// member complete its own task, naming an org-b project, and so modify an
// org-b issue row?
//
// Both `issues` and `githubRepoMapping` carry NO orgId column: they are the
// operator fleet's own rows. The tenant is therefore read from the task's
// server-stamped orgId, never from the caller-chosen `project` string.
// Poles (ordinary org member identities, never master / service account,
// except the explicit fleet pole):
//   REFUSED — client org-a completes #5 naming org-b's project (and the fleet's
//             project): the issue row is byte-identical afterwards.
//   PRESENT — an operator-org member, and a fleet-scope (master) task, still
//             link and fix the issue on the project they name.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

afterEach(() => vi.useRealTimers());

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

const ORCH = "eta";
const NOTE = "Fixed the defect in commit abcdef1234567 with regression test, 3/3 pass";
const SLUGS = ["org-a", "org-b", "org-op"] as const;

const asOrg = (t: T, slug: string) =>
	t.withIdentity({ subject: `user-${slug}`, organizationId: slug } as Parameters<
		T["withIdentity"]
	>[0]);

async function seed(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: 0,
		});
		for (const slug of SLUGS) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [ORCH],
				scopes: ["view-own-tasks", "view-own-missions"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
				...(slug === "org-op" ? { orgKind: "operator" as const } : {}),
			});
			await ctx.db.insert("githubRepoMapping", {
				repo: `${slug}/repo`,
				orchestrator: ORCH,
				project: `proj-${slug}`,
				active: true,
			});
			await ctx.db.insert("issues", {
				repo: `${slug}/repo`,
				issueNumber: 5,
				title: `${slug} issue`,
				body: "",
				htmlUrl: `https://example.test/${slug}/5`,
				labels: [],
				status: "open",
				priority: "medium",
				assignedOrchestrator: ORCH,
				project: `proj-${slug}`,
				githubCreatedAt: 1,
				githubUpdatedAt: 1,
			});
		}
	});
}

const issueOf = (t: T, repo: string) =>
	t.run(async (ctx) =>
		ctx.db
			.query("issues")
			.withIndex("by_repo_number", (q) => q.eq("repo", repo).eq("issueNumber", 5))
			.unique(),
	);

async function completes(
	caller: ReturnType<typeof asOrg>,
	project: string,
) {
	const taskId = await caller.mutation(api.tasks.create, {
		title: "Fix flaky thing #5",
		assignedTo: ORCH,
		priority: "high",
		status: "todo",
		createdBy: ORCH,
		project,
	});
	await caller.mutation(api.tasks.complete, {
		taskId,
		callerOrchestrator: ORCH,
		completionNote: NOTE,
	});
	return taskId;
}

describe("tasks.complete auto-link is bound to the task's own tenant", () => {
	test("REFUSED: client org-a naming org-b's project does not modify org-b's issue", async () => {
		const t = makeT();
		await seed(t);
		const before = await issueOf(t, "org-b/repo");
		await completes(asOrg(t, "org-a"), "proj-org-b");
		const after = await issueOf(t, "org-b/repo");
		expect(after).toEqual(before);
		expect(after?.status).toBe("open");
		expect(after?.linkedTaskIds).toBeUndefined();
		expect(after?.fixedBy).toBeUndefined();
	});

	test("REFUSED: client org-a naming the operator's project does not modify the fleet issue", async () => {
		const t = makeT();
		await seed(t);
		const before = await issueOf(t, "org-op/repo");
		await completes(asOrg(t, "org-a"), "proj-org-op");
		expect(await issueOf(t, "org-op/repo")).toEqual(before);
	});

	test("REFUSED does not break the completion itself", async () => {
		const t = makeT();
		await seed(t);
		const taskId = await completes(asOrg(t, "org-a"), "proj-org-b");
		const row = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(row?.status).toBe("done");
	});

	test("PRESENT: operator-org member links and fixes the issue on its project", async () => {
		const t = makeT();
		await seed(t);
		const taskId = await completes(asOrg(t, "org-op"), "proj-org-op");
		const issue = await issueOf(t, "org-op/repo");
		expect(issue?.status).toBe("fixed");
		expect(issue?.fixedBy).toBe(ORCH);
		expect(issue?.linkedTaskIds).toEqual([taskId]);
		expect(issue?.fixCommits).toEqual(["abcdef1234567"]);
	});

	test("PRESENT: fleet-scope (service account, unstamped) task still auto-links", async () => {
		const t = makeT();
		await seed(t);
		const svc = t.withIdentity({ subject: "test-service-account-user-id" });
		const taskId = await completes(svc as never, "proj-org-op");
		const issue = await issueOf(t, "org-op/repo");
		expect(issue?.status).toBe("fixed");
		expect(issue?.linkedTaskIds).toEqual([taskId]);
	});

	// ── IRP side effects (comment + fixPattern) share the same tenant gate ──
	// Seam: the scheduler's own record. `ctx.scheduler.runAfter` writes a row to
	// `_scheduled_functions`; we read it and never run it (ragSync is excluded
	// from the module set), so "attempted" is observable without the network.
	const IRP_NOTE = "Root cause: bad join. Fix: scope by org. Files: convex/tasks.ts, convex/lib/x.ts";
	const STEP_NOTE = "Fixed in commit abcdef1234567, 3/3 pass";
	const irp = async (caller: ReturnType<typeof asOrg>, project: string, step: number, note: string) => {
		const taskId = await caller.mutation(api.tasks.create, {
			title: `[#5] T${step} — step`,
			assignedTo: ORCH,
			priority: "high",
			status: "todo",
			createdBy: ORCH,
			project,
		});
		await caller.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: ORCH,
			completionNote: note,
		});
	};
	const fixPatternCount = (t: T) =>
		t.run(async (ctx) => (await ctx.db.query("fixPatterns").collect()).length);
	const scheduledNames = (t: T) =>
		t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).map((j) => j.name),
		);

	test("Q0 PRESENT: operator-org T7 creates 1 fixPattern; T6/T8/T11 each schedule a GitHub comment", async () => {
		vi.useFakeTimers(); // scheduled rows are recorded, never fired
		const t = makeT();
		await seed(t);
		const op = asOrg(t, "org-op");
		await irp(op, "proj-org-op", 7, IRP_NOTE);
		expect(await fixPatternCount(t)).toBe(1);
		for (const step of [6, 8, 11]) await irp(op, "proj-org-op", step, STEP_NOTE);
		const comments = (await scheduledNames(t)).filter((n) => n.includes("postComment"));
		expect(comments.length).toBe(3);
	});

	test("Q1 REFUSED: client org-a naming org-b's project creates 0 fixPatterns and schedules no comment", async () => {
		vi.useFakeTimers(); // scheduled rows are recorded, never fired
		const t = makeT();
		await seed(t);
		const a = asOrg(t, "org-a");
		await irp(a, "proj-org-b", 7, IRP_NOTE);
		for (const step of [6, 8, 11]) await irp(a, "proj-org-b", step, STEP_NOTE);
		expect(await fixPatternCount(t)).toBe(0);
		const names = await scheduledNames(t);
		expect(names.filter((n) => n.includes("postComment"))).toEqual([]);
		expect(names.filter((n) => n.includes("FixPatternRagEntry"))).toEqual([]);
	});
});
