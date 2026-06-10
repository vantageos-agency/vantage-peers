/// <reference types="vite/client" />
//
// PR C — (c1) issueClosedSweep tests.
//
// Tests cascadeCloseMission (internalMutation) and sweepIssueClosed (internalAction).
// sweepIssueClosed is node-runtime — we mock fetch via vi.stubGlobal.
//
// Scenarios:
//   1. Mission with closed GH issue → mission + all open tasks cascade-closed.
//   2. Mission with open GH issue → no change.
//   3. Mission with no GH issue ref → skipped (no API call).
//   4. Multiple missions, mixed states → only closed ones are affected.
//   5. cascadeCloseMission idempotent: already-done tasks untouched.
//   6. GH API error (non-200) → errors counter bumped, mission untouched.
//   7. Mock simulates 13 child tasks (full IRP T0..T12 cascade).

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
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

// Helper: insert a mission with a GH issue URL in the brief
async function insertMissionWithIssueRef(
	ctx: ReturnType<typeof createTestConvex>,
	opts: {
		name?: string;
		issueUrl?: string;
		status?: "brainstorm" | "plan" | "execute" | "validate";
	} = {},
): Promise<Id<"missions">> {
	return await ctx.run(async (db) => {
		const now = Date.now();
		return db.db.insert("missions", {
			name: opts.name ?? "IRP mission",
			project: "vantage-memory",
			status: opts.status ?? "execute",
			priority: "urgent" as const,
			pilot: "sigma",
			agents: ["sigma"],
			brief: opts.issueUrl
				? `Fix issue ${opts.issueUrl} — IRP active`
				: "No issue ref here",
			createdBy: "sigma",
			createdAt: now,
			updatedAt: now,
		});
	});
}

// Helper: insert N tasks linked to a mission
async function insertTasksForMission(
	ctx: ReturnType<typeof createTestConvex>,
	missionId: Id<"missions">,
	count: number,
	status: "todo" | "in_progress" | "done" = "todo",
): Promise<Array<Id<"tasks">>> {
	const ids: Array<Id<"tasks">> = [];
	for (let i = 0; i < count; i++) {
		const id = await ctx.run(async (db) => {
			const now = Date.now();
			return db.db.insert("tasks", {
				title: `[#42] T${i} — IRP step`,
				assignedTo: "sigma",
				priority: "urgent" as const,
				status,
				missionId,
				project: "vantage-memory",
				createdBy: "sigma",
				createdAt: now,
				updatedAt: now,
			});
		});
		ids.push(id);
	}
	return ids;
}

// Helper: fetch mission row (typed)
async function getMission(
	ctx: ReturnType<typeof createTestConvex>,
	missionId: Id<"missions">,
) {
	return ctx.run(async (db) => db.db.get(missionId));
}

// Helper: fetch task row (typed)
async function getTask(
	ctx: ReturnType<typeof createTestConvex>,
	taskId: Id<"tasks">,
) {
	return ctx.run(async (db) => db.db.get(taskId));
}

const CLOSED_ISSUE_URL =
	"https://github.com/vantageos-agency/vantage-peers/issues/42";
const OPEN_ISSUE_URL =
	"https://github.com/vantageos-agency/vantage-peers/issues/99";

// ─────────────────────────────────────────────────────────────────────────────
// cascadeCloseMission — unit tests (no fetch mock needed)
// ─────────────────────────────────────────────────────────────────────────────

