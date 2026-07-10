/// <reference types="vite/client" />
//
// auto-deploy-gating.test.ts
//
// Covers the `auto-deploy-on-merge` gating logic in convex/http.ts:
// the `/github/webhook` httpAction only spawns a deploy task when the
// merged PR touched at least one `convex/` file.
//
// Strategy chosen: SHORT-CIRCUIT + FAIL-OPEN ON CAP (Day 102 follow-up,
// task k1728cdf6n86svsxc8absakfgd88nbz4).
//
// Tests:
//   A — touchesConvex=true  → deploy task created
//   B — touchesConvex=false → deploy task NOT created (skipped)
//   C — fail-open on fetch error (throw / non-200 / no GITHUB_TOKEN)
//   D — pagination edge: 100-file cap hit, no convex/ on page 1 → fail-open (task created)
//
// NOTE (Eta PR #1068 REVISE, Day-10x): A/B/C/D do NOT discriminate the pure
// `prTouchesDeployableConvex()` predicate (convex/githubDeployGate.ts, approved,
// do not touch) from the OLD inline predicate it replaced in convex/http.ts —
// both predicates agree on every file path used above (convex/http.ts → true,
// docs/mcp-server paths → false). The two predicates only diverge on paths like
// convex/tests/, convex/__tests__/, convex/_generated/ — exactly the gap tests
// E/F/G close. Tests H/I additionally re-pin the task-payload wiring
// (priority/assignedTo/title/description, and the no-paste-ready-command
// notify message) against silent mutation of the createDeployTaskWithDedup
// call args in convex/http.ts.
//
//   E — PR #209 real payload (2 scripts + convex/tests/) → no deploy task
//   F — convex/_generated only → no deploy task
//   G — convex/__tests__ only → no deploy task
//   H — deployable convex/ change → task payload wiring (priority/assignedTo/
//       title/description) matches githubDeployGate.ts, no command re-injection
//   I — notify message carries no paste-ready deploy command

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";

// Exclude RAG/search/backfill modules (same pattern as sibling tests)
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// ─── Constants ────────────────────────────────────────────────────────────────

const REPO = "elpiarthera/vantage-memory";
const PR_NUMBER = 999;
const PR_URL = `https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}`;
const GITHUB_TOKEN = "ghp_test_token_abc123";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTestConvex() {
	return convexTest(schema, modules);
}

/**
 * Seed a githubRepoMapping row so the webhook handler routes the event.
 */
async function seedRepoMapping(t: ReturnType<typeof makeTestConvex>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("githubRepoMapping", {
			repo: REPO,
			orchestrator: "sigma",
			project: "vantage-memory",
			active: true,
		});
	});
}

/**
 * Build a minimal `pull_request` closed+merged webhook payload.
 */
function buildMergedPRPayload(prUrlOverride?: string) {
	return JSON.stringify({
		action: "closed",
		repository: { full_name: REPO },
		pull_request: {
			number: PR_NUMBER,
			title: "test PR for gating",
			html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
			url: prUrlOverride ?? PR_URL,
			merged: true,
			merged_at: new Date().toISOString(),
			merged_by: { login: "sigma" },
			head: { ref: "feature/test" },
			user: { login: "sigma" },
		},
	});
}

/**
 * POST the webhook payload and return the Response.
 */
async function postWebhook(
	t: ReturnType<typeof makeTestConvex>,
	body: string,
) {
	return t.fetch("/github/webhook", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-github-event": "pull_request",
		},
		body,
	});
}

/**
 * Count deploy tasks currently in the DB.
 */
async function countDeployTasks(t: ReturnType<typeof makeTestConvex>) {
	return t.run(async (ctx) => {
		const tasks = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", "todo"))
			.collect();
		return tasks.filter((task) =>
			task.tags?.includes("deploy"),
		).length;
	});
}

/**
 * Return the single "deploy"-tagged task row, or null if none exists.
 */
async function getDeployTask(t: ReturnType<typeof makeTestConvex>) {
	return t.run(async (ctx) => {
		const tasks = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", "todo"))
			.collect();
		const deployTasks = tasks.filter((task) => task.tags?.includes("deploy"));
		return deployTasks.length > 0 ? deployTasks[0] : null;
	});
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
	// Provide a GITHUB_TOKEN so the gating logic attempts to fetch file list
	process.env.GITHUB_TOKEN = GITHUB_TOKEN;
	// Suppress GITHUB_WEBHOOK_SECRET so signature check is skipped in tests
	delete process.env.GITHUB_WEBHOOK_SECRET;
});

