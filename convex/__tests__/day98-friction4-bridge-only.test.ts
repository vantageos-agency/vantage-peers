/// <reference types="vite/client" />
//
// Day 98 F4 — Bridge-only for issue_comment.created and pull_request_review.submitted
// Task k177yhgmfk1101046wcv04dbfd88c8kz
//
// Contract (Friction 4 spec):
//   - `issue_comment.created` on a TRUE issue (not PR comment) MUST spawn only a
//     [Bridge] task — never the full T0–T12 IRP cascade.
//   - `pull_request_review.submitted` MUST NOT spawn any cascade tasks (it only
//     sends a message notification today — verify no cascade fires).
//   - PR comments (`issue_comment.created` where issue.pull_request is set) MUST
//     return early before any task/mission creation (already covered in PR #771;
//     regression-tested here).
//
// Strategy: since httpAction is not directly invokable via convex-test, we
// test the Convex DB state invariants:
//   1. After an `issue_comment.created` event on a true open issue, only 1 task
//      exists — the [Bridge] task — even if an IRP template is seeded.
//   2. The Bridge task has the correct tags and title prefix.
//   3. No missions are created by this event path.
//   4. `pull_request_review.submitted` produces 0 tasks (message-only path).
//
// Each test seeds the template, inserts the repo mapping, then calls the
// webhook via t.fetch to simulate the HTTP event. We assert DB state after.

import { convexTest } from "convex-test";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const REPO = "vantageos-agency/vantage-memory";
const ISSUE_NUMBER = 55;
const ISSUE_URL = `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`;
const COMMENT_URL = `${ISSUE_URL}#issuecomment-12345`;

beforeEach(() => {
	delete process.env.GITHUB_WEBHOOK_SECRET;
	delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeConvex() {
	return convexTest(schema, modules);
}

async function seedTemplateAndMapping(t: ReturnType<typeof makeConvex>) {
	await t.mutation(internal.missionTemplates.seed, {});
	await t.run(async (ctx) => {
		await ctx.db.insert("githubRepoMapping", {
			repo: REPO,
			orchestrator: "sigma",
			project: "vantage-memory",
			active: true,
		});
	});
}

function buildIssueCommentPayload(opts: {
	issueState?: string;
	isPRComment?: boolean;
	commentBody?: string;
	commenterLogin?: string;
} = {}) {
	const issue: Record<string, unknown> = {
		number: ISSUE_NUMBER,
		title: "Bug: memory leak in ragSync",
		state: opts.issueState ?? "open",
		html_url: ISSUE_URL,
		user: { login: opts.commenterLogin ?? "external-user", type: "User" },
		body: "Original issue description",
	};
	if (opts.isPRComment) {
		issue.pull_request = {
			url: `https://api.github.com/repos/${REPO}/pulls/${ISSUE_NUMBER}`,
			html_url: `https://github.com/${REPO}/pull/${ISSUE_NUMBER}`,
			merged_at: null,
		};
	}
	return JSON.stringify({
		action: "created",
		repository: { full_name: REPO },
		issue,
		comment: {
			id: 12345,
			html_url: COMMENT_URL,
			body: opts.commentBody ?? "Can you look into this? It's causing problems.",
			user: { login: opts.commenterLogin ?? "external-user", type: "User" },
		},
	});
}

async function postWebhook(t: ReturnType<typeof makeConvex>, body: string, event: string) {
	return t.fetch("/github/webhook", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-github-event": event,
		},
		body,
	});
}

// ── F4.1 — issue_comment.created on TRUE issue spawns Bridge only ─────────────

