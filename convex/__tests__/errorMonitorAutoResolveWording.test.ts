/// <reference types="vite/client" />
/**
 * D4 -- an error that merely stopped recurring, or whose issue was closed, is
 * NOT reported as having "succeeded" / been "resolved" / "fixed". The wording
 * is factual: "no recurrence observed since <t>" / "closed by <actor>".
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import {
	buildAutoResolveNote,
	buildIssueClosedNote,
} from "../errorMonitorAutoResolveNote";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

describe("note builders", () => {
	test("the auto-resolve note says what was observed, with the time", () => {
		const t = Date.UTC(2026, 10, 27, 8, 0, 0);
		const n = buildAutoResolveNote(t);
		expect(n).toContain("no recurrence observed since 2026-11-27T08:00:00.000Z");
		expect(n).toContain("not a verified fix");
		expect(n).not.toMatch(/succeed|resolved|success/i);
	});

	test("the issue-closed note names the closer and asserts no outcome", () => {
		const n = buildIssueClosedNote("#12", "outside VP");
		expect(n).toContain("closed by outside VP");
		expect(n).not.toMatch(/succeed|resolved|success/i);
	});
});

describe("resolveStaleIrpMission", () => {
	test("closes tasks WITHOUT a 'succeeded' outcome and with a factual note", async () => {
		const t = convexTest(schema, modules);
		const { errorId, missionId, taskId } = await t.run(async (ctx) => {
			const missionId = await ctx.db.insert("missions", {
				name: "[Auto] irp",
				project: "p",
				status: "execute",
				priority: "medium",
				pilot: "sigma",
				agents: [],
				createdBy: "sigma",
				createdAt: 1,
				updatedAt: 1,
			});
			const errorId = await ctx.db.insert("errorLogs", {
				hash: "w1",
				deployment: "prod",
				functionName: "a:b",
				errorMessage: "Uncaught Error: x",
				firstSeen: 1,
				lastSeen: Date.UTC(2026, 10, 20, 0, 0, 0),
				count: 3,
				irpMissionId: missionId,
			});
			const taskId = await ctx.db.insert("tasks", {
				title: "T0",
				project: "p",
				assignedTo: "sigma",
				priority: "medium",
				status: "todo",
				createdBy: "sigma",
				missionId,
				createdAt: 1,
				updatedAt: 1,
			});
			return { errorId, missionId, taskId };
		});

		await t.mutation(internal.errorMonitor.resolveStaleIrpMission, {
			errorLogId: errorId,
			missionId,
		});

		const task = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(task?.status).toBe("done");
		expect(task?.completionOutcome).toBeUndefined();
		expect(task?.completionNote).toContain(
			"no recurrence observed since 2026-11-20T00:00:00.000Z",
		);
		expect(task?.completionNote).not.toMatch(/succeed|resolved|success/i);
	});
});

describe("issueClosedSweepDb.cascadeCloseMission", () => {
	test("an externally closed issue closes tasks without asserting 'succeeded'", async () => {
		const t = convexTest(schema, modules);
		const { missionId, taskId } = await t.run(async (ctx) => {
			const missionId = await ctx.db.insert("missions", {
				name: "m",
				project: "p",
				status: "execute",
				priority: "medium",
				pilot: "sigma",
				agents: [],
				createdBy: "sigma",
				createdAt: 1,
				updatedAt: 1,
			});
			const taskId = await ctx.db.insert("tasks", {
				title: "T0",
				project: "p",
				assignedTo: "sigma",
				priority: "medium",
				status: "todo",
				createdBy: "sigma",
				missionId,
				createdAt: 1,
				updatedAt: 1,
			});
			return { missionId, taskId };
		});
		await t.mutation(internal.issueClosedSweepDb.cascadeCloseMission, {
			missionId,
			issueRef: "org/repo#12",
		});
		const task = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(task?.status).toBe("done");
		expect(task?.completionOutcome).toBeUndefined();
		expect(task?.completionNote).toContain("closed by");
		expect(task?.completionNote).not.toMatch(/succeed|resolved|success/i);
	});
});