describe("cascadeCloseMission", () => {
	test("closes all open child tasks and marks mission complete", async () => {
		const t = createTestConvex();
		const missionId = await insertMissionWithIssueRef(t, {
			issueUrl: CLOSED_ISSUE_URL,
		});
		const taskIds = await insertTasksForMission(t, missionId, 3, "todo");

		const result = await t.mutation(
			internal.issueClosedSweep.cascadeCloseMission,
			{ missionId, issueRef: CLOSED_ISSUE_URL },
		);

		expect(result.tasksCompleted).toBe(3);

		// All tasks closed
		for (const id of taskIds) {
			const task = await getTask(t, id);
			expect(task?.status).toBe("done");
			expect(task?.completionNote).toContain("issue-closed-externally");
			expect(task?.completionNote).toContain(CLOSED_ISSUE_URL);
		}

		// Mission complete
		const mission = await getMission(t, missionId);
		expect(mission?.status).toBe("complete");
	});

	test("idempotent: skips already-done tasks", async () => {
		const t = createTestConvex();
		const missionId = await insertMissionWithIssueRef(t);
		// 2 already-done tasks
		await insertTasksForMission(t, missionId, 2, "done");
		// 1 open task
		const [openTaskId] = await insertTasksForMission(t, missionId, 1, "todo");

		const result = await t.mutation(
			internal.issueClosedSweep.cascadeCloseMission,
			{ missionId, issueRef: CLOSED_ISSUE_URL },
		);

		expect(result.tasksCompleted).toBe(1);

		const openTask = await getTask(t, openTaskId);
		expect(openTask?.status).toBe("done");
	});

	test("full IRP cascade: 13 tasks (T0..T12) all closed", async () => {
		const t = createTestConvex();
		const missionId = await insertMissionWithIssueRef(t, {
			issueUrl: CLOSED_ISSUE_URL,
		});
		await insertTasksForMission(t, missionId, 13, "todo");

		const result = await t.mutation(
			internal.issueClosedSweep.cascadeCloseMission,
			{ missionId, issueRef: CLOSED_ISSUE_URL },
		);

		expect(result.tasksCompleted).toBe(13);

		const doneTasks = await t.run(async (ctx) =>
			ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", "done"))
				.collect(),
		);
		expect(doneTasks.length).toBe(13);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// sweepIssueClosed — integration tests with mocked fetch
// ─────────────────────────────────────────────────────────────────────────────

function mockFetch(stateByIssueNumber: Record<number, "open" | "closed">) {
	const mockFn = vi.fn().mockImplementation(async (url: string) => {
		const match = url.match(/\/issues\/(\d+)$/);
		if (!match) {
			return { ok: false, status: 404, json: async () => ({}) };
		}
		const issueNum = parseInt(match[1], 10);
		const state = stateByIssueNumber[issueNum];
		if (state === undefined) {
			return { ok: false, status: 404, json: async () => ({}) };
		}
		return { ok: true, status: 200, json: async () => ({ state }) };
	});
	vi.stubGlobal("fetch", mockFn);
	return mockFn;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sweepIssueClosed — fetch mocked", () => {
	test("closed externally: mission + tasks cascade-closed", async () => {
		mockFetch({ 42: "closed" });
		const t = createTestConvex();

		const missionId = await insertMissionWithIssueRef(t, {
			issueUrl: CLOSED_ISSUE_URL,
		});
		await insertTasksForMission(t, missionId, 5, "todo");

		const result = await t.action(
			internal.issueClosedSweep.sweepIssueClosed,
			{},
		);

		expect(result.scanned).toBe(1);
		expect(result.closed).toBe(1);
		expect(result.errors).toBe(0);

		const mission = await getMission(t, missionId);
		expect(mission?.status).toBe("complete");

		const doneTasks = await t.run(async (ctx) =>
			ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", "done"))
				.collect(),
		);
		expect(doneTasks.length).toBe(5);
	});

	test("open issue: mission untouched", async () => {
		mockFetch({ 99: "open" });
		const t = createTestConvex();

		const missionId = await insertMissionWithIssueRef(t, {
			issueUrl: OPEN_ISSUE_URL,
		});
		await insertTasksForMission(t, missionId, 3, "todo");

		const result = await t.action(
			internal.issueClosedSweep.sweepIssueClosed,
			{},
		);

		expect(result.scanned).toBe(1);
		expect(result.closed).toBe(0);

		const mission = await getMission(t, missionId);
		expect(mission?.status).toBe("execute");
	});

	test("no GH ref in brief: mission skipped, no API call", async () => {
		const fetchMock = mockFetch({});
		const t = createTestConvex();

		// Mission with no GH URL in brief
		await insertMissionWithIssueRef(t, { issueUrl: undefined });

		const result = await t.action(
			internal.issueClosedSweep.sweepIssueClosed,
			{},
		);

		expect(result.scanned).toBe(0);
		expect(result.skipped).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("mixed missions: only closed ones affected", async () => {
		mockFetch({ 42: "closed", 99: "open" });
		const t = createTestConvex();

		const closedMission = await insertMissionWithIssueRef(t, {
			name: "IRP closed issue",
			issueUrl: CLOSED_ISSUE_URL,
			status: "execute",
		});
		const openMission = await insertMissionWithIssueRef(t, {
			name: "IRP open issue",
			issueUrl: OPEN_ISSUE_URL,
			status: "execute",
		});

		await insertTasksForMission(t, closedMission, 4, "todo");
		await insertTasksForMission(t, openMission, 4, "todo");

		const result = await t.action(
			internal.issueClosedSweep.sweepIssueClosed,
			{},
		);

		expect(result.scanned).toBe(2);
		expect(result.closed).toBe(1);

		const closedM = await getMission(t, closedMission);
		expect(closedM?.status).toBe("complete");

		const openM = await getMission(t, openMission);
		expect(openM?.status).toBe("execute");

		const openTasks = await t.run(async (ctx) =>
			ctx.db
				.query("tasks")
				.withIndex("by_status", (q) => q.eq("status", "todo"))
				.collect(),
		);
		// 4 tasks from openMission still open
		expect(openTasks.length).toBe(4);
	});

	test("GH API error (404): errors bumped, mission untouched", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 404,
				json: async () => ({}),
			}),
		);

		const t = createTestConvex();
		const missionId = await insertMissionWithIssueRef(t, {
			issueUrl: CLOSED_ISSUE_URL,
		});
		await insertTasksForMission(t, missionId, 2, "todo");

		const result = await t.action(
			internal.issueClosedSweep.sweepIssueClosed,
			{},
		);

		expect(result.scanned).toBe(1);
		expect(result.closed).toBe(0);
		expect(result.errors).toBe(1);

		const mission = await getMission(t, missionId);
		expect(mission?.status).toBe("execute");
	});
});
