/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// reviewRouting.test.ts — task k17b5btg6cr9t9824tndte3w2s8fmzx1
//
// The reviewer of an automation review task is DATA, not the constant "eta".
//   - routing: a STOPPED reviewer's review task goes to the configured fallback
//   - RBAC: a system-created review task can be reassigned by the coordinator
//     or the repo's author orchestrator, and by nobody else
//   - the npm-publish verify endpoint accepts the configured reviewer set only
// Reviewer config lives in `taskClosureConfig` (fleet defaults) and optionally
// on the `githubRepoMapping` row (per-repo override).
// ─────────────────────────────────────────────────────────────────────────────

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TEST_WEBHOOK_SECRET, signGithubBody } from "../../tests/lib/githubWebhookSignature";
import { internal } from "../_generated/api";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const REPO = "vantageos-agency/vantage-peers";
const PR_NUMBER = 374;

type T = Awaited<ReturnType<typeof createT>>;

const seedConfig = async (
	t: T,
	cfg: { reviewer?: string; fallback?: string; stopped?: string[]; coordinators?: string[] },
) => {
	await t.run(async (ctx) => {
		const put = async (key: string, value: string[]) => {
			await ctx.db.insert("taskClosureConfig", { key, value, updatedAt: Date.now() });
		};
		if (cfg.reviewer) await put("reviewerDefault", [cfg.reviewer]);
		if (cfg.fallback) await put("reviewerFallback", [cfg.fallback]);
		if (cfg.stopped) await put("stoppedOrchestrators", cfg.stopped);
		if (cfg.coordinators) await put("reviewCoordinators", cfg.coordinators);
	});
};

const createT = async () => {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert("githubRepoMapping", {
			repo: REPO,
			orchestrator: "sigma",
			project: "vantage-peers",
			active: true,
		});
		// Real message recipients are derived from `profiles`; a channel with no
		// profile bounces. Every orchestrator the tests can route to has one.
		for (const id of ["eta", "argus", "sigma", "omega", "pi"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: id,
				name: id,
				static: { role: id, workspace: "test", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 1 },
			});
		}
	});
	return t;
};

const svc = (t: T) => t.withIdentity({ subject: "test-service-account-user-id" });

const openReview = (t: T, assignedTo?: string) =>
	t.mutation(internal.tasks.createOrUpdateReviewTask, {
		repoFullName: REPO,
		prNumber: PR_NUMBER,
		prTitle: "some change",
		...(assignedTo !== undefined ? { assignedTo } : {}),
		priority: "high",
		createdBy: "system",
		tags: ["github", "pr-review", "opened"],
	});

beforeEach(() => {
	vi.useFakeTimers();
	process.env.GITHUB_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
	process.env.BEARER_SECRET_MASTER = "test-master-secret";
});
afterEach(() => {
	vi.useRealTimers();
	delete process.env.GITHUB_WEBHOOK_SECRET;
	delete process.env.BEARER_SECRET_MASTER;
});

const assigneeOf = (t: T, id: string) =>
	t.run(async (ctx) => (await ctx.db.get(id as never) as { assignedTo?: string }).assignedTo);

const postPrOpened = (t: T) => {
	const body = JSON.stringify({
		action: "opened",
		pull_request: {
			number: PR_NUMBER,
			title: "some change",
			html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
			user: { login: "someone" },
			head: { ref: "feat/x" },
		},
		repository: { full_name: REPO },
	});
	return t.fetch("/github/webhook", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-github-event": "pull_request",
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": signGithubBody(body),
		},
		body,
	});
};

