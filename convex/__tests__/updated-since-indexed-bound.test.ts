/// <reference types="vite/client" />
//
// updated-since-indexed-bound.test.ts — TDD for the follow-up fix: pushing
// the `updatedSince` bound into the query itself (via the new compound
// indexes `by_assignee_updatedAt` / `by_assignee_status_updatedAt`) instead
// of widening a fixed-size, creation-ordered scan and filtering in-memory.
//
// Scope, per measurement: only two `tasks.list` branches were measured to
// exceed TASK_LIST_SCAN_CAP in production — `assignedTo` alone, and
// `assignedTo` + `status`. This file exercises exactly those two branches.
// No index was added for missions/briefingNotes/tasks.listByMission, so
// their behavior is unchanged (see updated-since-page-filter.test.ts and
// this file's comments below for what that implies).
//
// RED-before / GREEN-after note: these tests were run against the
// PRE-FIX code (git stash) to capture the RED failure pasted in the PR
// report, then re-run GREEN against the fix in this file's current form.
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

describe("tasks.list — updatedSince bound pushed into the index (assignedTo branches)", () => {
	// ── Decisive test: population >> cap, only a handful of rows actually
	// satisfy updatedSince. Before the fix, the widened scan takes
	// TASK_LIST_SCAN_CAP + 1 rows in creation-descending order regardless of
	// the window and, since the branch has more than that many rows total,
	// always overflows the cap and throws — even though almost none of those
	// rows match. After the fix, the bound lives in the index query itself,
	// so only the actually-matching rows are fetched and the call succeeds.
	test("population far above the cap, few rows match updatedSince: succeeds and returns exactly the matches (RED before fix / GREEN after)", async () => {
		const t = convexTest(schema, modules);
		const ASSIGNEE = "test-orch-indexed-bound-decisive";
		const OLD_UPDATED_AT = Date.now() - 100_000_000; // stale — excluded by the window
		const RECENT_UPDATED_AT = Date.now(); // fresh — included
		const SINCE_THRESHOLD = Date.now() - 1_000;

		await t.run(async (ctx) => {
			// Population comfortably larger than TASK_LIST_SCAN_CAP + 1, all stale.
			for (let i = 0; i < TASK_LIST_SCAN_CAP + 50; i++) {
				await ctx.db.insert("tasks", {
					title: `stale-task-${i}`,
					assignedTo: ASSIGNEE,
					priority: "medium",
					status: "todo",
					createdBy: ASSIGNEE,
					createdAt: Date.now(),
					updatedAt: OLD_UPDATED_AT,
				} as never);
			}
			// A handful of genuinely fresh rows.
			for (let i = 0; i < 3; i++) {
				await ctx.db.insert("tasks", {
					title: `fresh-task-${i}`,
					assignedTo: ASSIGNEE,
					priority: "medium",
					status: "todo",
					createdBy: ASSIGNEE,
					createdAt: Date.now(),
					updatedAt: RECENT_UPDATED_AT,
				} as never);
			}
		});

		const result = await t.query(api.tasks.list, {
			assignedTo: ASSIGNEE,
			status: "todo",
			updatedSince: SINCE_THRESHOLD,
			limit: 10,
			fields: "full",
		});
		const items = extractItems(result);
		expect(items.length).toBe(3);
		expect(items.every((r) => (r.title as string).startsWith("fresh-task-"))).toBe(
			true,
		);
	});

	// ── The most important test in this file: proof that narrowing the
	// window changes the number of candidates the query actually encounters.
	//
	// HONESTY NOTE: convex-test does not expose a scan-count / rows-examined
	// metric, so this cannot be asserted by directly instrumenting the
	// database read cost. What CAN be asserted honestly, and is asserted
	// here, is an outcome that is only possible if the window bound
	// participates in the query rather than being applied after a
	// fixed-size fetch: the SAME stored population (assignedTo+status
	// branch, TASK_LIST_SCAN_CAP + 1 rows) throws SCAN_CAP_EXCEEDED under a
	// WIDE window (which makes every row a candidate) and does NOT throw —
	// returning correctly-filtered results — under a NARROW window (which
	// makes zero rows candidates). If the bound were still applied
	// in-memory after a fixed take(), both calls would fetch the identical
	// TASK_LIST_SCAN_CAP + 1 rows and both would throw identically,
	// regardless of the window — exactly the pre-existing defect this fix
	// closes, and exactly what the superseded test in
	// updated-since-page-filter.test.ts ("cap + 1 candidate rows on the
	// assignedTo branch throws...") asserted. That old test is now
	// impossible to keep green alongside a correct fix: see this PR's
	// report for the full explanation. It is not modified here.
	test("identical population: a wide window still overflows the cap, a narrow window does not — proof the window participates in the query", async () => {
		const t = convexTest(schema, modules);
		const ASSIGNEE = "test-orch-indexed-bound-window-matters";
		const ROW_UPDATED_AT = Date.now() - 500;

		await t.run(async (ctx) => {
			for (let i = 0; i < TASK_LIST_SCAN_CAP + 1; i++) {
				await ctx.db.insert("tasks", {
					title: `window-matters-task-${i}`,
					assignedTo: ASSIGNEE,
					priority: "medium",
					status: "todo",
					createdBy: ASSIGNEE,
					createdAt: Date.now(),
					updatedAt: ROW_UPDATED_AT,
				} as never);
			}
		});

		// WIDE window: threshold before every row's updatedAt -> every row is
		// a candidate -> TASK_LIST_SCAN_CAP + 1 candidates -> overflow.
		await expect(
			t.query(api.tasks.list, {
				assignedTo: ASSIGNEE,
				status: "todo",
				updatedSince: ROW_UPDATED_AT - 1,
				limit: 10,
				fields: "full",
			}),
		).rejects.toThrow(/SCAN_CAP_EXCEEDED/);

		// NARROW window: threshold after every row's updatedAt -> zero rows
		// are candidates -> no overflow, empty (correct) result.
		const result = await t.query(api.tasks.list, {
			assignedTo: ASSIGNEE,
			status: "todo",
			updatedSince: ROW_UPDATED_AT + 1,
			limit: 10,
			fields: "full",
		});
		expect(extractItems(result).length).toBe(0);
	});

	// ── TWIN of the test above, for the assignedTo-ALONE branch (no `status`
	// argument at all, so `list` takes the by_assignee_updatedAt path and
	// applies any status filtering in memory afterward — irrelevant here
	// since no status is supplied). Same identical-population, two-pole
	// proof: a wide window makes every stored row a candidate and overflows
	// the cap; a narrow window makes zero rows candidates and returns an
	// empty (correct) result. If the bound were dropped from this branch's
	// query (e.g. `.gte("updatedAt", 0)` instead of `.gte("updatedAt",
	// updatedSince)`), both windows would fetch the identical
	// TASK_LIST_SCAN_CAP + 1 rows and both would throw identically,
	// regardless of the window.
	test("assignedTo-alone branch (no status arg): identical population, a wide window still overflows the cap, a narrow window does not", async () => {
		const t = convexTest(schema, modules);
		const ASSIGNEE = "test-orch-indexed-bound-window-matters-alone";
		const ROW_UPDATED_AT = Date.now() - 500;

		await t.run(async (ctx) => {
			for (let i = 0; i < TASK_LIST_SCAN_CAP + 1; i++) {
				await ctx.db.insert("tasks", {
					title: `window-matters-alone-task-${i}`,
					assignedTo: ASSIGNEE,
					priority: "medium",
					// Mixed statuses on purpose: no `status` arg is passed to
					// `list` below, so applyStatusFilter is a no-op and cannot be
					// the reason either pole passes or fails.
					status: i % 2 === 0 ? "todo" : "in_progress",
					createdBy: ASSIGNEE,
					createdAt: Date.now(),
					updatedAt: ROW_UPDATED_AT,
				} as never);
			}
		});

		// WIDE window: threshold before every row's updatedAt -> every row is
		// a candidate -> TASK_LIST_SCAN_CAP + 1 candidates -> overflow.
		await expect(
			t.query(api.tasks.list, {
				assignedTo: ASSIGNEE,
				updatedSince: ROW_UPDATED_AT - 1,
				limit: 10,
				fields: "full",
			}),
		).rejects.toThrow(/SCAN_CAP_EXCEEDED/);

		// NARROW window: threshold after every row's updatedAt -> zero rows
		// are candidates -> no overflow, empty (correct) result.
		const result = await t.query(api.tasks.list, {
			assignedTo: ASSIGNEE,
			updatedSince: ROW_UPDATED_AT + 1,
			limit: 10,
			fields: "full",
		});
		expect(extractItems(result).length).toBe(0);
	});

	// ── The cap must still be able to throw: a wide-enough window on a
	// big-enough branch still overflows, and the message only promises a
	// remedy that now actually works (shrinking the window IS a real lever
	// on this branch, since the bound is index-backed).
	test("wide-enough window on a big-enough assignedTo-alone branch still overflows the cap, message names a working remedy", async () => {
		const t = convexTest(schema, modules);
		const ASSIGNEE = "test-orch-indexed-bound-still-throws";
		const RECENT_UPDATED_AT = Date.now();

		await t.run(async (ctx) => {
			for (let i = 0; i < TASK_LIST_SCAN_CAP + 1; i++) {
				await ctx.db.insert("tasks", {
					title: `still-throws-task-${i}`,
					assignedTo: ASSIGNEE,
					priority: "medium",
					status: i % 2 === 0 ? "todo" : "in_progress",
					createdBy: ASSIGNEE,
					createdAt: Date.now(),
					updatedAt: RECENT_UPDATED_AT,
				} as never);
			}
		});

		await expect(
			t.query(api.tasks.list, {
				assignedTo: ASSIGNEE,
				updatedSince: RECENT_UPDATED_AT - 1_000,
				limit: 10,
				fields: "full",
			}),
		).rejects.toThrow(
			new RegExp(
				`SCAN_CAP_EXCEEDED.*cap of ${TASK_LIST_SCAN_CAP}.*Narrow with assignedTo.*shrink the updatedSince window`,
				"s",
			),
		);
	});
});

