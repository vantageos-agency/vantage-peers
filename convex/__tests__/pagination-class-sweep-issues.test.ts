/// <reference types="vite/client" />
//
// pagination-class-sweep-issues.test.ts — TDD-RED for mission k574p02m lot 2.
// CLASS: `createdBefore` applied AFTER an unbounded `.take(limit)`.
// convex/issues.ts:262-289 `listByProject`, :296-332 `listByOrchestrator`,
// :338-360 `listByStatus`.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

type IssueRow = { _id: string; _creationTime: number; issueNumber: number };
type TestConvexT = ReturnType<typeof convexTest<typeof schema.tables>>;

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

async function seedIssues(
	t: TestConvexT,
	repo: string,
	orchestrator: string,
	total: number,
) {
	const numbers: number[] = [];
	for (let i = 0; i < total; i++) {
		const issueNumber = i + 1;
		numbers.push(issueNumber);
		await t.mutation(api.githubRepoMapping.add, {
			repo,
			orchestrator,
			project: repo,
		});
		await t.mutation(api.issues.upsertFromGitHub, {
			repo,
			issueNumber,
			title: `issue ${issueNumber}`,
			body: "body",
			htmlUrl: `https://example.invalid/${repo}/issues/${issueNumber}`,
			labels: [],
			status: "open",
			githubCreatedAt: Date.now(),
			githubUpdatedAt: Date.now(),
		});
	}
	return numbers;
}

describe("issues pagination — createdBefore applied after unbounded take", () => {
	test("RED/GREEN: listByProject paginating to the end must return every seeded issue", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 12;
		const PAGE_LIMIT = 5;
		const repo = "sweep/repo-a";
		const seededNumbers = await seedIssues(t, repo, "sigma", TOTAL);

		const collected: IssueRow[] = [];
		let createdBefore: number | undefined = undefined;
		let pages = 0;
		while (pages < 10) {
			pages++;
			const page: IssueRow[] = await t.query(api.issues.listByProject, {
				project: repo,
				limit: PAGE_LIMIT,
				createdBefore,
			});
			collected.push(...page);
			if (page.length < PAGE_LIMIT || page.length === 0) break;
			createdBefore = page[page.length - 1]._creationTime;
		}

		const collectedNumbers = new Set(collected.map((r) => r.issueNumber));
		const missing = seededNumbers.filter((n) => !collectedNumbers.has(n));
		expect(missing).toEqual([]);
		expect(collectedNumbers.size).toBe(TOTAL);
	});

	test("RED/GREEN: listByOrchestrator paginating to the end must return every seeded issue", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 12;
		const PAGE_LIMIT = 5;
		const repo = "sweep/repo-b";
		const orchestrator = "sweep-orch-b";
		const seededNumbers = await seedIssues(t, repo, orchestrator, TOTAL);

		const collected: IssueRow[] = [];
		let createdBefore: number | undefined = undefined;
		let pages = 0;
		while (pages < 10) {
			pages++;
			const page: IssueRow[] = await t.query(api.issues.listByOrchestrator, {
				assignedOrchestrator: orchestrator,
				limit: PAGE_LIMIT,
				createdBefore,
			});
			collected.push(...page);
			if (page.length < PAGE_LIMIT || page.length === 0) break;
			createdBefore = page[page.length - 1]._creationTime;
		}

		const collectedNumbers = new Set(collected.map((r) => r.issueNumber));
		const missing = seededNumbers.filter((n) => !collectedNumbers.has(n));
		expect(missing).toEqual([]);
		expect(collectedNumbers.size).toBe(TOTAL);
	});

	test("RED/GREEN: listByStatus paginating to the end must return every seeded issue", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 12;
		const PAGE_LIMIT = 5;
		const repo = "sweep/repo-c";
		const seededNumbers = await seedIssues(t, repo, "sweep-orch-c", TOTAL);

		const collected: IssueRow[] = [];
		let createdBefore: number | undefined = undefined;
		let pages = 0;
		while (pages < 10) {
			pages++;
			const page: IssueRow[] = await t.query(api.issues.listByStatus, {
				status: "open",
				limit: PAGE_LIMIT,
				createdBefore,
			});
			const relevant = page.filter((r) => seededNumbers.includes(r.issueNumber));
			collected.push(...relevant);
			if (page.length < PAGE_LIMIT || page.length === 0) break;
			createdBefore = page[page.length - 1]._creationTime;
		}

		const collectedNumbers = new Set(collected.map((r) => r.issueNumber));
		const missing = seededNumbers.filter((n) => !collectedNumbers.has(n));
		expect(missing).toEqual([]);
		expect(collectedNumbers.size).toBe(TOTAL);
	});
});
