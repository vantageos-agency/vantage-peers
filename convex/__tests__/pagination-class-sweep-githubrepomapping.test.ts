/// <reference types="vite/client" />
//
// pagination-class-sweep-githubrepomapping.test.ts — TDD-RED for mission
// k574p02m lot 2. CLASS: cursor-anchor pagination bounded by a FIXED
// multiplier (`limit * 4 + 10`) instead of a wide-scan cap — same defect
// shape as businessUnits.list. convex/githubRepoMapping.ts:73-145 `list`.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

type RepoMappingRow = { _id: string; _creationTime: number; repo: string };

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

describe("githubRepoMapping.list cursor pagination — fixed-buffer fetchLimit undershoots deep pages", () => {
	test("RED/GREEN: paginating to the end must return every seeded repo mapping", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 130;
		const seededRepos: string[] = [];

		for (let i = 0; i < TOTAL; i++) {
			const repo = `sweep-org/repo-${i}`;
			seededRepos.push(repo);
			await t.mutation(api.githubRepoMapping.add, {
				repo,
				orchestrator: "sigma",
				project: "sweep-project",
			});
		}

		const collected: RepoMappingRow[] = [];
		let cursor: string | null = null;
		let pages = 0;
		while (pages < 20) {
			pages++;
			const page: { items: RepoMappingRow[]; nextCursor: string | null } = await t.query(
				api.githubRepoMapping.list,
				{ cursor: cursor ?? undefined },
			);
			collected.push(...page.items);
			if (page.nextCursor === null) break;
			cursor = page.nextCursor;
		}

		const collectedRepos = new Set(collected.map((r) => r.repo));
		const missing = seededRepos.filter((r) => !collectedRepos.has(r));
		expect(missing).toEqual([]);
		expect(collectedRepos.size).toBe(TOTAL);
	});

	// mission k574p02m lot 2 — Eta REVISE. The fetchLimit widening was gated
	// on `cursorPayload` only. The LEGACY `createdBefore` back-compat path
	// (no cursor arg) still falls through to `limit + 1` (narrow).
	test("RED/GREEN: legacy createdBefore pagination must return every seeded repo mapping", async () => {
		const t = convexTest(schema, modules);
		const TOTAL = 130;
		const seededRepos: string[] = [];

		for (let i = 0; i < TOTAL; i++) {
			const repo = `sweep-org/repo-legacy-${i}`;
			seededRepos.push(repo);
			await t.mutation(api.githubRepoMapping.add, {
				repo,
				orchestrator: "sigma",
				project: "sweep-project",
			});
		}

		const collected: RepoMappingRow[] = [];
		let createdBefore: number | undefined;
		let pages = 0;
		while (pages < 20) {
			pages++;
			const page: { items: RepoMappingRow[] } = await t.query(
				api.githubRepoMapping.list,
				{ createdBefore },
			);
			if (page.items.length === 0) break;
			collected.push(...page.items);
			createdBefore = page.items[page.items.length - 1]._creationTime;
		}

		const collectedRepos = new Set(collected.map((r) => r.repo));
		const missing = seededRepos.filter((r) => !collectedRepos.has(r));
		expect(missing).toEqual([]);
		expect(collectedRepos.size).toBe(TOTAL);
	});
});
