// Bug #1134 — okfBundle IMPORT dedup helpers unbounded `.collect()` fix.
//
// The three dedup helpers `_findMemoryByContent`, `_findBriefingByTitleAndContent`,
// `_findTaskByTitleAndDescription` (convex/okfBundle.ts) used to run
// `ctx.db.query(...).withIndex(...).collect()` over the ENTIRE index range in
// one execution, then `.find()` in memory. That is unbounded — a large
// namespace/table blows past the Convex 16 MB single-execution read ceiling
// and crashes the import mid-pipeline.
//
// Fix: each helper now returns ONE bounded page (`BUNDLE_PAGE_SIZE` rows) via
// `.paginate()`, mirroring the already-fixed EXPORT path
// (`_fetchMemoriesForBundle` et al.). The Node-runtime caller
// (`findExistingIdByPaginating` in okfBundleNode.ts) drives the cursor loop
// across separate bounded executions and short-circuits on first match.
//
// TDD RULE #12 — this file contains GREEN correctness + bound tests only. It
// asserts the NEW helper never returns more than one page's worth of rows
// per execution AND correctness (match found → correct _id, no match →
// null) is preserved. It does NOT contain a RED test: the RED case (the OLD
// unbounded `.collect()` behavior reading the whole index range in one call)
// was proven externally against the pre-fix code via `git stash` + manual
// re-run, not as a persisted test in this file — `convex-test` cannot
// literally reproduce the production 16 MB execution-ceiling crash the old
// code was vulnerable to (see honesty note below), so there is no reliable
// automated RED assertion to keep here.
//
// Also included: an explicit negative test documenting that the
// briefing/task dedup predicates are NOT namespace-scoped (a known,
// pre-existing gap tracked separately — NOT fixed in this PR). See the
// "cross-namespace dedup scope" describe block below.
//
// Honesty note on harness limits: `convex-test` does not enforce the real
// Convex 16 MB execution ceiling (there is no in-memory OOM at this scale),
// so no test in this file can literally reproduce a production crash. What
// the GREEN suite below CAN and DOES prove, mechanically: the NEW helper
// caps each single call to `paginationOpts.numItems` rows regardless of
// table size, which is the structural fix for the 16 MB risk (bounded reads
// per execution, short-circuited by the caller on match).
//
// Mission: k5779qbxhwrfjmj02t31yvehns8911jp. Bug: #1134.
// Orchestrator: Sigma — VantagePeers | 2026-08-03

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { BUNDLE_PAGE_SIZE } from "../okfBundle";
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

const createTestConvex = () => convexTest(schema, modules);

interface DedupPage {
	id: string | null;
	isDone: boolean;
	continueCursor: string;
}

const NOW = 1_700_000_000_000;

async function seedMemories(t: ReturnType<typeof createTestConvex>, n: number) {
	await t.run(async (ctx) => {
		for (let i = 0; i < n; i++) {
			await ctx.db.insert("memories", {
				namespace: "project/elpi-corp",
				type: "reference",
				content: `memory body #${i}`,
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: NOW,
				updatedAt: NOW,
			});
		}
	});
}

async function seedBriefings(t: ReturnType<typeof createTestConvex>, n: number) {
	await t.run(async (ctx) => {
		for (let i = 0; i < n; i++) {
			await ctx.db.insert("briefingNotes", {
				title: `briefing #${i}`,
				topic: "dedup-bound-test",
				participants: ["sigma"],
				content: `briefing body #${i}`,
				createdBy: "sigma",
				createdAt: NOW,
			});
		}
	});
}

