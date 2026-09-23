/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorIssueDedup.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// RED-first coverage for the re-raise issue-duplication defect.
//
// Measured on live data: one errorLogs row (hash `detbs8`, function
// `recurringTasks:processDueTasks`) accumulated 18 occurrences and spawned
// FOUR GitHub issues (#1121, #1167, #1237, #1262) because `createGitHubIssue`
// unconditionally POSTs a new issue on every threshold-crossing re-raise, and
// `linkIssue` OVERWRITES `issueNumber` each time — the row can no longer even
// name the issues it spawned.
//
// Fix under test: a repeat occurrence that matches an errorLogs row whose
// `issueNumber` points at an issue that is STILL OPEN must COMMENT on that
// issue and create NOTHING. A distinct new error, or a repeat whose linked
// issue is CLOSED, still files a new issue. A failed open/closed check
// degrades toward noise (files a new issue), never toward silence.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

// ─────────────────────────────────────────────────────────────────────────────
// GitHub fetch mock — distinguishes the three endpoints createGitHubIssue's
// dedup check touches: GET issue state, POST a comment, POST a new issue.
// Mirrors the mock shape in issueClosedSweep.test.ts (same repo, same
// endpoint family) rather than inventing a new one.
// ─────────────────────────────────────────────────────────────────────────────

type IssueState = "open" | "closed" | "error";

function mockGitHubFetch(opts: {
	issueState?: Record<number, IssueState>;
	createReturnsNumber?: number;
}) {
	const calls: Array<{ url: string; method: string }> = [];
	const mockFn = vi
		.fn()
		.mockImplementation(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({ url, method });

			// GET .../issues/{number} — open/closed state check
			const stateMatch = url.match(/\/issues\/(\d+)$/);
			if (method === "GET" && stateMatch) {
				const num = parseInt(stateMatch[1], 10);
				const state = opts.issueState?.[num];
				if (state === undefined || state === "error") {
					return {
						ok: false,
						status: 500,
						json: async () => ({}),
						text: async () => "simulated GH API error",
					};
				}
				return { ok: true, status: 200, json: async () => ({ state }) };
			}

			// POST .../issues/{number}/comments — comment on an open issue
			const commentMatch = url.match(/\/issues\/(\d+)\/comments$/);
			if (method === "POST" && commentMatch) {
				return {
					ok: true,
					status: 201,
					json: async () => ({ id: 1 }),
					text: async () => "",
				};
			}

			// POST .../issues — create a new issue
			if (method === "POST" && url.endsWith("/issues")) {
				return {
					ok: true,
					status: 201,
					json: async () => ({ number: opts.createReturnsNumber ?? 9999 }),
					text: async () => "",
				};
			}

			return {
				ok: false,
				status: 404,
				json: async () => ({}),
				text: async () => "unhandled mock route",
			};
		});
	vi.stubGlobal("fetch", mockFn);
	return { mockFn, calls };
}

async function insertErrorLog(
	t: ReturnType<typeof createTestConvex>,
	overrides: Partial<{
		issueNumber: number;
		count: number;
		issueCreated: boolean;
	}> = {},
): Promise<Id<"errorLogs">> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert("errorLogs", {
			hash: "dedup-repro-hash",
			deployment: "prod",
			functionName: "recurringTasks:processDueTasks",
			errorMessage: "boom",
			firstSeen: now,
			lastSeen: now,
			count: overrides.count ?? 5,
			issueNumber: overrides.issueNumber,
			githubRepo: "elpiarthera/vantage-memory",
			issueCreated: overrides.issueCreated ?? overrides.issueNumber != null,
			issueHistory:
				overrides.issueNumber != null
					? [{ issueNumber: overrides.issueNumber, linkedAt: now }]
					: undefined,
		});
	});
}

beforeEach(() => {
	process.env.GITHUB_TOKEN = "test-token";
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.GITHUB_TOKEN;
});

