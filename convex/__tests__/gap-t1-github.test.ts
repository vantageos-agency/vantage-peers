/// <reference types="vite/client" />
//
// GAP-T1 (D90 ship-blocker) — direct behavioral tests for GitHub-integration
// tools (4 of the 19):
//
//   12. verify_issue          → convex/issues.ts :: verify (mutation)
//   13. link_commit_to_issue  → convex/issues.ts :: linkCommit (mutation)
//   14. issue_stats           → convex/issues.ts :: getStats (query)
//   15. link_issue_to_pattern → convex/fixPatterns.ts :: linkIssue (mutation)
//
// Orchestrator: Sigma — VantagePeers | 2026-06-19

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

async function seedIssue(
	t: ReturnType<typeof createTestConvex>,
	opts: {
		repo?: string;
		issueNumber?: number;
		status?: "open" | "in_progress" | "fixed" | "verified" | "closed";
		project?: string;
	} = {},
) {
	const repo = opts.repo ?? "elpiarthera/vantage-memory";
	const issueNumber = opts.issueNumber ?? 999;
	await t.run(async (ctx) => {
		await ctx.db.insert("issues", {
			repo,
			issueNumber,
			title: "GAP-T1 fixture",
			body: "test fixture",
			htmlUrl: `https://github.com/${repo}/issues/${issueNumber}`,
			labels: ["test"],
			status: opts.status ?? "fixed",
			priority: "medium",
			assignedOrchestrator: "sigma",
			project: opts.project ?? "vantage-memory",
			githubCreatedAt: Date.now() - 60_000,
			githubUpdatedAt: Date.now(),
		});
	});
	return { repo, issueNumber };
}

// ─────────────────────────────────────────────────────────────────────────────
// verify_issue
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 verify_issue — issues.verify mutation", () => {
	test("happy path — flips status to 'verified' and stamps verifiedBy/verifiedAt", async () => {
		const t = createTestConvex();
		const { repo, issueNumber } = await seedIssue(t, { status: "fixed" });

		await t.mutation(api.issues.verify, {
			repo,
			issueNumber,
			verifiedBy: "eta",
		});

		const row = await t.query(api.issues.getByRepoNumber, {
			repo,
			issueNumber,
		});
		expect(row?.status).toBe("verified");
		expect(row?.verifiedBy).toBe("eta");
		expect(row?.verifiedAt).toBeGreaterThan(0);
	});

	test("edge case — verifying an unknown issue throws", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.issues.verify, {
				repo: "elpiarthera/does-not-exist",
				issueNumber: 1,
				verifiedBy: "eta",
			}),
		).rejects.toThrow(/not found/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// link_commit_to_issue
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 link_commit_to_issue — issues.linkCommit mutation", () => {
	test("happy path — appends SHA to fixCommits + sets fixedBy/fixedAt", async () => {
		const t = createTestConvex();
		const { repo, issueNumber } = await seedIssue(t, { status: "open" });

		await t.mutation(api.issues.linkCommit, {
			repo,
			issueNumber,
			commitSha: "abe9936f0c133c5f5b5c5f5b5c5f5b5c5f5b5c5f",
			fixedBy: "sigma",
		});

		const row = await t.query(api.issues.getByRepoNumber, {
			repo,
			issueNumber,
		});
		expect(row?.fixCommits).toContain(
			"abe9936f0c133c5f5b5c5f5b5c5f5b5c5f5b5c5f",
		);
		expect(row?.fixedBy).toBe("sigma");
		expect(row?.fixedAt).toBeGreaterThan(0);
	});

	test("edge case — second linkCommit appends without overwriting first", async () => {
		const t = createTestConvex();
		const { repo, issueNumber } = await seedIssue(t);

		await t.mutation(api.issues.linkCommit, {
			repo,
			issueNumber,
			commitSha: "aaa1111",
			fixedBy: "sigma",
		});
		await t.mutation(api.issues.linkCommit, {
			repo,
			issueNumber,
			commitSha: "bbb2222",
			fixedBy: "sigma",
		});

		const row = await t.query(api.issues.getByRepoNumber, {
			repo,
			issueNumber,
		});
		expect(row?.fixCommits).toEqual(["aaa1111", "bbb2222"]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// issue_stats
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 issue_stats — issues.getStats query", () => {
	test("happy path — rolls up counts by status for a project", async () => {
		const t = createTestConvex();
		await seedIssue(t, { issueNumber: 1, status: "open", project: "vp" });
		await seedIssue(t, { issueNumber: 2, status: "open", project: "vp" });
		await seedIssue(t, { issueNumber: 3, status: "fixed", project: "vp" });
		await seedIssue(t, { issueNumber: 4, status: "closed", project: "vp" });
		await seedIssue(t, { issueNumber: 5, status: "open", project: "other" });

		const stats = await t.query(api.issues.getStats, { project: "vp" });
		expect(stats.open).toBe(2);
		expect(stats.fixed).toBe(1);
		expect(stats.closed).toBe(1);
		expect(stats.total).toBe(4); // "other" excluded
	});

	test("edge case — empty project returns zeroed buckets", async () => {
		const t = createTestConvex();
		const stats = await t.query(api.issues.getStats, {
			project: "no-such-project",
		});
		expect(stats.total).toBe(0);
		expect(stats.open).toBe(0);
		expect(stats.verified).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// link_issue_to_pattern
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 link_issue_to_pattern — fixPatterns.linkIssue mutation", () => {
	test("happy path — appends issueId to pattern.linkedIssueIds", async () => {
		const t = createTestConvex();
		const patternId = await t.mutation(api.fixPatterns.create, {
			symptom: "deploy fails on schema drift",
			rootCause: "stale generated types",
			tags: ["convex", "schema"],
			stack: ["convex"],
			sourceProject: "vantage-memory",
			createdBy: "sigma",
			severity: "major",
		});

		await t.mutation(api.fixPatterns.linkIssue, {
			patternId,
			issueId: "issue#777",
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(patternId);
			expect(row?.linkedIssueIds).toContain("issue#777");
		});

		await t.finishInProgressScheduledFunctions();
	});

	test("edge case — linking same issueId twice is idempotent (no duplicate)", async () => {
		const t = createTestConvex();
		const patternId = await t.mutation(api.fixPatterns.create, {
			symptom: "x",
			rootCause: "y",
			tags: [],
			stack: [],
			sourceProject: "vantage-memory",
			createdBy: "sigma",
			severity: "minor",
		});

		await t.mutation(api.fixPatterns.linkIssue, {
			patternId,
			issueId: "issue#42",
		});
		await t.mutation(api.fixPatterns.linkIssue, {
			patternId,
			issueId: "issue#42",
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(patternId);
			const matches = (row?.linkedIssueIds ?? []).filter(
				(id) => id === "issue#42",
			);
			expect(matches.length).toBe(1);
		});

		await t.finishInProgressScheduledFunctions();
	});
});
