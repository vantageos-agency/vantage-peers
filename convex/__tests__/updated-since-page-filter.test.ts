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
import { BRIEFING_NOTES_LIST_SCAN_CAP } from "../briefingNotes";
import { MISSION_LIST_SCAN_CAP } from "../missions";
import schema from "../schema";
import { TASK_LIST_SCAN_CAP } from "../tasks";

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

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
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

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
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

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.listByMission, {
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

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.listByMission, {
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

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.missions.list, {
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

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.missions.list, {
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

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.briefingNotes.list, {
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

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.briefingNotes.list, {
				topic: "fixture-topic-page-filter-2",
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(PAGE_LIMIT);
		});
	});

	// ── SCAN_CAP_EXCEEDED — the refusal pole ────────────────────────────────
	//
	// The four sites widen their fetch to SCAN_CAP + 1 rows when updatedSince
	// (or createdBy) is supplied, then throw if the widened scan itself came
	// back saturated (> SCAN_CAP rows): a saturated widened scan means there
	// may be matching rows outside the window, so returning a page here would
	// be indistinguishable from a complete result. Untested until now — the
	// existing suite above only proves the FILTER is correct once the scan
	// wasn't saturated; it never drives the scan to its cap.
	//
	// Each pair below seeds the REAL production cap — imported directly from
	// the site's own module (TASK_LIST_SCAN_CAP / MISSION_LIST_SCAN_CAP /
	// BRIEFING_NOTES_LIST_SCAN_CAP), never retyped — against the same indexed
	// branch (assignedTo / missionId / project / topic) already exercised
	// above, so the seed count and the message assertion both derive from the
	// constant and stay correct if it ever changes:
	//   - cap + 1 rows on that branch -> the call MUST throw, and the message
	//     MUST name the cap and say how to narrow (assignedTo/project/status,
	//     or shrink the updatedSince window — the fix must never render a
	//     silent/generic refusal).
	//   - exactly cap rows (one row under the throw threshold) on the same
	//     branch -> the call MUST NOT throw, and MUST still return the
	//     correctly filtered population. Without this pole, a handler that
	//     throws unconditionally on `updatedSince` would pass the first half
	//     silently.

	describe("tasks.list — SCAN_CAP_EXCEEDED", () => {
		test("cap + 1 candidate rows on the assignedTo branch throws, naming the cap and how to narrow", async () => {
			const t = convexTest(schema, modules);
			// IMPORTANT — seed rows that ACTUALLY MATCH updatedSince, not stale ones.
			//
			// On this branch (assignedTo alone / assignedTo+status), `updatedSince`
			// is now pushed into the query via a compound index ending in
			// `updatedAt` (by_assignee_updatedAt / by_assignee_status_updatedAt —
			// see convex/tasks.ts `list`). The scan cap is therefore checked
			// against the number of rows that MATCH the window, not against a
			// fixed-size pre-filter fetch. Seeding cap+1 STALE rows (updatedAt
			// before the threshold) would make every one of them get excluded by
			// the index range query itself, so the call would correctly return an
			// empty page instead of throwing — that used to be exactly the bug
			// this suite exists to catch (the cap firing regardless of whether
			// anything matched). If someone "simplifies" this fixture back to
			// stale rows, this test silently stops proving the cap still works
			// and starts proving the old, now-fixed defect instead. Keep every
			// seeded row's `updatedAt` >= SINCE_THRESHOLD.
			await t.run(async (ctx) => {
				for (let i = 0; i < TASK_LIST_SCAN_CAP + 1; i++) {
					await ctx.db.insert("tasks", {
						title: `overcap-task-${i}`,
						assignedTo: "test-orch-scan-cap-over",
						priority: "medium",
						status: "todo",
						createdBy: "test-orch-scan-cap-over",
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: RECENT_UPDATED_AT,
					} as never);
				}
			});

			await expect(
				t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
					assignedTo: "test-orch-scan-cap-over",
					updatedSince: SINCE_THRESHOLD,
					limit: PAGE_LIMIT,
					fields: "full",
				}),
			).rejects.toThrow(
				new RegExp(
					`SCAN_CAP_EXCEEDED.*cap of ${TASK_LIST_SCAN_CAP}.*Narrow with assignedTo`,
					"s",
				),
			);
		});

		test("exactly cap candidate rows on the same branch does not throw and returns the correct population", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				await ctx.db.insert("tasks", {
					title: "target-at-cap-task",
					assignedTo: "test-orch-scan-cap-atcap",
					priority: "medium",
					status: "todo",
					createdBy: "test-orch-scan-cap-atcap",
					createdAt: OLD_UPDATED_AT,
					updatedAt: RECENT_UPDATED_AT,
				} as never);
				for (let i = 0; i < TASK_LIST_SCAN_CAP - 1; i++) {
					await ctx.db.insert("tasks", {
						title: `atcap-task-${i}`,
						assignedTo: "test-orch-scan-cap-atcap",
						priority: "medium",
						status: "todo",
						createdBy: "test-orch-scan-cap-atcap",
						createdAt: OLD_UPDATED_AT + i + 1,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
				assignedTo: "test-orch-scan-cap-atcap",
				updatedSince: SINCE_THRESHOLD,
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.some((r) => r.title === "target-at-cap-task")).toBe(true);
		});
	});

	describe("tasks.listByMission — SCAN_CAP_EXCEEDED", () => {
		test("cap + 1 candidate rows on the missionId branch throws, naming the cap and how to narrow", async () => {
			const t = convexTest(schema, modules);
			const missionId = await t.run(async (ctx) => {
				return await ctx.db.insert("missions", {
					name: "fixture-mission-scan-cap-over",
					project: "fixture-project-scan-cap-over",
					status: "execute",
					priority: "medium",
					pilot: "test-orch-scan-cap-over",
					agents: ["test-orch-scan-cap-over"],
					createdBy: "test-orch-scan-cap-over",
					createdAt: OLD_UPDATED_AT,
					updatedAt: OLD_UPDATED_AT,
				} as never);
			});
			await t.run(async (ctx) => {
				for (let i = 0; i < TASK_LIST_SCAN_CAP + 1; i++) {
					await ctx.db.insert("tasks", {
						title: `overcap-mission-task-${i}`,
						assignedTo: "test-orch-scan-cap-over",
						priority: "medium",
						status: "todo",
						createdBy: "test-orch-scan-cap-over",
						missionId,
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			await expect(
				t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.listByMission, {
					missionId,
					updatedSince: SINCE_THRESHOLD,
					limit: PAGE_LIMIT,
					fields: "full",
				}),
			).rejects.toThrow(
				new RegExp(
					`SCAN_CAP_EXCEEDED.*cap of ${TASK_LIST_SCAN_CAP}.*Narrow with status`,
					"s",
				),
			);
		});

		test("exactly cap candidate rows on the same branch does not throw and returns the correct population", async () => {
			const t = convexTest(schema, modules);
			const missionId = await t.run(async (ctx) => {
				return await ctx.db.insert("missions", {
					name: "fixture-mission-scan-cap-atcap",
					project: "fixture-project-scan-cap-atcap",
					status: "execute",
					priority: "medium",
					pilot: "test-orch-scan-cap-atcap",
					agents: ["test-orch-scan-cap-atcap"],
					createdBy: "test-orch-scan-cap-atcap",
					createdAt: OLD_UPDATED_AT,
					updatedAt: OLD_UPDATED_AT,
				} as never);
			});
			await t.run(async (ctx) => {
				await ctx.db.insert("tasks", {
					title: "target-at-cap-mission-task",
					assignedTo: "test-orch-scan-cap-atcap",
					priority: "medium",
					status: "todo",
					createdBy: "test-orch-scan-cap-atcap",
					missionId,
					createdAt: OLD_UPDATED_AT,
					updatedAt: RECENT_UPDATED_AT,
				} as never);
				for (let i = 0; i < TASK_LIST_SCAN_CAP - 1; i++) {
					await ctx.db.insert("tasks", {
						title: `atcap-mission-task-${i}`,
						assignedTo: "test-orch-scan-cap-atcap",
						priority: "medium",
						status: "todo",
						createdBy: "test-orch-scan-cap-atcap",
						missionId,
						createdAt: OLD_UPDATED_AT + i + 1,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.listByMission, {
				missionId,
				updatedSince: SINCE_THRESHOLD,
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.some((r) => r.title === "target-at-cap-mission-task")).toBe(
				true,
			);
		});
	});

	describe("missions.list — SCAN_CAP_EXCEEDED", () => {
		test("cap + 1 candidate rows on the project branch throws, naming the cap and how to narrow", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				for (let i = 0; i < MISSION_LIST_SCAN_CAP + 1; i++) {
					await ctx.db.insert("missions", {
						name: `overcap-mission-${i}`,
						project: "fixture-project-mission-scan-cap-over",
						status: "execute",
						priority: "medium",
						pilot: "test-orch-scan-cap-over",
						agents: ["test-orch-scan-cap-over"],
						createdBy: "test-orch-scan-cap-over",
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			await expect(
				t.withIdentity({ subject: "test-service-account-user-id" }).query(api.missions.list, {
					project: "fixture-project-mission-scan-cap-over",
					updatedSince: SINCE_THRESHOLD,
					limit: PAGE_LIMIT,
					fields: "full",
				}),
			).rejects.toThrow(
				new RegExp(
					`SCAN_CAP_EXCEEDED.*cap of ${MISSION_LIST_SCAN_CAP}.*Narrow with project/pilot/status`,
					"s",
				),
			);
		});

		test("exactly cap candidate rows on the same branch does not throw and returns the correct population", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				await ctx.db.insert("missions", {
					name: "target-at-cap-mission",
					project: "fixture-project-mission-scan-cap-atcap",
					status: "execute",
					priority: "medium",
					pilot: "test-orch-scan-cap-atcap",
					agents: ["test-orch-scan-cap-atcap"],
					createdBy: "test-orch-scan-cap-atcap",
					createdAt: OLD_UPDATED_AT,
					updatedAt: RECENT_UPDATED_AT,
				} as never);
				for (let i = 0; i < MISSION_LIST_SCAN_CAP - 1; i++) {
					await ctx.db.insert("missions", {
						name: `atcap-mission-${i}`,
						project: "fixture-project-mission-scan-cap-atcap",
						status: "execute",
						priority: "medium",
						pilot: "test-orch-scan-cap-atcap",
						agents: ["test-orch-scan-cap-atcap"],
						createdBy: "test-orch-scan-cap-atcap",
						createdAt: OLD_UPDATED_AT + i + 1,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.missions.list, {
				project: "fixture-project-mission-scan-cap-atcap",
				updatedSince: SINCE_THRESHOLD,
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.some((r) => r.name === "target-at-cap-mission")).toBe(true);
		});
	});

	describe("briefingNotes.list — SCAN_CAP_EXCEEDED", () => {
		test("cap + 1 candidate rows on the topic branch throws, naming the cap and how to narrow", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				for (let i = 0; i < BRIEFING_NOTES_LIST_SCAN_CAP + 1; i++) {
					await ctx.db.insert("briefingNotes", {
						title: `overcap-note-${i}`,
						topic: "fixture-topic-scan-cap-over",
						participants: ["test-orch-scan-cap-over"],
						content: "fixture content",
						createdBy: "test-orch-scan-cap-over",
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			await expect(
				t.withIdentity({ subject: "test-service-account-user-id" }).query(api.briefingNotes.list, {
					topic: "fixture-topic-scan-cap-over",
					updatedSince: SINCE_THRESHOLD,
					limit: PAGE_LIMIT,
					fields: "full",
				}),
			).rejects.toThrow(
				new RegExp(
					`SCAN_CAP_EXCEEDED.*cap of ${BRIEFING_NOTES_LIST_SCAN_CAP}.*Narrow with topic`,
					"s",
				),
			);
		});

		test("exactly cap candidate rows on the same branch does not throw and returns the correct population", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				await ctx.db.insert("briefingNotes", {
					title: "target-at-cap-note",
					topic: "fixture-topic-scan-cap-atcap",
					participants: ["test-orch-scan-cap-atcap"],
					content: "fixture content",
					createdBy: "test-orch-scan-cap-atcap",
					createdAt: OLD_UPDATED_AT,
					updatedAt: RECENT_UPDATED_AT,
				} as never);
				for (let i = 0; i < BRIEFING_NOTES_LIST_SCAN_CAP - 1; i++) {
					await ctx.db.insert("briefingNotes", {
						title: `atcap-note-${i}`,
						topic: "fixture-topic-scan-cap-atcap",
						participants: ["test-orch-scan-cap-atcap"],
						content: "fixture content",
						createdBy: "test-orch-scan-cap-atcap",
						createdAt: OLD_UPDATED_AT + i + 1,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.briefingNotes.list, {
				topic: "fixture-topic-scan-cap-atcap",
				updatedSince: SINCE_THRESHOLD,
				limit: PAGE_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.some((r) => r.title === "target-at-cap-note")).toBe(true);
		});
	});

	// ── EXACT-LIMIT re-bound assertion — the trou named by the reviewer ────────
	//
	// ETA-M2 deleted `filtered.slice(0, limit)` on the widened branch and the
	// full suite stayed green: nothing above asserts an EXACT count on that
	// branch when the matching population exceeds `limit`. `.some(...)`
	// membership checks pass whether the re-bound line is present or not.
	// Each pair below closes that gap for one site: population strictly
	// bigger than `limit` (all matching, since strictly-bigger membership
	// alone doesn't force the assert to fail without the re-bound) must
	// render exactly `limit` rows; population strictly smaller than `limit`
	// must render every row in the population, not `limit`.

	const EXACT_LIMIT = 10;
	const OVER_POPULATION = EXACT_LIMIT + 8; // decisively larger than the limit
	const UNDER_POPULATION = EXACT_LIMIT - 4; // decisively smaller than the limit

	describe("tasks.list — exact re-bound to limit", () => {
		test("population larger than limit renders EXACTLY limit rows", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				for (let i = 0; i < OVER_POPULATION; i++) {
					await ctx.db.insert("tasks", {
						title: `exact-over-task-${i}`,
						assignedTo: "test-orch-exact-limit-over",
						priority: "medium",
						status: "todo",
						createdBy: "test-orch-exact-limit-over",
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: RECENT_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
				assignedTo: "test-orch-exact-limit-over",
				updatedSince: SINCE_THRESHOLD,
				limit: EXACT_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(EXACT_LIMIT);
		});

		test("population smaller than limit renders the FULL population, not limit", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				for (let i = 0; i < UNDER_POPULATION; i++) {
					await ctx.db.insert("tasks", {
						title: `exact-under-task-${i}`,
						assignedTo: "test-orch-exact-limit-under",
						priority: "medium",
						status: "todo",
						createdBy: "test-orch-exact-limit-under",
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: RECENT_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.list, {
				assignedTo: "test-orch-exact-limit-under",
				updatedSince: SINCE_THRESHOLD,
				limit: EXACT_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(UNDER_POPULATION);
		});
	});

	describe("tasks.listByMission — exact re-bound to limit", () => {
		test("population larger than limit renders EXACTLY limit rows", async () => {
			const t = convexTest(schema, modules);
			const missionId = await t.run(async (ctx) => {
				return await ctx.db.insert("missions", {
					name: "fixture-mission-exact-limit-over",
					project: "fixture-project-exact-limit-over",
					status: "execute",
					priority: "medium",
					pilot: "test-orch-exact-limit-over",
					agents: ["test-orch-exact-limit-over"],
					createdBy: "test-orch-exact-limit-over",
					createdAt: OLD_UPDATED_AT,
					updatedAt: OLD_UPDATED_AT,
				} as never);
			});
			await t.run(async (ctx) => {
				for (let i = 0; i < OVER_POPULATION; i++) {
					await ctx.db.insert("tasks", {
						title: `exact-over-mission-task-${i}`,
						assignedTo: "test-orch-exact-limit-over",
						priority: "medium",
						status: "todo",
						createdBy: "test-orch-exact-limit-over",
						missionId,
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: RECENT_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.listByMission, {
				missionId,
				updatedSince: SINCE_THRESHOLD,
				limit: EXACT_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(EXACT_LIMIT);
		});

		test("population smaller than limit renders the FULL population, not limit", async () => {
			const t = convexTest(schema, modules);
			const missionId = await t.run(async (ctx) => {
				return await ctx.db.insert("missions", {
					name: "fixture-mission-exact-limit-under",
					project: "fixture-project-exact-limit-under",
					status: "execute",
					priority: "medium",
					pilot: "test-orch-exact-limit-under",
					agents: ["test-orch-exact-limit-under"],
					createdBy: "test-orch-exact-limit-under",
					createdAt: OLD_UPDATED_AT,
					updatedAt: OLD_UPDATED_AT,
				} as never);
			});
			await t.run(async (ctx) => {
				for (let i = 0; i < UNDER_POPULATION; i++) {
					await ctx.db.insert("tasks", {
						title: `exact-under-mission-task-${i}`,
						assignedTo: "test-orch-exact-limit-under",
						priority: "medium",
						status: "todo",
						createdBy: "test-orch-exact-limit-under",
						missionId,
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: RECENT_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.tasks.listByMission, {
				missionId,
				updatedSince: SINCE_THRESHOLD,
				limit: EXACT_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(UNDER_POPULATION);
		});
	});

	describe("missions.list — exact re-bound to limit", () => {
		test("population larger than limit renders EXACTLY limit rows", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				for (let i = 0; i < OVER_POPULATION; i++) {
					await ctx.db.insert("missions", {
						name: `exact-over-mission-${i}`,
						project: "fixture-project-mission-exact-limit-over",
						status: "execute",
						priority: "medium",
						pilot: "test-orch-exact-limit-over",
						agents: ["test-orch-exact-limit-over"],
						createdBy: "test-orch-exact-limit-over",
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: RECENT_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.missions.list, {
				project: "fixture-project-mission-exact-limit-over",
				updatedSince: SINCE_THRESHOLD,
				limit: EXACT_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(EXACT_LIMIT);
		});

		test("population smaller than limit renders the FULL population, not limit", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				for (let i = 0; i < UNDER_POPULATION; i++) {
					await ctx.db.insert("missions", {
						name: `exact-under-mission-${i}`,
						project: "fixture-project-mission-exact-limit-under",
						status: "execute",
						priority: "medium",
						pilot: "test-orch-exact-limit-under",
						agents: ["test-orch-exact-limit-under"],
						createdBy: "test-orch-exact-limit-under",
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: RECENT_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.missions.list, {
				project: "fixture-project-mission-exact-limit-under",
				updatedSince: SINCE_THRESHOLD,
				limit: EXACT_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(UNDER_POPULATION);
		});
	});

	describe("briefingNotes.list — exact re-bound to limit", () => {
		test("population larger than limit renders EXACTLY limit rows", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				for (let i = 0; i < OVER_POPULATION; i++) {
					await ctx.db.insert("briefingNotes", {
						title: `exact-over-note-${i}`,
						topic: "fixture-topic-exact-limit-over",
						participants: ["test-orch-exact-limit-over"],
						content: "fixture content",
						createdBy: "test-orch-exact-limit-over",
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: RECENT_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.briefingNotes.list, {
				topic: "fixture-topic-exact-limit-over",
				updatedSince: SINCE_THRESHOLD,
				limit: EXACT_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(EXACT_LIMIT);
		});

		test("population smaller than limit renders the FULL population, not limit", async () => {
			const t = convexTest(schema, modules);
			await t.run(async (ctx) => {
				for (let i = 0; i < UNDER_POPULATION; i++) {
					await ctx.db.insert("briefingNotes", {
						title: `exact-under-note-${i}`,
						topic: "fixture-topic-exact-limit-under",
						participants: ["test-orch-exact-limit-under"],
						content: "fixture content",
						createdBy: "test-orch-exact-limit-under",
						createdAt: OLD_UPDATED_AT + i,
						updatedAt: RECENT_UPDATED_AT,
					} as never);
				}
			});

			const result = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.briefingNotes.list, {
				topic: "fixture-topic-exact-limit-under",
				updatedSince: SINCE_THRESHOLD,
				limit: EXACT_LIMIT,
				fields: "full",
			});
			const items = extractItems(result);
			expect(items.length).toBe(UNDER_POPULATION);
		});
	});
});