describe("createGitHubIssue — repeat re-raise must not duplicate an open issue", () => {
	test("repeat occurrence + linked issue OPEN -> comments, creates nothing", async () => {
		const { mockFn, calls } = mockGitHubFetch({ issueState: { 1237: "open" } });
		const t = createTestConvex();
		const errorId = await insertErrorLog(t, { issueNumber: 1237, count: 18 });

		await t.action(internal.errorMonitorActions.createGitHubIssue, {
			errorId,
			githubRepo: "elpiarthera/vantage-memory",
			functionName: "recurringTasks:processDueTasks",
			errorMessage: "boom",
			stackTrace: "at x",
			deployment: "prod",
			orchestrator: "sigma",
		});

		// Zero creates: no POST to the bare .../issues create endpoint.
		const createCalls = calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/issues"),
		);
		expect(createCalls.length).toBe(0);

		// A comment WAS posted on the existing open issue.
		const commentCalls = calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/issues/1237/comments"),
		);
		expect(commentCalls.length).toBe(1);
		expect(mockFn).toHaveBeenCalled();

		// The row's issueNumber is unchanged — no new link overwrote it.
		const row = await t.run(async (ctx) => ctx.db.get(errorId));
		expect(row?.issueNumber).toBe(1237);
	});

	test("distinct new error (no prior issueNumber) -> creates, exactly as today", async () => {
		const { calls } = mockGitHubFetch({ createReturnsNumber: 4242 });
		const t = createTestConvex();
		const errorId = await insertErrorLog(t, { issueNumber: undefined, count: 3 });

		await t.action(internal.errorMonitorActions.createGitHubIssue, {
			errorId,
			githubRepo: "elpiarthera/vantage-memory",
			functionName: "recurringTasks:processDueTasks",
			errorMessage: "boom",
			stackTrace: "at x",
			deployment: "prod",
			orchestrator: "sigma",
		});

		const createCalls = calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/issues"),
		);
		expect(createCalls.length).toBe(1);

		const row = await t.run(async (ctx) => ctx.db.get(errorId));
		expect(row?.issueNumber).toBe(4242);
	});

	test("repeat occurrence + linked issue CLOSED -> creates a new issue", async () => {
		const { calls } = mockGitHubFetch({
			issueState: { 1121: "closed" },
			createReturnsNumber: 1300,
		});
		const t = createTestConvex();
		const errorId = await insertErrorLog(t, { issueNumber: 1121, count: 8 });

		await t.action(internal.errorMonitorActions.createGitHubIssue, {
			errorId,
			githubRepo: "elpiarthera/vantage-memory",
			functionName: "recurringTasks:processDueTasks",
			errorMessage: "boom",
			stackTrace: "at x",
			deployment: "prod",
			orchestrator: "sigma",
		});

		const createCalls = calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/issues"),
		);
		expect(createCalls.length).toBe(1);

		const row = await t.run(async (ctx) => ctx.db.get(errorId));
		expect(row?.issueNumber).toBe(1300);
		// History preserves the closed issue this row previously spawned.
		expect(row?.issueHistory?.map((h) => h.issueNumber)).toContain(1121);
		expect(row?.issueHistory?.map((h) => h.issueNumber)).toContain(1300);
	});

	test("open/closed check itself fails (network/API error) -> creates, fail-safe toward noise", async () => {
		const { calls } = mockGitHubFetch({
			issueState: { 1262: "error" },
			createReturnsNumber: 1301,
		});
		const t = createTestConvex();
		const errorId = await insertErrorLog(t, { issueNumber: 1262, count: 12 });

		await t.action(internal.errorMonitorActions.createGitHubIssue, {
			errorId,
			githubRepo: "elpiarthera/vantage-memory",
			functionName: "recurringTasks:processDueTasks",
			errorMessage: "boom",
			stackTrace: "at x",
			deployment: "prod",
			orchestrator: "sigma",
		});

		const createCalls = calls.filter(
			(c) => c.method === "POST" && c.url.endsWith("/issues"),
		);
		expect(createCalls.length).toBe(1);

		const row = await t.run(async (ctx) => ctx.db.get(errorId));
		expect(row?.issueNumber).toBe(1301);
	});
});