// ── TASK A (this PR's follow-up): the removal of the false remedy from the
// three non-indexed SCAN_CAP_EXCEEDED messages (missions.list,
// briefingNotes.list, tasks.listByMission) was an untested claim — nothing
// asserted its absence. Each test below forces the relevant handler to throw
// SCAN_CAP_EXCEEDED and asserts (a) the message does NOT contain the false
// remedy phrase and (b) the message DOES name the remedy it actually offers,
// so a test that merely fails to throw, or throws an empty message, cannot
// pass here.
describe("SCAN_CAP_EXCEEDED messages — false remedy removed from the three non-indexed branches", () => {
	test("missions.list (project branch, no index for updatedSince): message omits the window remedy, names project/pilot/status", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < MISSION_LIST_SCAN_CAP + 1; i++) {
				await ctx.db.insert("missions", {
					name: `fictitious-overcap-mission-${i}`,
					project: "fictitious-project-indexed-bound-missions",
					status: "execute",
					priority: "medium",
					pilot: "test-orch-indexed-bound-missions",
					agents: ["test-orch-indexed-bound-missions"],
					createdBy: "test-orch-indexed-bound-missions",
					createdAt: Date.now() + i,
					updatedAt: Date.now() - 100_000_000,
				} as never);
			}
		});

		try {
			await t.query(api.missions.list, {
				project: "fictitious-project-indexed-bound-missions",
				updatedSince: Date.now() - 1_000,
				limit: 10,
				fields: "full",
			});
			throw new Error("expected SCAN_CAP_EXCEEDED to throw");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toMatch(/SCAN_CAP_EXCEEDED.*cap of \d+.*Narrow with project\/pilot\/status/s);
			expect(message).not.toContain("shrink the updatedSince window");
			expect(message).toContain("Narrow with project/pilot/status");
		}
	});

	test("briefingNotes.list (topic branch, no index for updatedSince): message omits the window remedy, names topic", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < BRIEFING_NOTES_LIST_SCAN_CAP + 1; i++) {
				await ctx.db.insert("briefingNotes", {
					title: `fictitious-overcap-note-${i}`,
					topic: "fictitious-topic-indexed-bound",
					participants: ["test-orch-indexed-bound-notes"],
					content: "fictitious content",
					createdBy: "test-orch-indexed-bound-notes",
					createdAt: Date.now() + i,
					updatedAt: Date.now() - 100_000_000,
				} as never);
			}
		});

		try {
			await t.query(api.briefingNotes.list, {
				topic: "fictitious-topic-indexed-bound",
				updatedSince: Date.now() - 1_000,
				limit: 10,
				fields: "full",
			});
			throw new Error("expected SCAN_CAP_EXCEEDED to throw");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toMatch(/SCAN_CAP_EXCEEDED.*cap of \d+.*Narrow with topic/s);
			expect(message).not.toContain("shrink the updatedSince window");
			expect(message).toContain("Narrow with topic");
		}
	});

	test("tasks.listByMission (missionId branch, no index for updatedSince): message omits the window remedy, names status", async () => {
		const t = convexTest(schema, modules);
		const missionId = await t.run(async (ctx) => {
			return await ctx.db.insert("missions", {
				name: "fictitious-mission-indexed-bound-listbymission",
				project: "fictitious-project-indexed-bound-listbymission",
				status: "execute",
				priority: "medium",
				pilot: "test-orch-indexed-bound-listbymission",
				agents: ["test-orch-indexed-bound-listbymission"],
				createdBy: "test-orch-indexed-bound-listbymission",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as never);
		});
		await t.run(async (ctx) => {
			for (let i = 0; i < TASK_LIST_SCAN_CAP + 1; i++) {
				await ctx.db.insert("tasks", {
					title: `fictitious-overcap-mission-task-${i}`,
					assignedTo: "test-orch-indexed-bound-listbymission",
					priority: "medium",
					status: "todo",
					createdBy: "test-orch-indexed-bound-listbymission",
					missionId,
					createdAt: Date.now() + i,
					updatedAt: Date.now() - 100_000_000,
				} as never);
			}
		});

		try {
			await t.query(api.tasks.listByMission, {
				missionId,
				updatedSince: Date.now() - 1_000,
				limit: 10,
				fields: "full",
			});
			throw new Error("expected SCAN_CAP_EXCEEDED to throw");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toMatch(/SCAN_CAP_EXCEEDED.*cap of \d+.*Narrow with status/s);
			expect(message).not.toContain("shrink the updatedSince window");
			expect(message).toContain("Narrow with status");
		}
	});
});