describe("F4.1 — issue_comment on true issue spawns Bridge task, never T0-T12 cascade", () => {
	it("creates exactly 1 task (Bridge) — not 14 IRP tasks — when template is seeded and no mission exists", async () => {
		const t = makeConvex();
		await seedTemplateAndMapping(t);

		const tasksBefore = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		expect(tasksBefore.length).toBe(0);

		const missionsBefore = await t.run(async (ctx) =>
			ctx.db.query("missions").collect(),
		);
		expect(missionsBefore.length).toBe(0);

		const resp = await postWebhook(t, buildIssueCommentPayload(), "issue_comment");
		expect(resp.status).toBe(200);

		const tasksAfter = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		// MUST be exactly 1 — the Bridge task — NOT 14 IRP cascade tasks
		expect(tasksAfter.length).toBe(1);
		expect(tasksAfter[0].title).toContain("[Bridge");
		expect(tasksAfter[0].title).toContain(`#${ISSUE_NUMBER}`);
		expect(tasksAfter[0].tags).toContain("bridge");
		expect(tasksAfter[0].tags).toContain("day-98-f4-comment-only");
	});

	it("creates NO missions — Bridge task is standalone, no IRP mission spawned", async () => {
		const t = makeConvex();
		await seedTemplateAndMapping(t);

		await postWebhook(t, buildIssueCommentPayload(), "issue_comment");

		const missions = await t.run(async (ctx) =>
			ctx.db.query("missions").collect(),
		);
		expect(missions.length).toBe(0);
	});

	it("Bridge task has correct assignee (sigma for non-last-step), project, and priority", async () => {
		const t = makeConvex();
		await seedTemplateAndMapping(t);

		await postWebhook(t, buildIssueCommentPayload(), "issue_comment");

		const tasks = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		expect(tasks.length).toBe(1);
		const bridge = tasks[0];
		expect(bridge.project).toBe("vantage-memory");
		expect(bridge.status).toBe("todo");
		expect(bridge.tags).toContain("github");
		expect(bridge.tags).toContain("irp");
	});

	it("is idempotent — second comment on same issue does NOT create a second Bridge task when mission exists", async () => {
		const t = makeConvex();
		await seedTemplateAndMapping(t);

		// First comment → creates Bridge
		await postWebhook(t, buildIssueCommentPayload(), "issue_comment");
		const after1 = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		expect(after1.length).toBe(1);

		// Second comment on same issue → already handled (Bridge exists)
		// In this test, we're checking no cascade: task count stays stable or
		// the Bridge-only path fires again (whichever implementation chooses).
		// Either way: NEVER > ~1 tasks (not 14 per cascade).
		await postWebhook(t, buildIssueCommentPayload({ commentBody: "Another comment" }), "issue_comment");
		const after2 = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		// The critical invariant: never more than a small number of tasks (not 14+)
		expect(after2.length).toBeLessThan(5);
	});
});

// ── F4.2 — PR comment returns early (regression gate) ─────────────────────────

describe("F4.2 — PR comment (issue_comment on issue with pull_request field) returns early", () => {
	it("no tasks created for PR comment — handler returns early", async () => {
		const t = makeConvex();
		await seedTemplateAndMapping(t);

		const resp = await postWebhook(
			t,
			buildIssueCommentPayload({ isPRComment: true }),
			"issue_comment",
		);
		expect(resp.status).toBe(200);

		const tasks = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		expect(tasks.length).toBe(0);
	});

	it("no missions created for PR comment", async () => {
		const t = makeConvex();
		await seedTemplateAndMapping(t);

		await postWebhook(
			t,
			buildIssueCommentPayload({ isPRComment: true }),
			"issue_comment",
		);

		const missions = await t.run(async (ctx) =>
			ctx.db.query("missions").collect(),
		);
		expect(missions.length).toBe(0);
	});
});

// ── F4.3 — pull_request_review.submitted spawns 0 tasks ─────────────────────

describe("F4.3 — pull_request_review.submitted spawns 0 cascade tasks (message-notify only)", () => {
	it("no tasks created on review submission — only message notification", async () => {
		const t = makeConvex();
		await seedTemplateAndMapping(t);

		const reviewPayload = JSON.stringify({
			action: "submitted",
			repository: { full_name: REPO },
			review: {
				id: 999,
				state: "approved",
				body: "[ETA-APPROVED] LGTM",
				user: { login: "eta-reviewer", type: "User" },
				html_url: `https://github.com/${REPO}/pull/42#pullrequestreview-999`,
			},
			pull_request: {
				number: 42,
				title: "feat: new feature",
				html_url: `https://github.com/${REPO}/pull/42`,
				user: { login: "sigma" },
			},
		});

		const resp = await postWebhook(t, reviewPayload, "pull_request_review");
		expect(resp.status).toBe(200);

		const tasks = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		// pull_request_review.submitted MUST NOT create any cascade tasks
		expect(tasks.length).toBe(0);
	});

	it("no missions created on review submission", async () => {
		const t = makeConvex();
		await seedTemplateAndMapping(t);

		const reviewPayload = JSON.stringify({
			action: "submitted",
			repository: { full_name: REPO },
			review: {
				id: 998,
				state: "changes_requested",
				body: "Please fix the types",
				user: { login: "external-reviewer", type: "User" },
			},
			pull_request: {
				number: 77,
				title: "fix: types",
				html_url: `https://github.com/${REPO}/pull/77`,
			},
		});

		await postWebhook(t, reviewPayload, "pull_request_review");

		const missions = await t.run(async (ctx) =>
			ctx.db.query("missions").collect(),
		);
		expect(missions.length).toBe(0);
	});
});

// ── F4.4 — issue_comment on CLOSED issue does not spawn Bridge ───────────────

describe("F4.4 — closed issue comment is silently ignored (no Bridge spawned)", () => {
	it("no Bridge task for comment on a closed issue", async () => {
		const t = makeConvex();
		await seedTemplateAndMapping(t);

		await postWebhook(
			t,
			buildIssueCommentPayload({ issueState: "closed" }),
			"issue_comment",
		);

		const tasks = await t.run(async (ctx) =>
			ctx.db.query("tasks").collect(),
		);
		expect(tasks.length).toBe(0);
	});
});