async function seedTasks(t: ReturnType<typeof createTestConvex>, n: number) {
	await t.run(async (ctx) => {
		for (let i = 0; i < n; i++) {
			await ctx.db.insert("tasks", {
				title: `task #${i}`,
				description: `task description #${i}`,
				assignedTo: "sigma",
				priority: "medium",
				status: "todo",
				createdBy: "sigma",
				createdAt: NOW,
				updatedAt: NOW,
			});
		}
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// GREEN — new helper bounds a single call to `paginationOpts.numItems`.
// ─────────────────────────────────────────────────────────────────────────────

describe("Bug #1134 — dedup helpers bounded page reads", () => {
	test("_findMemoryByContent: single call never exceeds requested page size, regardless of table size", async () => {
		const t = createTestConvex();
		const rowCount = BUNDLE_PAGE_SIZE * 3 + 17; // spans multiple pages
		await seedMemories(t, rowCount);

		const page = await t.query(internal.okfBundle._findMemoryByContent, {
			namespace: "project/elpi-corp",
			content: "no-match-content",
			paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor: null },
		});

		// The old `.collect()` implementation would have read all `rowCount`
		// rows in this one call. The new implementation is capped to one page
		// and reports isDone:false because more rows remain.
		expect(page.isDone).toBe(false);
		expect(page.id).toBe(null);
		expect(typeof page.continueCursor).toBe("string");
	});

	test("_findMemoryByContent: match found on a later page via cursor loop, correct _id returned", async () => {
		const t = createTestConvex();
		await seedMemories(t, BUNDLE_PAGE_SIZE + 5); // filler spans 2 pages
		const targetId = await t.run(async (ctx) =>
			ctx.db.insert("memories", {
				namespace: "project/elpi-corp",
				type: "reference",
				content: "THE TARGET CONTENT",
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: NOW,
				updatedAt: NOW,
			}),
		);

		// Drive the cursor loop exactly like `findExistingIdByPaginating()` does.
		let cursor: string | null = null;
		let found: string | null = null;
		for (let hop = 0; hop < 100; hop++) {
			const page: DedupPage = await t.query(internal.okfBundle._findMemoryByContent, {
				namespace: "project/elpi-corp",
				content: "THE TARGET CONTENT",
				paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor },
			});
			if (page.id !== null) {
				found = page.id;
				break;
			}
			if (page.isDone) break;
			cursor = page.continueCursor;
		}

		expect(found).toBe(targetId);
	});

	test("_findMemoryByContent: no match after full scan returns null and isDone:true on last page", async () => {
		const t = createTestConvex();
		await seedMemories(t, 5);

		let cursor: string | null = null;
		let found: string | null = null;
		let sawDone = false;
		for (let hop = 0; hop < 100; hop++) {
			const page: DedupPage = await t.query(internal.okfBundle._findMemoryByContent, {
				namespace: "project/elpi-corp",
				content: "does-not-exist",
				paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor },
			});
			if (page.id !== null) {
				found = page.id;
				break;
			}
			if (page.isDone) {
				sawDone = true;
				break;
			}
			cursor = page.continueCursor;
		}

		expect(found).toBe(null);
		expect(sawDone).toBe(true);
	});

	test("_findMemoryByContent: namespace scope is preserved — a matching content in a DIFFERENT namespace is not returned", async () => {
		const t = createTestConvex();
		await t.run(async (ctx) => {
			await ctx.db.insert("memories", {
				namespace: "project/other-tenant",
				type: "reference",
				content: "SHARED CONTENT STRING",
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: NOW,
				updatedAt: NOW,
			});
		});

		const page = await t.query(internal.okfBundle._findMemoryByContent, {
			namespace: "project/elpi-corp",
			content: "SHARED CONTENT STRING",
			paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor: null },
		});

		expect(page.id).toBe(null);
		expect(page.isDone).toBe(true);
	});

	test("_findBriefingByTitleAndContent: bounded page + correct match by title+content", async () => {
		const t = createTestConvex();
		const rowCount = BUNDLE_PAGE_SIZE * 2 + 3;
		await seedBriefings(t, rowCount);
		const targetId = await t.run(async (ctx) =>
			ctx.db.insert("briefingNotes", {
				title: "Target Briefing",
				topic: "dedup-bound-test",
				participants: ["sigma"],
				content: "Target briefing body.",
				createdBy: "sigma",
				createdAt: NOW,
			}),
		);

		// First page alone must not exceed the requested page size (bounded read).
		const firstPage = await t.query(
			internal.okfBundle._findBriefingByTitleAndContent,
			{
				title: "Target Briefing",
				content: "Target briefing body.",
				paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor: null },
			},
		);
		expect(firstPage.isDone).toBe(false); // rowCount spans > 1 page

		let cursor: string | null = null;
		let found: string | null = null;
		for (let hop = 0; hop < 100; hop++) {
			const page: DedupPage = await t.query(
				internal.okfBundle._findBriefingByTitleAndContent,
				{
					title: "Target Briefing",
					content: "Target briefing body.",
					paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor },
				},
			);
			if (page.id !== null) {
				found = page.id;
				break;
			}
			if (page.isDone) break;
			cursor = page.continueCursor;
		}
		expect(found).toBe(targetId);
	});

	test("_findTaskByTitleAndDescription: bounded page + correct match by title+description", async () => {
		const t = createTestConvex();
		const rowCount = BUNDLE_PAGE_SIZE * 2 + 3;
		await seedTasks(t, rowCount);
		const targetId = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "Target Task",
				description: "Target task description.",
				assignedTo: "sigma",
				priority: "medium",
				status: "todo",
				createdBy: "sigma",
				createdAt: NOW,
				updatedAt: NOW,
			}),
		);

		const firstPage = await t.query(
			internal.okfBundle._findTaskByTitleAndDescription,
			{
				title: "Target Task",
				description: "Target task description.",
				paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor: null },
			},
		);
		expect(firstPage.isDone).toBe(false); // rowCount spans > 1 page

		let cursor: string | null = null;
		let found: string | null = null;
		for (let hop = 0; hop < 100; hop++) {
			const page: DedupPage = await t.query(
				internal.okfBundle._findTaskByTitleAndDescription,
				{
					title: "Target Task",
					description: "Target task description.",
					paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor },
				},
			);
			if (page.id !== null) {
				found = page.id;
				break;
			}
			if (page.isDone) break;
			cursor = page.continueCursor;
		}
		expect(found).toBe(targetId);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Known gap — briefing/task dedup is NOT namespace/tenant scoped.
