/// <reference types="vite/client" />
//
// updated-since-page-filter.test.ts — TDD-RED for the "bound applied after
// the fetch, described as if it had bounded the fetch" defect on
// `updatedSince` (and `createdBy`), across the four sites that share the
// class:
//
//   convex/tasks.ts:520-527        (list)
//   convex/tasks.ts:1154-1160      (listByMission)
//   convex/missions.ts:297-300     (list)
//   convex/briefingNotes.ts:140-142 (list)
//
// DEFECT (measured live): `updatedSince` is applied IN-MEMORY after a
// `.take(limit)` that has already bounded the page in creation-descending
// order. A row modified recently but created outside that page is invisible
// — the caller receives a partial list that looks complete.
//
// Reproduction shape (same for every site): seed the target row FIRST (so
// it is the OLDEST row, at the back of creation-descending order), then
// seed strictly more rows than the requested page `limit` AFTER it (so the
// target falls fully outside the unfixed `.take(limit)` window). Only the
// target row carries a recent `updatedAt`; all the padding rows carry a
// stale one. Query with `updatedSince` set just above the padding rows'
// `updatedAt` and `limit` smaller than the padding count.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type Row = Record<string, unknown>;

function extractItems(result: unknown): Row[] {
	if (Array.isArray(result)) return result as Row[];
	if (result !== null && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (Array.isArray(r.items)) return r.items as Row[];
	}
	return [];
}

const OLD_UPDATED_AT = Date.now() - 10_000_000; // padding rows: stale
const RECENT_UPDATED_AT = Date.now(); // target row: just modified
const SINCE_THRESHOLD = Date.now() - 1_000; // just above OLD_UPDATED_AT

// Page size deliberately smaller than the padding-row count, so the target
// (oldest row, inserted first) sits fully outside a naive `.take(limit)`
// window taken in creation-descending order.
const PAGE_LIMIT = 10;
const PADDING_ROW_COUNT = 15; // > PAGE_LIMIT, decisive per brief

