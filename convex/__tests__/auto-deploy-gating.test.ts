/// <reference types="vite/client" />
//
// auto-deploy-gating.test.ts
//
// Covers the `auto-deploy-on-merge` gating logic in convex/http.ts.
//
// UPDATE (task k1739e72yrkx4twyj6gwr2x6818dfggk): the deploy-notice generator
// (`buildDeployTaskPayload` + its call site in the `/github/webhook` handler)
// has been REMOVED. It filed a task on "laurent" on every merged PR touching a
// deployable convex/ path — 176 dead rows since April, because PROD is
// token-gated on a token only the coordinator (Pi) holds, so the row was never
// actionable. The deploy decision belongs to the coordinator's merge
// authorization, not a separate notice.
//
// This suite now asserts the NEW end-state:
//   - A merged PR NEVER creates a "deploy"-tagged task, regardless of whether
//     the diff touches a deployable convex/ path (touchesConvex true/false/
//     unknown/fail-open-on-cap all converge on: no task).
//   - A merged PR NEVER sends a system notify message about an arbitrated
//     deploy decision.
//   - The pure predicate `prTouchesDeployableConvex()` (convex/githubDeployGate.ts)
//     SURVIVES unchanged — it still gates the diagnostic console.log branch in
//     convex/http.ts and is unit-tested directly in
//     convex/__tests__/githubDeployTaskGate.test.ts.
//
// Tests:
//   A — touchesConvex=true  → still NO deploy task (generator removed)
//   B — touchesConvex=false → still NO deploy task
//   C — fail-open on fetch error (throw / non-200 / no GITHUB_TOKEN) → NO task
//   D — pagination edge: 100-file cap hit, no convex/ on page 1 → NO task
//   E — PR #209 real payload (2 scripts + convex/tests/) → NO deploy task
//   F — convex/_generated only → NO deploy task
//   G — convex/__tests__ only → NO deploy task
//   H — deployable convex/ change → NO deploy task, NO system notify message

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
		await ctx.db.insert("profiles", {
			orchestratorId: "sigma",
			name: "sigma",
			static: { role: "sigma", workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
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
		return tasks.filter((task) => task.tags?.includes("deploy")).length;
	});
}

/**
 * Count "system" messages that mention a merged PR deploy notice.
 */
async function countDeployNotifyMessages(
	t: ReturnType<typeof makeTestConvex>,
) {
	return t.run(async (ctx) => {
		const messages = await ctx.db
			.query("messages")
			.withIndex("by_from", (q) => q.eq("from", "system"))
			.collect();
		return messages.filter(
			(m) =>
				m.content.includes(`PR #${PR_NUMBER}`) &&
				m.content.includes("PROD-DEPLOY-AUTHORIZED"),
		).length;
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

describe("auto-deploy-on-merge gating (http.ts) — generator removed", () => {
	test("A — files include convex/http.ts → still NO deploy task (generator removed)", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

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
		expect(countAfter).toBe(countBefore);
	});

	test("B — files contain no convex/ paths → NO deploy task", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

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
		expect(countAfter).toBe(countBefore);
	});

	test("C1 — fetch throws → NO deploy task (generator removed, no fail-open task)", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValueOnce(new Error("network timeout")),
		);

		const countBefore = await countDeployTasks(t);
		const response = await postWebhook(t, buildMergedPRPayload());

		expect(response.status).toBe(200);
		const countAfter = await countDeployTasks(t);
		expect(countAfter).toBe(countBefore);
	});

	test("C2 — GitHub API returns 403 → NO deploy task", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

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
		expect(countAfter).toBe(countBefore);
	});

	test("C3 — GITHUB_TOKEN unset → NO deploy task", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		delete process.env.GITHUB_TOKEN;

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const countBefore = await countDeployTasks(t);
		const response = await postWebhook(t, buildMergedPRPayload());

		expect(response.status).toBe(200);
		const countAfter = await countDeployTasks(t);
		expect(countAfter).toBe(countBefore);
	});

	test("D — page-1 cap hit (100 files, no convex/ match) → NO deploy task", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

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
		expect(countAfter).toBe(countBefore);
	});

	test("E — PR #209 real payload (2 scripts + convex/tests/) → NO deploy task", async () => {
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
		expect(countAfter).toBe(countBefore);
	});

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
		expect(countAfter).toBe(countBefore);
	});

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
		expect(countAfter).toBe(countBefore);
	});

	test("H — deployable convex/ change → NO deploy task AND NO system notify message (generator + notice fully removed)", async () => {
		const t = makeTestConvex();
		await seedRepoMapping(t);

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce({
				ok: true,
				json: async () => [{ filename: "convex/schema.ts" }],
			} as unknown as Response),
		);

		const taskCountBefore = await countDeployTasks(t);
		const notifyCountBefore = await countDeployNotifyMessages(t);

		const response = await postWebhook(t, buildMergedPRPayload());
		expect(response.status).toBe(200);

		const taskCountAfter = await countDeployTasks(t);
		const notifyCountAfter = await countDeployNotifyMessages(t);

		expect(
			taskCountAfter,
			"a merged PR touching a deployable convex/ path must NOT create a deploy task — the deploy decision belongs to the coordinator's merge authorization",
		).toBe(taskCountBefore);
		expect(
			notifyCountAfter,
			"a merged PR touching a deployable convex/ path must NOT send a system notify message about an arbitrated deploy decision",
		).toBe(notifyCountBefore);
	});
});