describe("review routing — reviewer is data, a stopped reviewer falls back", () => {
	test("RED(a): eta stopped -> review task goes to the configured fallback (argus), not eta (webhook path)", async () => {
		const t = await createT();
		await seedConfig(t, { reviewer: "eta", fallback: "argus", stopped: ["eta"] });
		await postPrOpened(t);
		const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
		const review = tasks.filter((x) => x.title.startsWith("[Review] "));
		expect(review).toHaveLength(1);
		expect(review[0].assignedTo).not.toBe("eta");
		expect(review[0].assignedTo).toBe("argus");
	});

	test("RED(a'): same at the mutation level", async () => {
		const t = await createT();
		await seedConfig(t, { reviewer: "eta", fallback: "argus", stopped: ["eta"] });
		const id = await openReview(t);
		expect(await assigneeOf(t, id!)).toBe("argus");
	});

	test("running configured reviewer still receives the task (no needless fallback)", async () => {
		const t = await createT();
		await seedConfig(t, { reviewer: "eta", fallback: "argus", stopped: [] });
		const id = await openReview(t);
		expect(await assigneeOf(t, id!)).toBe("eta");
	});

	test("per-repo reviewer on the mapping row overrides the fleet default", async () => {
		const t = await createT();
		await seedConfig(t, { reviewer: "eta", fallback: "argus" });
		await t.run(async (ctx) => {
			const row = await ctx.db.query("githubRepoMapping").first();
			await ctx.db.patch(row!._id, { reviewer: "omega" });
		});
		const id = await openReview(t);
		expect(await assigneeOf(t, id!)).toBe("omega");
	});

	test("webhook notification goes to the resolved assignee, not eta", async () => {
		const t = await createT();
		await seedConfig(t, { reviewer: "eta", fallback: "argus", stopped: ["eta"] });
		await postPrOpened(t);
		const msgs = await t.run((ctx) => ctx.db.query("messages").collect());
		const channels = msgs.filter((m) => m.content.includes("PR #374")).map((m) => m.channel);
		expect(channels).toContain("argus");
		expect(channels).not.toContain("eta");
	});

	const reviewTasksOf = (t: T) =>
		t.run(async (ctx) =>
			(await ctx.db.query("tasks").collect()).filter((x) => x.title.startsWith("[Review] ")),
		);

	test("no reviewer configured: NO task is created (never on the repo owner), mutation returns null", async () => {
		const t = await createT();
		const id = await openReview(t);
		expect(id).toBeNull();
		expect(await reviewTasksOf(t)).toHaveLength(0);
	});

	test("REVIEWER_UNRESOLVED is surfaced to the configured coordinator channel (webhook path)", async () => {
		const t = await createT();
		await seedConfig(t, { coordinators: ["pi"] });
		await postPrOpened(t);
		expect(await reviewTasksOf(t)).toHaveLength(0);
		const msgs = await t.run((ctx) => ctx.db.query("messages").collect());
		const hit = msgs.filter((m) => m.content.includes("REVIEWER_UNRESOLVED"));
		expect(hit).toHaveLength(1);
		expect(hit[0].channel).toBe("pi");
		expect(hit[0].content).toContain(REPO);
		expect(hit[0].content).toContain(`PR #${PR_NUMBER}`);
		// nothing went to the author either
		expect(msgs.some((m) => m.channel === "sigma")).toBe(false);
	});

	test("unresolved with no coordinator configured: console.error, no throw, no task, no message", async () => {
		const t = await createT();
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await postPrOpened(t);
		expect(res.status).toBe(200);
		expect(err.mock.calls.some((c) => String(c[0]).includes("REVIEWER_UNRESOLVED"))).toBe(true);
		expect(await reviewTasksOf(t)).toHaveLength(0);
		expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
		err.mockRestore();
	});

	test("reviewer == repo owner (author) is unresolved too, even with a fallback that is stopped", async () => {
		const t = await createT();
		await seedConfig(t, { reviewer: "sigma" });
		expect(await openReview(t)).toBeNull();
		const t2 = await createT();
		await seedConfig(t2, { reviewer: "eta", fallback: "sigma", stopped: ["eta"] });
		expect(await openReview(t2)).toBeNull();
		expect(await reviewTasksOf(t2)).toHaveLength(0);
	});

	test("an already-open review task is still updated in place when the reviewer becomes unresolved", async () => {
		const t = await createT();
		await seedConfig(t, { reviewer: "eta" });
		const first = await openReview(t);
		expect(first).not.toBeNull();
		await t.run(async (ctx) => {
			const row = await ctx.db.query("taskClosureConfig").withIndex("by_key", (q) => q.eq("key", "reviewerDefault")).unique();
			await ctx.db.delete(row!._id);
		});
		expect(await openReview(t)).toBe(first);
	});
});