//
// Unlike `_findMemoryByContent` (which takes a `namespace` arg and filters
// on it), `_findBriefingByTitleAndContent` and `_findTaskByTitleAndDescription`
// take no namespace/tenant argument at all — they scan `briefingNotes` /
// `tasks` globally via `by_topic` / `by_status` indexes. This is a
// PRE-EXISTING cross-tenant side channel, OUT OF SCOPE for this PR (#1134
// only bounds the reads; it does not add scoping to the predicate). This
// test documents the gap explicitly so the current behavior is a verified,
// intentional state rather than an implicit assumption. A follow-up ticket
// tracks adding tenant scoping to these two predicates — do NOT change the
// predicate here.
// ─────────────────────────────────────────────────────────────────────────────

describe("KNOWN GAP — briefing/task dedup predicates are not namespace-scoped (pre-existing, out of scope for #1134)", () => {
	test("_findBriefingByTitleAndContent: matches a title+content pair regardless of which 'tenant' inserted it (no namespace arg exists to scope by)", async () => {
		const t = createTestConvex();
		// Simulate two different "tenants" by varying an unrelated field
		// (topic) — there is no namespace/ownerId field on briefingNotes for
		// this predicate to scope on in the first place.
		const tenantAId = await t.run(async (ctx) =>
			ctx.db.insert("briefingNotes", {
				title: "Cross-Tenant Briefing",
				topic: "tenant-a-topic",
				participants: ["sigma"],
				content: "Shared briefing content across tenants.",
				createdBy: "sigma",
				createdAt: NOW,
			}),
		);

		// A "tenant B" import lookup for the identical title+content finds
		// tenant A's row — this is the documented gap, not a bug fixed here.
		const page = await t.query(internal.okfBundle._findBriefingByTitleAndContent, {
			title: "Cross-Tenant Briefing",
			content: "Shared briefing content across tenants.",
			paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor: null },
		});

		expect(page.id).toBe(tenantAId);
	});

	test("_findTaskByTitleAndDescription: matches a title+description pair regardless of which 'tenant' inserted it (no namespace arg exists to scope by)", async () => {
		const t = createTestConvex();
		const tenantAId = await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "Cross-Tenant Task",
				description: "Shared task description across tenants.",
				assignedTo: "sigma",
				priority: "medium",
				status: "todo",
				createdBy: "sigma",
				createdAt: NOW,
				updatedAt: NOW,
			}),
		);

		const page = await t.query(internal.okfBundle._findTaskByTitleAndDescription, {
			title: "Cross-Tenant Task",
			description: "Shared task description across tenants.",
			paginationOpts: { numItems: BUNDLE_PAGE_SIZE, cursor: null },
		});

		expect(page.id).toBe(tenantAId);
	});
});
