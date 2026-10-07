/// <reference types="vite/client" />
/**
 * R-31 (backend-doctor) — mutations that read an unbounded set now bound the
 * read (`.take` / `.paginate`) and continue through `ctx.scheduler.runAfter(0, …)`.
 *
 * Sites pinned here (every one has a BOUNDED pole — one call does not touch the
 * whole set — and a COMPLETE pole — the continuation finishes it — plus a
 * NEGATIVE pole where another partition shares the table):
 *   kbMutations:markDocSoftDeleted
 *   issueClosedSweepDb:cascadeCloseMission
 *   recurringTasks:processDueTasks
 *   migrations/dedup_stale_deploy_tasks:dedupStaleDeployTasks
 *   migrations/agentIdentityRows:backfillAgentNormalizedNames (roster read)
 *   tasks:createDeployTaskWithDedup (project-bounded scan)
 *   tasks:complete (mission auto-complete existence check)
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

// ── kbMutations:markDocSoftDeleted ──────────────────────────────────────────

describe("kbMutations.markDocSoftDeleted", () => {
	test("BOUNDED + COMPLETE + NEGATIVE: one batch per call, the rest drains, another namespace is untouched", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < 450; i++) {
				await ctx.db.insert("memories", {
					content: "chunk",
					type: "reference",
					namespace: "team/org-x/doc-1",
					createdBy: "system",
					relations: [],
					isLatest: true,
					createdAt: now,
					updatedAt: now,
				});
			}
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert("memories", {
					content: "other doc",
					type: "reference",
					namespace: "team/org-x/doc-2",
					createdBy: "system",
					relations: [],
					isLatest: true,
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		const marked = await t.mutation(internal.kbMutations.markDocSoftDeleted, {
			namespace: "team/org-x/doc-1",
		});
		expect(marked).toBeGreaterThan(0);
		expect(marked).toBeLessThan(450); // BOUNDED

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const rows = await t.run((ctx) => ctx.db.query("memories").collect());
		expect(
			rows.filter((r) => r.namespace === "team/org-x/doc-1" && r.isLatest),
		).toHaveLength(0); // COMPLETE
		expect(
			rows.filter((r) => r.namespace === "team/org-x/doc-2" && r.isLatest),
		).toHaveLength(5); // NEGATIVE
	});
});

// ── issueClosedSweepDb:cascadeCloseMission ──────────────────────────────────

async function seedMission(t: T, name: string): Promise<Id<"missions">> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert("missions", {
			name,
			project: "vantage-memory",
			status: "execute",
			priority: "urgent",
			pilot: "sigma",
			agents: ["sigma"],
			createdBy: "sigma",
			createdAt: now,
			updatedAt: now,
		});
	});
}

async function seedMissionTasks(
	t: T,
	missionId: Id<"missions">,
	n: number,
	status: "todo" | "in_progress" | "review" | "blocked" | "done" | "cancelled" | "failed" = "todo",
) {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (let i = 0; i < n; i++) {
			await ctx.db.insert("tasks", {
				title: `t${i}`,
				assignedTo: "sigma",
				priority: "low",
				status,
				missionId,
				createdBy: "sigma",
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

describe("issueClosedSweepDb.cascadeCloseMission", () => {
	test("BOUNDED + COMPLETE + NEGATIVE: the mission is marked complete only after its last task closed", async () => {
		const t = createT();
		const mission = await seedMission(t, "m1");
		const other = await seedMission(t, "m2");
		await seedMissionTasks(t, mission, 450, "todo");
		await seedMissionTasks(t, mission, 100, "in_progress");
		await seedMissionTasks(t, other, 3, "todo");

		const res = await t.mutation(internal.issueClosedSweepDb.cascadeCloseMission, {
			missionId: mission,
			issueRef: "https://example.test/issues/1",
		});
		expect(res.tasksCompleted).toBeGreaterThan(0);
		expect(res.tasksCompleted).toBeLessThan(550); // BOUNDED
		const mid = await t.run((ctx) => ctx.db.get(mission));
		expect(mid?.status).toBe("execute"); // not complete while tasks remain open

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
		expect(
			tasks.filter((x) => x.missionId === mission && x.status !== "done"),
		).toHaveLength(0); // COMPLETE
		expect(
			tasks.filter((x) => x.missionId === other && x.status === "todo"),
		).toHaveLength(3); // NEGATIVE
		expect((await t.run((ctx) => ctx.db.get(mission)))?.status).toBe("complete");
		expect((await t.run((ctx) => ctx.db.get(other)))?.status).toBe("execute");
	});

	test("a small mission still closes in the one call and is complete at once", async () => {
		const t = createT();
		const mission = await seedMission(t, "small");
		await seedMissionTasks(t, mission, 3, "todo");
		const res = await t.mutation(internal.issueClosedSweepDb.cascadeCloseMission, {
			missionId: mission,
			issueRef: "https://example.test/issues/2",
		});
		expect(res.tasksCompleted).toBe(3);
		expect((await t.run((ctx) => ctx.db.get(mission)))?.status).toBe("complete");
		const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(scheduled).toHaveLength(0);
	});
});

// ── recurringTasks:processDueTasks ──────────────────────────────────────────

async function seedRecurring(
	t: T,
	n: number,
	o: { active?: boolean; due?: boolean; cron?: string; title?: string } = {},
) {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (let i = 0; i < n; i++) {
			await ctx.db.insert("recurringTasks", {
				title: `${o.title ?? "rec"} ${i}`,
				assignedTo: "sigma",
				priority: "low",
				cronExpression: o.cron ?? "0 9 * * *",
				nextRunAt: o.due === false ? now + 3_600_000 : now - 1000,
				active: o.active ?? true,
				createdBy: "sigma",
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

describe("recurringTasks.processDueTasks", () => {
	test("BOUNDED + COMPLETE + NEGATIVE: one batch per run; the due rows all fire; not-due and inactive rows do not", async () => {
		const t = createT();
		await seedRecurring(t, 250, { title: "due" });
		await seedRecurring(t, 5, { title: "future", due: false });
		await seedRecurring(t, 5, { title: "paused", active: false });

		const first = await t.mutation(internal.recurringTasks.processDueTasks, {});
		expect(first.created).toBeGreaterThan(0);
		expect(first.created).toBeLessThan(250); // BOUNDED

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
		expect(tasks.filter((x) => x.title.startsWith("due "))).toHaveLength(250); // COMPLETE, once each
		expect(tasks.filter((x) => x.title.startsWith("future "))).toHaveLength(0);
		expect(tasks.filter((x) => x.title.startsWith("paused "))).toHaveLength(0);
	});

	test("a poison row (malformed cron) is skipped and neither blocks the drain nor loops it", async () => {
		const t = createT();
		await seedRecurring(t, 3, { title: "poison", cron: "not a cron" });
		await seedRecurring(t, 250, { title: "good" });
		await t.mutation(internal.recurringTasks.processDueTasks, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
		expect(tasks.filter((x) => x.title.startsWith("good "))).toHaveLength(250);
		expect(tasks.filter((x) => x.title.startsWith("poison "))).toHaveLength(0);
		const pending = (
			await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
		).filter((f) => f.state.kind === "pending");
		expect(pending).toHaveLength(0);
	});
});

// ── migrations/dedup_stale_deploy_tasks ─────────────────────────────────────

const deployTitle = (pr: number, repo: string) =>
	`[Deploy] PR #${pr} merged — deploy ${repo} to prod`;

describe("migrations/dedup_stale_deploy_tasks.dedupStaleDeployTasks", () => {
	test("BOUNDED + COMPLETE across pages: duplicates split over pages are still superseded, the newest kept, plain tasks untouched", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			const base = Date.now();
			const mk = (title: string, createdAt: number) =>
				ctx.db.insert("tasks", {
					title,
					assignedTo: "sigma",
					priority: "low",
					status: "todo",
					createdBy: "sigma",
					createdAt,
					updatedAt: createdAt,
				});
			// Oldest duplicate first, then 450 unrelated tasks, then the newer duplicate:
			// the pair straddles page boundaries.
			await mk(deployTitle(7, "repo-a"), base);
			for (let i = 0; i < 450; i++) await mk(`plain ${i}`, base + 1 + i);
			await mk(deployTitle(7, "repo-a"), base + 1000);
			await mk(deployTitle(8, "repo-a"), base + 1001); // single: kept
		});

		const first = await t.mutation(
			internal.migrations.dedup_stale_deploy_tasks.dedupStaleDeployTasks,
			{},
		);
		expect(first.isDone).toBe(false); // BOUNDED: the sweep did not finish in one transaction
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
		const pr7 = tasks.filter((x) => x.title === deployTitle(7, "repo-a"));
		expect(pr7.filter((x) => x.status === "done")).toHaveLength(1);
		expect(pr7.filter((x) => x.status === "todo")).toHaveLength(1);
		const newest = pr7.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
		expect(newest.status).toBe("todo"); // the newest is the one kept
		expect(tasks.filter((x) => x.title.startsWith("plain ") && x.status !== "todo")).toHaveLength(0);
		expect(tasks.find((x) => x.title === deployTitle(8, "repo-a"))?.status).toBe("todo");
	});

	test("an empty board is a clean zero", async () => {
		const t = createT();
		const res = await t.mutation(
			internal.migrations.dedup_stale_deploy_tasks.dedupStaleDeployTasks,
			{},
		);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(res.closed).toBe(0);
	});
});

// ── migrations/agentIdentityRows:backfillAgentNormalizedNames ───────────────

describe("migrations/agentIdentityRows.backfillAgentNormalizedNames", () => {
	test("a roster larger than the scan cap is REFUSED (counted, never guessed), not read whole", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 0; i < 501; i++) {
				await ctx.db.insert("agents", {
					orgSlug: "big-org",
					name: `agent-${i}`,
					normalizedName: `agent-${i}`,
					isActive: true,
					createdAt: Date.now(),
				});
			}
			await ctx.db.insert("agents", {
				orgSlug: "big-org",
				name: "Needs-Backfill",
				isActive: true,
				createdAt: Date.now(),
			});
		});
		let collisions = 0;
		let updated = 0;
		let cursor: string | null = null;
		for (let guard = 0; guard < 10; guard++) {
			const r: {
				collisions: number;
				updated: number;
				isDone: boolean;
				continueCursor: string;
			} = await t.mutation(
				internal.migrations.agentIdentityRows.backfillAgentNormalizedNames,
				{ dryRun: false, cursor, batchSize: 200 },
			);
			collisions += r.collisions;
			updated += r.updated;
			if (r.isDone) break;
			cursor = r.continueCursor;
		}
		expect(collisions).toBe(1);
		expect(updated).toBe(0);
	});

	test("a normal roster still backfills and a real clash is still counted", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("agents", { orgSlug: "o", name: "Solo", isActive: true, createdAt: 1 });
			await ctx.db.insert("agents", { orgSlug: "o", name: "Twin", isActive: true, createdAt: 2 });
			await ctx.db.insert("agents", { orgSlug: "o", name: "twin", isActive: true, createdAt: 3 });
		});
		const r = await t.mutation(
			internal.migrations.agentIdentityRows.backfillAgentNormalizedNames,
			{ dryRun: false, cursor: null },
		);
		expect(r.updated).toBe(1);
		expect(r.collisions).toBe(2);
	});
});

// ── tasks:createDeployTaskWithDedup ─────────────────────────────────────────

describe("tasks.createDeployTaskWithDedup", () => {
	const args = (title: string, project: string) => ({
		title,
		project,
		assignedTo: "sigma",
		priority: "low" as const,
		createdBy: "sigma",
	});

	test("dedups against the open deploy task of the same project, and does not scan another project's partition", async () => {
		const t = createT();
		const first = await t.mutation(
			internal.tasks.createDeployTaskWithDedup,
			args(deployTitle(11, "repo-a"), "repo-a"),
		);
		const again = await t.mutation(
			internal.tasks.createDeployTaskWithDedup,
			args(deployTitle(11, "repo-a"), "repo-a"),
		);
		expect(again).toBe(first);

		// A same-titled open task filed under ANOTHER project is a different
		// partition of the (project, status) index and is not read, so it is not
		// a duplicate of the one created for repo-a.
		const foreign = await t.run(async (ctx) => {
			const now = Date.now();
			return ctx.db.insert("tasks", {
				title: deployTitle(12, "repo-a"),
				project: "elsewhere",
				assignedTo: "sigma",
				priority: "low",
				status: "todo",
				createdBy: "sigma",
				createdAt: now,
				updatedAt: now,
			});
		});
		const created = await t.mutation(
			internal.tasks.createDeployTaskWithDedup,
			args(deployTitle(12, "repo-a"), "repo-a"),
		);
		expect(created).not.toBe(foreign);
		const foreignRow = await t.run((ctx) => ctx.db.get(foreign));
		expect(foreignRow?.status).toBe("todo"); // not superseded either
	});
});

// ── tasks:complete — mission auto-complete existence check ──────────────────

describe("tasks.complete — mission auto-complete", () => {
	const asMaster = (t: T) =>
		t.withIdentity({ subject: "test-service-account-user-id" } as Parameters<
			T["withIdentity"]
		>[0]);

	async function setup(siblingStatus: "done" | "todo" | "cancelled" | "failed" | "blocked" | "in_progress" | "review") {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: Date.now(),
			});
		});
		const mission = await seedMission(t, "mc");
		await seedMissionTasks(t, mission, 1, siblingStatus);
		const last = await t.run(async (ctx) => {
			const now = Date.now();
			return ctx.db.insert("tasks", {
				title: "last",
				assignedTo: "sigma",
				priority: "low",
				status: "in_progress",
				missionId: mission,
				createdBy: "sigma",
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			});
		});
		await asMaster(t).mutation(api.tasks.complete, {
			taskId: last,
			completionNote: "closing the last task of the mission, evidence abc1234",
			callerOrchestrator: "system",
		});
		return (await t.run((ctx) => ctx.db.get(mission)))?.status;
	}

	test("every sibling done -> the mission completes", async () => {
		expect(await setup("done")).toBe("complete");
	});

	for (const s of ["todo", "in_progress", "review", "blocked", "cancelled", "failed"] as const) {
		test(`a ${s} sibling keeps the mission open`, async () => {
			expect(await setup(s)).toBe("execute");
		});
	}
});