describe("review task reassignment RBAC", () => {
	const setup = async () => {
		const t = await createT();
		await seedConfig(t, { reviewer: "eta", fallback: "argus", coordinators: ["pi"] });
		const id = (await openReview(t, "eta"))!;
		return { t, id };
	};

	test("RED(b): pi (coordinator) reassigns a system review task", async () => {
		const { t, id } = await setup();
		await svc(t).mutation(api.tasks.update, {
			taskId: id,
			callerOrchestrator: "pi",
			assignedTo: "argus",
		});
		expect(await assigneeOf(t, id)).toBe("argus");
	});

	test("the repo's author orchestrator (sigma) reassigns it", async () => {
		const { t, id } = await setup();
		await svc(t).mutation(api.tasks.update, {
			taskId: id,
			callerOrchestrator: "sigma",
			assignedTo: "argus",
		});
		expect(await assigneeOf(t, id)).toBe("argus");
	});

	test("NEGATIVE: an unrelated caller is still RBAC_DENIED on a system review task", async () => {
		const { t, id } = await setup();
		const err = await svc(t)
			.mutation(api.tasks.update, { taskId: id, callerOrchestrator: "omega", assignedTo: "argus" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		expect((err as ConvexError<string>).message).toContain("RBAC_DENIED");
	});

	test("NEGATIVE: the grant is reassignment only — coordinator cannot rewrite other fields", async () => {
		const { t, id } = await setup();
		const err = await svc(t)
			.mutation(api.tasks.update, { taskId: id, callerOrchestrator: "pi", assignedTo: "argus", title: "hijack" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
	});

	test("NEGATIVE: pi cannot reassign a NON-review task it neither created nor holds", async () => {
		const { t } = await setup();
		const id = await svc(t).mutation(api.tasks.create, {
			title: "plain chore",
			assignedTo: "sigma",
			priority: "low",
			status: "todo",
			createdBy: "omega",
		});
		const err = await svc(t)
			.mutation(api.tasks.update, { taskId: id, callerOrchestrator: "pi", assignedTo: "argus" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		expect((err as ConvexError<string>).message).toContain("RBAC_DENIED");
	});

	test("NEGATIVE: pi cannot reassign a review task a human/orchestrator created (not system)", async () => {
		const { t } = await setup();
		const id = await svc(t).mutation(api.tasks.create, {
			title: "[Review] other/repo PR #9: x",
			assignedTo: "sigma",
			priority: "low",
			status: "todo",
			createdBy: "omega",
		});
		const err = await svc(t)
			.mutation(api.tasks.update, { taskId: id, callerOrchestrator: "pi", assignedTo: "argus" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
	});

	test("NEGATIVE: the owner (author) cannot reassign the review onto itself", async () => {
		const { t, id } = await setup();
		const err = await svc(t)
			.mutation(api.tasks.update, { taskId: id, callerOrchestrator: "sigma", assignedTo: "sigma" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		expect((err as ConvexError<string>).message).toContain("RBAC_DENIED");
		expect((err as ConvexError<string>).message).toContain("never reviewed by its author");
		expect(await assigneeOf(t, id)).toBe("eta");
	});

	test("NEGATIVE: the coordinator cannot reassign the review onto the owner (author)", async () => {
		const { t, id } = await setup();
		const err = await svc(t)
			.mutation(api.tasks.update, { taskId: id, callerOrchestrator: "pi", assignedTo: "sigma" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		expect((err as ConvexError<string>).message).toContain("RBAC_DENIED");
		expect((err as ConvexError<string>).message).toContain("never reviewed by its author");
		expect(await assigneeOf(t, id)).toBe("eta");
	});

	test("the coordinator reassigning onto argus is still allowed", async () => {
		const { t, id } = await setup();
		await svc(t).mutation(api.tasks.update, { taskId: id, callerOrchestrator: "pi", assignedTo: "argus" });
		expect(await assigneeOf(t, id)).toBe("argus");
	});

	test("fail-closed: no coordinator configured -> pi is refused", async () => {
		const t = await createT();
		await seedConfig(t, { reviewer: "eta" });
		const id = (await openReview(t, "eta"))!;
		const err = await svc(t)
			.mutation(api.tasks.update, { taskId: id, callerOrchestrator: "pi", assignedTo: "argus" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
	});
});

describe("npm-publish verify endpoint — configured reviewer set, fail-closed", () => {
	const verify = async (t: T, assignedTo: string) => {
		const taskId = await t.run((ctx) =>
			ctx.db.insert("tasks", {
				title: "[Review] x",
				assignedTo,
				priority: "high",
				status: "done",
				createdBy: "system",
				completionNote: "APPROVED abcdef1234567",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const res = await t.fetch("/api/eta/verify-publish-token", {
			method: "POST",
			headers: { Authorization: "Bearer test-master-secret", "Content-Type": "application/json" },
			body: JSON.stringify({ taskId, expectedSha: "abcdef1234567" }),
		});
		return (await res.json()) as { valid: boolean; reason?: string };
	};

	test("fallback reviewer's approval is accepted", async () => {
		const t = await createT();
		await seedConfig(t, { reviewer: "eta", fallback: "argus" });
		expect((await verify(t, "argus")).valid).toBe(true);
		expect((await verify(t, "eta")).valid).toBe(true);
	});

	test("a non-reviewer assignee is refused", async () => {
		const t = await createT();
		await seedConfig(t, { reviewer: "eta", fallback: "argus" });
		expect((await verify(t, "sigma")).reason).toBe("wrong-assignee");
	});

	test("no reviewer configured -> refused (fail-closed)", async () => {
		const t = await createT();
		expect((await verify(t, "eta")).reason).toBe("wrong-assignee");
	});
});
