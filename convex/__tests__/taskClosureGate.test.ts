/// <reference types="vite/client" />
/**
 * convex/__tests__/taskClosureGate.test.ts
 *
 * Day 130 (k17dhcmzqafve1ayzvh833kf558ae019) — server-side task-closure
 * discipline. Billing source = machine timestamps (startedAt/completedAt/
 * actualMinutes), never a hand-typed time breakdown.
 *
 * RED cases (TDD-strict, run before implementation):
 *   (a) close a billable-project task with startedAt null → REJECTED
 *   (b) close a billable-project task with startedAt present → PASSES,
 *       actualMinutes computed
 *   (c) close with "// allow-no-time-line: <reason>" override → PASSES
 *   (d) close a NON-billable task with startedAt null → PASSES (no false
 *       positive)
 *   (e) bulkComplete on a billable task with startedAt null → REJECTED
 *       (second closure path — prove it is not blind)
 *
 * Bonus: fail-closed when taskClosureConfig is not seeded at all.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

// `backfill` was in this exclusion list, which meant the backfill migration —
// the subject of the fix below — was never loaded, so nothing could exercise it.
// The named fear needs the named test: I wrote "a page of zero updates is not a
// finish line" into the PR body and then shipped no test that could catch it.
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);

const BILLABLE_PROJECT = "vantage-immo";
const NON_BILLABLE_PROJECT = "vantage-peers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedBillableConfig(t: any) {
	await t.run(async (ctx: any) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [BILLABLE_PROJECT],
			updatedAt: Date.now(),
		});
	});
}

describe("task closure gate — tasks.complete (Day 130)", () => {
	test("(a) billable project + startedAt null → REJECTED with actionable error", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Billable work never started",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "high" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await expect(
			t.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "Did the work, forgot to call start_task first",
			}),
		).rejects.toThrow(/TASK_NEVER_STARTED_BILLABLE/);
	});

	test("(b) billable project + startedAt present → PASSES, actualMinutes computed", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Billable work started properly",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "high" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await t.mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "sigma",
		});

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote: "Done — PR #123 merged",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
		expect(task?.actualMinutes).toBeDefined();
		expect(typeof task?.actualMinutes).toBe("number");
	});

	test("(c) override marker lets closure through without startedAt", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Mis-tagged non-billable task",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "low" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote:
				"Migration cleanup task, not real billable work // allow-no-time-line: migration cleanup",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
	});

	test("(d) non-billable project + startedAt null → PASSES (no false positive)", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Internal task never started",
			project: NON_BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "medium" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote: "Internal chore, no need to track billing time",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
	});

	test("fail-closed: taskClosureConfig not seeded at all → loud rejection naming the gap", async () => {
		const t = convexTest(schema, modules);
		// Deliberately NOT seeding taskClosureConfig.

		const taskId = await t.mutation(api.tasks.create, {
			title: "Task with a project but no config exists yet",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "high" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await expect(
			t.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "Attempting to close without any config seeded",
			}),
		).rejects.toThrow(/TASK_CLOSURE_CONFIG_UNRESOLVABLE/);
	});
});

describe("task closure gate — tasks.bulkComplete (Day 130, second closure path)", () => {
	test("(e) billable task with startedAt null → REJECTED via bulkComplete", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		await t.mutation(api.tasks.create, {
			title: "Billable bulk task never started",
			project: BILLABLE_PROJECT,
			assignedTo: "bulk-bot",
			priority: "medium" as const,
			status: "todo" as const,
			createdBy: "cron-sweeper",
		});

		await expect(
			t.mutation(api.tasks.bulkComplete, {
				filter: { assignedTo: "bulk-bot" },
				dryRun: false,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/TASK_NEVER_STARTED_BILLABLE/);
	});
});

// Eta review of PR #1086: the `update` path was GATED but never PROVEN to bite —
// deleting its gate reddened nothing. Gating three paths while only testing two
// reproduces, one level down, the very coverage blind spot this gate exists to
// close. `update` is the generic status:"done" patch, i.e. the MCP update_task
// call — the closure path most reachable by a human.
describe("task closure gate — tasks.update (Day 130, third closure path)", () => {
	test("(i) billable task with startedAt null → REJECTED via update({status:'done'})", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Billable task closed via generic update",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "high" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await expect(
			t.mutation(api.tasks.update, {
				taskId,
				status: "done" as const,
				callerOrchestrator: "sigma",
				completionNote: "Closing straight through update_task, never started",
			}),
		).rejects.toThrow(/TASK_NEVER_STARTED_BILLABLE/);
	});

	test("(j) billable task with startedAt present → PASSES via update, actualMinutes derived", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Billable task properly started, closed via update",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "high" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await t.mutation(api.tasks.start, { taskId, callerOrchestrator: "sigma" });

		await t.mutation(api.tasks.update, {
			taskId,
			status: "done" as const,
			callerOrchestrator: "sigma",
			completionNote: "Done — PR #1086",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
		expect(task?.actualMinutes).toBeDefined();
	});

	test("(k) non-billable task with startedAt null → PASSES via update (no false positive)", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Internal task, never started, closed via update",
			project: "internal-fleet",
			assignedTo: "sigma",
			priority: "low" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await t.mutation(api.tasks.update, {
			taskId,
			status: "done" as const,
			callerOrchestrator: "sigma",
			completionNote: "Internal chore, not billable",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
	});
});

// Eta (reviewer, on the ground) reported PR #1086's gate over-blocks: GitHub-
// webhook auto-created review tasks (createdBy: "system") on billable
// projects can never have startedAt — nobody calls start_task on them by
// construction — so every review closure was rejected. AUTO-1/AUTO-2 prove
// the fix; AUTO-3 proves the fix does NOT simply disarm the gate for
// human-created work (must stay RED/rejecting before and after the fix).
//
// Day 130 follow-up #2: these tasks are now minted via the internal
// `createOrUpdateReviewTask` mutation (the REAL webhook path), not the
// public `tasks.create` mutation with a forged `createdBy: "system"` — the
// public mutation now rejects that value outright (defense in depth), and
// the closure-gate exemption is driven by `origin: "automation"`, which
// only this internal path can write.
describe("task closure gate — automation-created tasks exempt (Day 130 follow-up)", () => {
	test("(AUTO-1) webhook-created billable task with no startedAt → PASSES via complete, no override needed", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(internal.tasks.createOrUpdateReviewTask, {
			repoFullName: "elpiarthera/vantage-immo",
			prNumber: 234,
			prTitle: "Fix billing gate",
			assignedTo: "eta",
			project: BILLABLE_PROJECT,
			priority: "high" as const,
			createdBy: "system",
		});

		await t.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "eta",
			completionNote: "Reviewed and approved, PR #234 merged",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
	});

	test("(AUTO-2) webhook-created billable task with no startedAt → PASSES via update({status:'done'})", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(internal.tasks.createOrUpdateReviewTask, {
			repoFullName: "elpiarthera/vantage-immo",
			prNumber: 235,
			prTitle: "Fix billing gate again",
			assignedTo: "eta",
			project: BILLABLE_PROJECT,
			priority: "high" as const,
			createdBy: "system",
		});

		await t.mutation(api.tasks.update, {
			taskId,
			status: "done" as const,
			callerOrchestrator: "eta",
			completionNote: "Reviewed and approved, PR #235 merged",
		});

		const task = await t.query(api.tasks.get, { taskId });
		expect(task?.status).toBe("done");
	});

	test("(AUTO-3, non-regression) human-created billable task with no startedAt → STILL REJECTED", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		const taskId = await t.mutation(api.tasks.create, {
			title: "Billable work never started, human-authored",
			project: BILLABLE_PROJECT,
			assignedTo: "sigma",
			priority: "high" as const,
			status: "todo" as const,
			createdBy: "sigma",
		});

		await expect(
			t.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "Did the work, forgot to call start_task first",
			}),
		).rejects.toThrow(/TASK_NEVER_STARTED_BILLABLE/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// FORGE-1/2/3 — Eta's REVISE verdict on PR #1089 (Day 130 follow-up #2).
//
// `createdBy` is not a fact derived from an internal-only code path — it is
// a caller-supplied string argument on the PUBLIC `tasks.create` mutation
// (and RBAC on `update`/`bulkComplete` special-cases the literal "system").
// Any MCP caller can therefore forge `createdBy: "system"` and permanently
// exempt a billable task from the closure gate.
//
// NOTE: an earlier draft of this suite also asserted that the public
// `create` mutation rejects `createdBy: "system"` outright ("FORGE-0",
// defense in depth per the original brief). That guard was implemented and
// then REMOVED: `createdBy: "system"` is used throughout this codebase as a
// plain non-billing convention — RBAC-bypass semantics on
// update/complete/bulkComplete/start/deleteTask, and as a generic creator
// string in stats/bridge-automation test fixtures (see
// convex/__tests__/tasksMutationConvexErrors.test.ts,
// convex/stats.test.ts). Rejecting it at `create` time regressed 44
// pre-existing tests. The billing-bypass vulnerability is fully closed by
// the `origin`-based gate below, independent of `createdBy`, so the
// narrower fix was kept and the broader reservation was dropped.
//
// FORGE-1/2/3 prove the gate itself is inforgeable: they insert a raw task
// doc directly via `t.run` (bypassing `tasks.create` entirely) with
// `createdBy: "system"` and NO `origin` field — i.e. exactly what a forged
// public-create call produces today (since `createdBy: "system"` is NOT
// rejected). If the gate reads `createdBy` instead of `origin`, these tasks
// close despite never having a startedAt. These three tests reproduce the
// forgery via the three public closure paths (complete, update,
// bulkComplete) and must be RED before the `origin`-based fix lands.
// ─────────────────────────────────────────────────────────────────────────────
describe("task closure gate — FORGE createdBy:'system' (Day 130 follow-up #2)", () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async function seedForgedTask(t: any, assignedTo: string) {
		return await t.run(async (ctx: any) => {
			const now = Date.now();
			return await ctx.db.insert("tasks", {
				title: `Billable work never started, forged as system (${assignedTo})`,
				project: BILLABLE_PROJECT,
				assignedTo,
				priority: "high" as const,
				status: "todo" as const,
				createdBy: "system",
				// Deliberately NO `origin` field — this is what a forged
				// createdBy:"system" task looks like: the gate must not be
				// fooled by createdBy alone.
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	test("(FORGE-1) task with createdBy:'system' but no origin, closes via complete → must be REJECTED", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);
		const taskId = await seedForgedTask(t, "sigma");

		await expect(
			t.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "Did the work, forged createdBy to dodge the gate",
			}),
		).rejects.toThrow(/TASK_NEVER_STARTED_BILLABLE/);
	});

	test("(FORGE-2) task with createdBy:'system' but no origin, closes via update({status:'done'}) → must be REJECTED", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);
		const taskId = await seedForgedTask(t, "sigma");

		await expect(
			t.mutation(api.tasks.update, {
				taskId,
				status: "done" as const,
				callerOrchestrator: "sigma",
				completionNote: "Did the work, forged createdBy to dodge the gate",
			}),
		).rejects.toThrow(/TASK_NEVER_STARTED_BILLABLE/);
	});

	test("(FORGE-3) task with createdBy:'system' but no origin, closes via bulkComplete → must be REJECTED", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);
		await seedForgedTask(t, "sigma-forge-3");

		await expect(
			t.mutation(api.tasks.bulkComplete, {
				filter: { assignedTo: "sigma-forge-3" },
				dryRun: false,
				callerOrchestrator: "sigma-forge-3",
			}),
		).rejects.toThrow(/TASK_NEVER_STARTED_BILLABLE/);
	});
});

// =============================================================================
// Day 130 follow-up #3 (Eta REVISE, PR #1091) — the backfill migration.
//
// The first version used `.take(batchSize)`: it grabbed the first N candidate
// rows (createdBy:"system", no origin), patched only those whose title matched
// the webhook's [Review] format, and left the rest untouched — so they stayed
// candidates, and the NEXT call re-fetched the SAME N. It could never reach the
// [Review] tasks. Against production it returned {updated: 0, skipped: 100} and
// made zero progress.
//
// The lethal part was the REPORT, not the stall: the instruction said "re-run
// until updated:0", but updated:0 is ALSO the stuck state. "I made no progress"
// and "the work is finished" printed the same thing.
//
// This suite pins the fear I named in the PR body and then failed to test:
// A PAGE OF ZERO UPDATES IS NOT A FINISH LINE.
// =============================================================================

describe("backfill migration — the cursor must walk past a zero-update page", () => {
	test("(WALK-1) a zero-update middle page does NOT end the walk; isDone does", async () => {
		const t = convexTest(schema, modules);
		await seedBillableConfig(t);

		// One page's worth of NON-matching system rows (they will always be
		// `skipped`, never patched — exactly the rows that trapped the old
		// `.take()` version), and ONE real [Review] row placed AFTER them.
		const PAGE = 5;
		await t.run(async (ctx) => {
			for (let i = 0; i < PAGE * 2; i++) {
				await ctx.db.insert("tasks", {
					title: `cron heartbeat ${i}`, // NOT the webhook's [Review] format
					assignedTo: "sigma", priority: "low", status: "todo",
					createdBy: "system", project: BILLABLE_PROJECT,
					createdAt: Date.now(), updatedAt: Date.now(),
				});
			}
			await ctx.db.insert("tasks", {
				title: "[Review] owner/repo PR #7: a real webhook-minted review task",
				assignedTo: "eta", priority: "high", status: "todo",
				createdBy: "system", project: BILLABLE_PROJECT,
				createdAt: Date.now(), updatedAt: Date.now(),
			});
		});

		// Walk the cursor exactly as the operator does. Stop on isDone, NEVER on
		// updated===0 — the whole point.
		let cursor: string | null = null;
		let pages = 0;
		let totalUpdated = 0;
		let sawZeroUpdatePageBeforeTheEnd = false;
		for (;;) {
			const r: { updated: number; skipped: number; isDone: boolean; nextCursor: string | null } =
				await t.mutation(internal.migrations.backfill_review_task_origin.backfillOrigin, {
					cursor, batchSize: PAGE,
				});
			pages++;
			totalUpdated += r.updated;
			if (r.updated === 0 && !r.isDone) sawZeroUpdatePageBeforeTheEnd = true;
			if (r.isDone) break;
			cursor = r.nextCursor;
			expect(pages).toBeLessThan(20); // the walk must terminate, not spin
		}

		expect(sawZeroUpdatePageBeforeTheEnd).toBe(true); // the trap was actually laid
		expect(pages).toBeGreaterThan(1); // it really did walk more than one page
		expect(totalUpdated).toBe(1); // and it REACHED the [Review] row past the zero page

		// The old `.take()` code stops at the first zero-update page and never
		// patches this row. That is the regression this test exists to catch.
		await t.run(async (ctx) => {
			const rows = await ctx.db.query("tasks").collect();
			const review = rows.find((r) => r.title.startsWith("[Review]"));
			expect(review?.origin).toBe("automation");
			// And nothing else was touched — a data repair that widens its own
			// scope is how a fix becomes an incident.
			expect(rows.filter((r) => r.origin === "automation")).toHaveLength(1);
		});
	});
});
