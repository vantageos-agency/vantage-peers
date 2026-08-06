/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// reviewTaskWebhookWiring.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Day 127 — the WIRING test, and the one that actually pins the bug.
//
// reviewTaskDedupClose.test.ts proves the two new mutations in convex/tasks.ts
// behave correctly when called. It does NOT prove convex/http.ts calls them.
//
// That distinction is the whole bug. The original defect was not a broken
// mutation — it was a handler that EXISTED (pull_request.closed, ~line 498) and
// simply never closed the review task. A suite that exercises mutations
// directly would have stayed green through the entire lifetime of that bug.
// Proving the mutations and calling it done would reproduce the exact failure
// being fixed, one level up.
//
// So this suite drives the real HTTP route (`POST /github/webhook`) with
// synthetic GitHub payloads, via convex-test's `t.fetch`, and asserts on the
// tasks table afterwards. Signature verification is skipped because
// GITHUB_WEBHOOK_SECRET is unset under test (see convex/http.ts:45).
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// The webhook resolves repo -> orchestrator/project via githubRepoMapping and
// returns "OK - unmapped repo" early when there is no active row (http.ts:90).
// Without this fixture every payload is a silent no-op, so the suite would be
// green-by-vacuum: nothing created, nothing asserted, nothing proven.
const createT = async () => {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert("githubRepoMapping", {
			repo: REPO,
			orchestrator: "sigma",
			project: "vantage-peers",
			active: true,
		});
		// The PR opened/synchronize handler notifies "eta" (hardcoded, http.ts)
		// and the merged-PR path notifies "sigma" (the mapped orchestrator) via
		// messages.sendMessage — real recipients are now derived from the
		// `profiles` table (task k17dr97dwpe07n9zfgzzypkfm18bv6ws bounce fix).
		await ctx.db.insert("profiles", {
			orchestratorId: "eta",
			name: "eta",
			static: { role: "eta", workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
		await ctx.db.insert("profiles", {
			orchestratorId: "sigma",
			name: "sigma",
			static: { role: "sigma", workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
	return t;
};

// The webhook writes tasks, and task writes schedule ragSync via runAfter.
// ragSync is excluded from `modules`, so on REAL timers those jobs fire after
// the test and reject as UNHANDLED errors — green assertions, red CI job.
// Fake timers keep the scheduler under test control.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const REPO = "vantageos-agency/vantage-peers";
const PR_NUMBER = 1073; // the PR that really did spawn 4 duplicate review tasks

const prPayload = (overrides: Record<string, unknown> = {}) => ({
	number: PR_NUMBER,
	title: "fix(ci): the publish workflow could never install its dependencies",
	html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
	user: { login: "elpiarthera" },
	head: { ref: "fix/ci-publish-deps" },
	...overrides,
});

const post = (
	t: Awaited<ReturnType<typeof createT>>,
	action: string,
	pull_request: Record<string, unknown>,
) =>
	t.fetch("/github/webhook", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-github-event": "pull_request",
		},
		body: JSON.stringify({
			action,
			pull_request,
			repository: { full_name: REPO },
		}),
	});

const reviewTasks = (t: Awaited<ReturnType<typeof createT>>) =>
	t.run(async (ctx) => {
		const all = await ctx.db.query("tasks").collect();
		return all.filter((task) => task.title.startsWith("[Review] "));
	});

describe("github webhook — [Review] task wiring (http.ts, not just the mutations)", () => {
	test("opened creates exactly one review task", async () => {
		const t = await createT();

		await post(t, "opened", prPayload());

		const tasks = await reviewTasks(t);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].title).toBe(
			`[Review] ${REPO} PR #${PR_NUMBER}: fix(ci): the publish workflow could never install its dependencies`,
		);
		expect(tasks[0].assignedTo).toBe("eta");
		expect(tasks[0].status).toBe("todo");
	});

	test("THE BUG: opened + 3 synchronize pushes yield ONE task, not four", async () => {
		const t = await createT();

		// This is the exact sequence that produced 4 live duplicates for PR #1073.
		await post(t, "opened", prPayload());
		await post(t, "synchronize", prPayload());
		await post(t, "synchronize", prPayload());
		await post(t, "synchronize", prPayload());

		const tasks = await reviewTasks(t);
		expect(tasks).toHaveLength(1);
		expect(tasks).not.toHaveLength(4);
	});

	test("THE BUG: closing a merged PR closes its review task — the handler ran and did nothing before", async () => {
		const t = await createT();
		await post(t, "opened", prPayload());
		expect(await reviewTasks(t)).toHaveLength(1);

		await post(t, "closed", prPayload({ merged: true, merged_at: "2026-07-11T12:00:00Z" }));

		const tasks = await reviewTasks(t);
		expect(tasks).toHaveLength(1); // still one row — closed, not deleted
		expect(tasks[0].status).toBe("done");
	});

	test("a PR closed WITHOUT merging also closes its review task — the review is moot either way", async () => {
		const t = await createT();
		await post(t, "opened", prPayload());

		await post(t, "closed", prPayload({ merged: false }));

		const tasks = await reviewTasks(t);
		expect(tasks[0].status).toBe("done");
	});

	test("closing one PR leaves another PR's review task open", async () => {
		const t = await createT();
		await post(t, "opened", prPayload());
		await post(t, "opened", prPayload({ number: 1080, title: "other PR" }));

		await post(t, "closed", prPayload({ merged: true }));

		const tasks = await reviewTasks(t);
		const closed = tasks.find((task) => task.title.includes(`#${PR_NUMBER}:`));
		const other = tasks.find((task) => task.title.includes("#1080:"));
		expect(closed?.status).toBe("done");
		expect(other?.status).toBe("todo");
	});

	test("regression control: two different PRs still produce two distinct review tasks", async () => {
		const t = await createT();

		await post(t, "opened", prPayload());
		await post(t, "opened", prPayload({ number: 1080, title: "other PR" }));

		expect(await reviewTasks(t)).toHaveLength(2);
	});
});