afterEach(() => {
	delete process.env.GITHUB_TOKEN;
	vi.restoreAllMocks();
});

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("auto-deploy-on-merge gating (http.ts)", () => {
	// ── Test A — touchesConvex=true → deploy task created ─────────────────────

	test("A — files include convex/http.ts → deploy task created", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		// Mock GitHub files API: returns convex/ file
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: true,
				json: async () => [
					{ filename: "convex/http.ts" },
					{ filename: "README.md" },
				],
			} as unknown as Response),
		);

		const countBefore = await countDeployTasks(t);
		const response = await postWebhook(t, buildMergedPRPayload());

		expect(response.status).toBe(200);
		const countAfter = await countDeployTasks(t);
		expect(countAfter).toBe(countBefore + 1);
	});

	// ── Test B — touchesConvex=false → deploy task NOT created ────────────────

	test("B — files contain no convex/ paths → deploy task skipped", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		// Mock GitHub files API: no convex/ files, count < 100 (complete list)
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: true,
				json: async () => [
					{ filename: "README.md" },
					{ filename: "docs/guide.md" },
					{ filename: "mcp-server/src/index.ts" },
				],
			} as unknown as Response),
		);

		const countBefore = await countDeployTasks(t);
		const response = await postWebhook(t, buildMergedPRPayload());

		expect(response.status).toBe(200);
		const countAfter = await countDeployTasks(t);
		// No new deploy task — gate correctly blocked it
		expect(countAfter).toBe(countBefore);
	});

	// ── Test C — fail-open on fetch error ─────────────────────────────────────
	//   Covers three sub-cases: fetch throws, non-200 response, no GITHUB_TOKEN.
	//   In all cases the handler must fall back to creating the deploy task.

	test("C1 — fetch throws → fail-open (deploy task created)", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		// Mock fetch to throw a network error
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValueOnce(new Error("network timeout")),
		);

		const countBefore = await countDeployTasks(t);
		const response = await postWebhook(t, buildMergedPRPayload());

		expect(response.status).toBe(200);
		const countAfter = await countDeployTasks(t);
		expect(countAfter).toBe(countBefore + 1);
	});

	test("C2 — GitHub API returns 403 → fail-open (deploy task created)", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		// Mock fetch returning a non-200 HTTP error
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: false,
				status: 403,
			} as unknown as Response),
		);

		const countBefore = await countDeployTasks(t);
		const response = await postWebhook(t, buildMergedPRPayload());

		expect(response.status).toBe(200);
		const countAfter = await countDeployTasks(t);
		expect(countAfter).toBe(countBefore + 1);
	});

	test("C3 — GITHUB_TOKEN unset → fail-open (deploy task created)", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		// Remove GITHUB_TOKEN so the handler skips the fetch entirely
		delete process.env.GITHUB_TOKEN;

		// fetch should NOT be called when token is missing
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const countBefore = await countDeployTasks(t);
		const response = await postWebhook(t, buildMergedPRPayload());

		expect(response.status).toBe(200);
		const countAfter = await countDeployTasks(t);
		// Fail-open: no token → touchesConvex stays null → task created
		expect(countAfter).toBe(countBefore + 1);
	});

	// ── Test D — pagination edge: 100-file cap hit, no convex/ on page 1 ──────
	//   Preferred strategy: FAIL-OPEN ON CAP.
	//   When the API returns exactly per_page (100) files and none match convex/,
	//   there may be more pages — we must NOT skip the deploy.

	test("D — page-1 cap hit (100 files, no convex/ match) → fail-open (deploy task created)", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		// Generate exactly 100 non-convex files (cap hit)
		const nonConvexFiles = Array.from({ length: 100 }, (_, i) => ({
			filename: `mcp-server/src/module-${i}.ts`,
		}));

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: true,
				json: async () => nonConvexFiles,
			} as unknown as Response),
		);

		const countBefore = await countDeployTasks(t);
		const response = await postWebhook(t, buildMergedPRPayload());

		expect(response.status).toBe(200);
		const countAfter = await countDeployTasks(t);
		// Cap hit → unknown whether convex/ files exist on later pages →
		// fail-open: deploy task must be created.
		expect(countAfter).toBe(countBefore + 1);
	});

	// ── Test E — PR #209-shaped payload → no deploy task ──────────────────────
	//   Kills the inline-predicate mutant reintroduced in convex/http.ts:
	//   the OLD `files.some(f => /^convex\//.test(...) || /^apps\/[^/]+\/convex\//.test(...))`
	//   predicate matches nothing here (no `convex/tests/` special-case), so it
	//   would wrongly return false too — but the new predicate's job is to also
	//   correctly EXCLUDE convex/tests/ from "deployable convex change". Either
	//   way, this real-world payload must not create a deploy task.

	test("E — PR #209 real payload (2 scripts + convex/tests/) → NO deploy task (kills the inline-predicate mutant in http.ts)", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: true,
				json: async () => [
					{ filename: "scripts/uc1/joeai-csv-interne.cjs" },
					{ filename: "scripts/uc1/lib/joeai-csv-lib.cjs" },
					{ filename: "convex/tests/uc1/joeai_csv.test.ts" },
				],
			} as unknown as Response),
		);

		const countBefore = await countDeployTasks(t);
		const response = await postWebhook(t, buildMergedPRPayload());

		expect(response.status).toBe(200);
		const countAfter = await countDeployTasks(t);
		expect(
			countAfter,
			"convex/http.ts wiring must call prTouchesDeployableConvex(), not the old inline predicate — " +
				"a real PR #209-shaped diff (scripts/ + convex/tests/) must NOT spawn a deploy task",
		).toBe(countBefore);
	});

	// ── Test F — convex/_generated only → no deploy task ──────────────────────

	test("F — convex/_generated only → NO deploy task", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: true,
				json: async () => [{ filename: "convex/_generated/api.d.ts" }],
			} as unknown as Response),
		);

		const countBefore = await countDeployTasks(t);
		const response = await postWebhook(t, buildMergedPRPayload());

		expect(response.status).toBe(200);
		const countAfter = await countDeployTasks(t);
		expect(
			countAfter,
			"convex/http.ts wiring: a convex/_generated/-only diff must NOT spawn a deploy task",
		).toBe(countBefore);
	});

	// ── Test G — convex/__tests__ only → no deploy task ───────────────────────

	test("G — convex/__tests__ only → NO deploy task", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: true,
				json: async () => [{ filename: "convex/__tests__/foo.test.ts" }],
			} as unknown as Response),
		);

		const countBefore = await countDeployTasks(t);
		const response = await postWebhook(t, buildMergedPRPayload());

		expect(response.status).toBe(200);
		const countAfter = await countDeployTasks(t);
		expect(
			countAfter,
			"convex/http.ts wiring: a convex/__tests__/-only diff must NOT spawn a deploy task",
		).toBe(countBefore);
	});

	// ── Test H — deployable convex/ change → payload wiring ───────────────────
	//   Kills payload mutants in convex/http.ts: priority urgent->medium,
	//   assignedTo -> orchestratorAssignee, and command re-injection into
	//   the task description.

	test("H — deployable convex/ change → task is medium, assigned to a HUMAN, with no paste-ready deploy command (kills the payload mutants in http.ts)", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: true,
				json: async () => [{ filename: "convex/schema.ts" }],
			} as unknown as Response),
		);

		const response = await postWebhook(t, buildMergedPRPayload());
		expect(response.status).toBe(200);

		const task = await getDeployTask(t);
		expect(task, "a deploy task must exist for a convex/schema.ts change").not.toBeNull();
		if (!task) throw new Error("unreachable — asserted above");

		expect(
			task.priority,
			"convex/http.ts wiring must forward buildDeployTaskPayload().priority (medium), not re-derive urgent/high",
		).toBe("medium");
		expect(
			task.assignedTo,
			"convex/http.ts wiring must forward buildDeployTaskPayload().assignedTo ('laurent'), not orchestratorAssignee (M7 mutant)",
		).toBe("laurent");
		expect(
			task.title,
			"convex/http.ts wiring must forward the [Deploy?] title from buildDeployTaskPayload()",
		).toMatch(/^\[Deploy\?\] PR #\d+ merged/);
		expect(
			task.description,
			"convex/http.ts wiring must NOT re-inject a paste-ready `npx convex deploy` command into the task description",
		).not.toMatch(/npx convex deploy/);
		expect(
			task.description,
			"convex/http.ts wiring must NOT re-inject a paste-ready `git checkout main` command into the task description",
		).not.toMatch(/git checkout main/);
		expect(
			task.description,
			"convex/http.ts wiring must preserve the PROD-DEPLOY-AUTHORIZED token-gate language from buildDeployTaskPayload()",
		).toMatch(/PROD-DEPLOY-AUTHORIZED/);
	});

	// ── Test I — notify message carries no paste-ready deploy command ─────────

	test("I — the notify message carries no paste-ready deploy command", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: true,
				json: async () => [{ filename: "convex/schema.ts" }],
			} as unknown as Response),
		);

		const response = await postWebhook(t, buildMergedPRPayload());
		expect(response.status).toBe(200);

		const systemMessages = await t.run(async (ctx) => {
			return ctx.db
				.query("messages")
				.withIndex("by_from", (q) => q.eq("from", "system"))
				.collect();
		});

		expect(
			systemMessages.length,
			"a system notify message must be sent for a convex/schema.ts merged PR",
		).toBeGreaterThan(0);

		const notifyMessage = systemMessages.find((m) =>
			m.content.includes(`PR #${PR_NUMBER}`),
		);
		expect(
			notifyMessage,
			"the notify message for this PR must exist in the messages table",
		).toBeDefined();
		if (!notifyMessage) throw new Error("unreachable — asserted above");

		expect(
			notifyMessage.content,
			"convex/http.ts wiring must NOT re-inject a paste-ready `npx convex deploy` command into the notify message",
		).not.toMatch(/npx convex deploy/);
		expect(
			notifyMessage.content,
			"the notify message must mention the PROD-DEPLOY-AUTHORIZED token gate",
		).toMatch(/PROD-DEPLOY-AUTHORIZED/);
	});
});