describe("updatedSince page-filter defect — RED before fix, GREEN after", () => {
	// ── tasks.ts `list` ──────────────────────────────────────────────────────

	describe("tasks.list", () => {
		test("a recently-updated row created outside the page must still be returned", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				// Target row inserted FIRST → oldest in creation-descending order.
				await ctx.db.insert("tasks", {
					title: "target-recently-modified-task",
					assignedTo: "test-orch-page-filter",
					priority: "medium",
					status: "todo",
					createdBy: "test-orch-page-filter",
					createdAt: OLD_UPDATED_AT,
					updatedAt: RECENT_UPDATED_AT,
				} as never);
				// Padding rows inserted AFTER → all newer than the target in
				// creation order, all stale in updatedAt.
				for (let i = 0; i < PADDING_ROW_COUNT; i++) {
					await ctx.db.insert("tasks", {
						title: `padding-task-${i}`,
						assignedTo: "test-orch-page-filter",
						priority: "medium",
						status: "todo",
						createdBy: "test-orch-page-filter",
						createdAt: OLD_UPDATED_AT + i + 1,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.query(api.tasks.list, {
				assignedTo: "test-orch-page-filter",
				updatedSince: SINCE_THRESHOLD,
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.some((r) => r.title === "target-recently-modified-task")).toBe(
				true,
			);
		});

		test("negative pole: without updatedSince, count is unaffected by the fix", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				for (let i = 0; i < PADDING_ROW_COUNT; i++) {
					await ctx.db.insert("tasks", {
						title: `plain-task-${i}`,
						assignedTo: "test-orch-page-filter-2",
						priority: "medium",
						status: "todo",
						createdBy: "test-orch-page-filter-2",
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.query(api.tasks.list, {
				assignedTo: "test-orch-page-filter-2",
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(PAGE_LIMIT);
		});
	});

	// ── tasks.ts `listByMission` ─────────────────────────────────────────────

	describe("tasks.listByMission", () => {
		test("a recently-updated row created outside the page must still be returned", async () => {
			const t = convexTest(schema, modules);
			const missionId = await t.run(async (ctx) => {
				return await ctx.db.insert("missions", {
					name: "fixture-mission-page-filter",
					project: "fixture-project-page-filter",
					status: "execute",
					priority: "medium",
					pilot: "test-orch-page-filter",
					agents: ["test-orch-page-filter"],
					createdBy: "test-orch-page-filter",
					createdAt: OLD_UPDATED_AT,
					updatedAt: OLD_UPDATED_AT,
				} as never);
			});

			await t.run(async (ctx) => {
				await ctx.db.insert("tasks", {
					title: "target-recently-modified-mission-task",
					assignedTo: "test-orch-page-filter",
					priority: "medium",
					status: "todo",
					createdBy: "test-orch-page-filter",
					missionId,
					createdAt: OLD_UPDATED_AT,
					updatedAt: RECENT_UPDATED_AT,
				} as never);
				for (let i = 0; i < PADDING_ROW_COUNT; i++) {
					await ctx.db.insert("tasks", {
						title: `padding-mission-task-${i}`,
						assignedTo: "test-orch-page-filter",
						priority: "medium",
						status: "todo",
						createdBy: "test-orch-page-filter",
						missionId,
						createdAt: OLD_UPDATED_AT + i + 1,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.query(api.tasks.listByMission, {
				missionId,
				updatedSince: SINCE_THRESHOLD,
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(
				items.some((r) => r.title === "target-recently-modified-mission-task"),
			).toBe(true);
		});

		test("negative pole: without updatedSince, count is unaffected by the fix", async () => {
			const t = convexTest(schema, modules);
			const missionId = await t.run(async (ctx) => {
				return await ctx.db.insert("missions", {
					name: "fixture-mission-page-filter-2",
					project: "fixture-project-page-filter-2",
					status: "execute",
					priority: "medium",
					pilot: "test-orch-page-filter",
					agents: ["test-orch-page-filter"],
					createdBy: "test-orch-page-filter",
					createdAt: OLD_UPDATED_AT,
					updatedAt: OLD_UPDATED_AT,
				} as never);
			});
			await t.run(async (ctx) => {
				for (let i = 0; i < PADDING_ROW_COUNT; i++) {
					await ctx.db.insert("tasks", {
						title: `plain-mission-task-${i}`,
						assignedTo: "test-orch-page-filter",
						priority: "medium",
						status: "todo",
						createdBy: "test-orch-page-filter",
						missionId,
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.query(api.tasks.listByMission, {
				missionId,
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(PAGE_LIMIT);
		});
	});

	// ── missions.ts `list` ───────────────────────────────────────────────────

	describe("missions.list", () => {
		test("a recently-updated mission created outside the page must still be returned", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				await ctx.db.insert("missions", {
					name: "target-recently-modified-mission",
					project: "fixture-project-mission-page-filter",
					status: "execute",
					priority: "medium",
					pilot: "test-orch-page-filter",
					agents: ["test-orch-page-filter"],
					createdBy: "test-orch-page-filter",
					createdAt: OLD_UPDATED_AT,
					updatedAt: RECENT_UPDATED_AT,
				} as never);
				for (let i = 0; i < PADDING_ROW_COUNT; i++) {
					await ctx.db.insert("missions", {
						name: `padding-mission-${i}`,
						project: "fixture-project-mission-page-filter",
						status: "execute",
						priority: "medium",
						pilot: "test-orch-page-filter",
						agents: ["test-orch-page-filter"],
						createdBy: "test-orch-page-filter",
						createdAt: OLD_UPDATED_AT + i + 1,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.query(api.missions.list, {
				project: "fixture-project-mission-page-filter",
				updatedSince: SINCE_THRESHOLD,
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(
				items.some((r) => r.name === "target-recently-modified-mission"),
			).toBe(true);
		});

		test("negative pole: without updatedSince, count is unaffected by the fix", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				for (let i = 0; i < PADDING_ROW_COUNT; i++) {
					await ctx.db.insert("missions", {
						name: `plain-mission-${i}`,
						project: "fixture-project-mission-page-filter-2",
						status: "execute",
						priority: "medium",
						pilot: "test-orch-page-filter",
						agents: ["test-orch-page-filter"],
						createdBy: "test-orch-page-filter",
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.query(api.missions.list, {
				project: "fixture-project-mission-page-filter-2",
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(PAGE_LIMIT);
		});
	});

	// ── briefingNotes.ts `list` ──────────────────────────────────────────────

	describe("briefingNotes.list", () => {
		test("a recently-updated note created outside the page must still be returned", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				await ctx.db.insert("briefingNotes", {
					title: "target-recently-modified-note",
					topic: "fixture-topic-page-filter",
					participants: ["test-orch-page-filter"],
					content: "fixture content",
					createdBy: "test-orch-page-filter",
					createdAt: OLD_UPDATED_AT,
					updatedAt: RECENT_UPDATED_AT,
				} as never);
				for (let i = 0; i < PADDING_ROW_COUNT; i++) {
					await ctx.db.insert("briefingNotes", {
						title: `padding-note-${i}`,
						topic: "fixture-topic-page-filter",
						participants: ["test-orch-page-filter"],
						content: "fixture content",
						createdBy: "test-orch-page-filter",
						createdAt: OLD_UPDATED_AT + i + 1,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.query(api.briefingNotes.list, {
				topic: "fixture-topic-page-filter",
				updatedSince: SINCE_THRESHOLD,
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.some((r) => r.title === "target-recently-modified-note")).toBe(
				true,
			);
		});

		test("negative pole: without updatedSince, count is unaffected by the fix", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				for (let i = 0; i < PADDING_ROW_COUNT; i++) {
					await ctx.db.insert("briefingNotes", {
						title: `plain-note-${i}`,
						topic: "fixture-topic-page-filter-2",
						participants: ["test-orch-page-filter"],
						content: "fixture content",
						createdBy: "test-orch-page-filter",
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.query(api.briefingNotes.list, {
				topic: "fixture-topic-page-filter-2",
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(PAGE_LIMIT);
		});
	});
});
