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
});
