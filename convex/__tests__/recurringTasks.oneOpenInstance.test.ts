/// <reference types="vite/client" />
//
// One open instance per routine (task k1770awc8jq7bqa6w78jbz5gqx8cdvxj).
//
// Defect: `processDueTasks` inserted a task at every due tick without asking
// whether the previous instance of the same schedule was still open, so a daily
// routine nobody executes stacked one task per day forever.
//
// Contract pinned here: a due tick whose previous instance is still open
// (todo / in_progress / review / blocked) creates NOTHING, advances `nextRunAt`
// like a normal run, and records the skip on the schedule row
// (`skippedRuns`, `lastSkippedAt`, `lastSkipReason`). A closed (done /
// cancelled) instance lets the next tick create again.
//
// Orchestrator: Sigma — VantagePeers | 2026-10-25

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	LEGACY_OPEN_LOOKUP_BOUND,
	PROCESS_DUE_SCAN_BUDGET,
} from "../recurringTasks";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const DAY = 24 * 60 * 60 * 1000;

async function seedSchedule(
	t: T,
	opts: {
		title?: string;
		assignedTo?: string;
		orgId?: string;
		assignedToId?: string;
	} = {},
): Promise<Id<"recurringTasks">> {
	const past = Date.now() - 60_000;
	return await t.run(async (ctx) =>
		ctx.db.insert("recurringTasks", {
			title: opts.title ?? "Daily routine",
			assignedTo: opts.assignedTo ?? "sigma",
			priority: "medium" as const,
			cronExpression: "0 9 * * *",
			nextRunAt: past,
			active: true,
			createdBy: "sigma",
			...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
			...(opts.assignedToId !== undefined
				? { assignedToId: opts.assignedToId }
				: {}),
			createdAt: past,
			updatedAt: past,
		}),
	);
}

/** Make the schedule due again, as if its next cron time had arrived. */
async function makeDue(t: T, id: Id<"recurringTasks">) {
	await t.run(async (ctx) => {
		await ctx.db.patch(id, { nextRunAt: Date.now() - 1_000 });
	});
}

async function tick(t: T) {
	return await t.mutation(internal.recurringTasks.processDueTasks, {});
}

async function tasksTitled(t: T, title: string) {
	return await t.run(async (ctx) =>
		(await ctx.db.query("tasks").collect()).filter((x) => x.title === title),
	);
}

async function row(t: T, id: Id<"recurringTasks">) {
	return await t.run(async (ctx) => ctx.db.get(id));
}

const OPEN = ["todo", "in_progress", "review", "blocked"] as const;

describe("processDueTasks — two open instances of one routine never coexist", () => {
	let t: T;
	beforeEach(() => {
		t = createT();
	});

	test("a second due tick with the first instance still open creates nothing and records the skip", async () => {
		const id = await seedSchedule(t);
		await tick(t);
		const [first] = await tasksTitled(t, "Daily routine");
		expect(first).toBeDefined();
		const afterFirst = await row(t, id);
		expect(afterFirst?.lastTaskId).toBe(first._id);
		expect(afterFirst?.skippedRuns).toBe(0);

		await makeDue(t, id);
		const dueAt = Date.now() - 1_000;
		await tick(t);

		const open = (await tasksTitled(t, "Daily routine")).filter((x) =>
			(OPEN as readonly string[]).includes(x.status),
		);
		expect(open).toHaveLength(1);
		expect(open[0]._id).toBe(first._id);

		const skipped = await row(t, id);
		expect(skipped?.skippedRuns).toBe(1);
		expect(typeof skipped?.lastSkippedAt).toBe("number");
		expect(skipped?.lastSkipReason).toContain(first._id);
		expect(skipped?.lastTaskId).toBe(first._id);
		expect(skipped?.nextRunAt).toBeGreaterThan(dueAt + 1_000);
		expect(skipped?.nextRunAt).toBeGreaterThan(Date.now());

		// A third tick keeps counting and still creates nothing.
		await makeDue(t, id);
		await tick(t);
		expect(await tasksTitled(t, "Daily routine")).toHaveLength(1);
		expect((await row(t, id))?.skippedRuns).toBe(2);
	});

	test.each(OPEN)("an instance in status %s blocks the next tick", async (status) => {
		const id = await seedSchedule(t);
		await tick(t);
		const [first] = await tasksTitled(t, "Daily routine");
		await t.run(async (ctx) => {
			await ctx.db.patch(first._id, { status });
		});
		await makeDue(t, id);
		await tick(t);
		expect(await tasksTitled(t, "Daily routine")).toHaveLength(1);
		expect((await row(t, id))?.skippedRuns).toBe(1);
	});

	test.each(["done", "cancelled"] as const)(
		"once the instance is %s the next due tick creates a new one and resets the skip counter",
		async (terminal) => {
			const id = await seedSchedule(t);
			await tick(t);
			const [first] = await tasksTitled(t, "Daily routine");

			await makeDue(t, id);
			await tick(t); // skipped
			expect((await row(t, id))?.skippedRuns).toBe(1);

			await t.run(async (ctx) => {
				await ctx.db.patch(first._id, { status: terminal });
			});
			await makeDue(t, id);
			await tick(t);

			const all = await tasksTitled(t, "Daily routine");
			expect(all).toHaveLength(2);
			const second = all.find((x) => x._id !== first._id);
			expect(second?.status).toBe("todo");
			const after = await row(t, id);
			expect(after?.skippedRuns).toBe(0);
			expect(after?.lastTaskId).toBe(second?._id);
		},
	);

	test("a deleted previous instance does not block the schedule", async () => {
		const id = await seedSchedule(t);
		await tick(t);
		const [first] = await tasksTitled(t, "Daily routine");
		await t.run(async (ctx) => {
			await ctx.db.delete(first._id);
		});
		await makeDue(t, id);
		await tick(t);
		expect(await tasksTitled(t, "Daily routine")).toHaveLength(1);
		expect((await row(t, id))?.lastTaskId).not.toBe(first._id);
	});
});

describe("processDueTasks — legacy rows without lastTaskId", () => {
	let t: T;
	beforeEach(() => {
		t = createT();
	});

	async function seedOpenTask(
		title: string,
		opts: { assignedTo: string; orgId?: string; status?: (typeof OPEN)[number] },
	) {
		return await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title,
				assignedTo: opts.assignedTo,
				priority: "medium" as const,
				status: opts.status ?? "todo",
				createdBy: "sigma",
				...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
				createdAt: Date.now() - DAY,
				updatedAt: Date.now() - DAY,
			}),
		);
	}

	test("an open same-title same-assignee same-org task blocks creation and is adopted as lastTaskId", async () => {
		const id = await seedSchedule(t, { orgId: "org-a" });
		const open = await seedOpenTask("Daily routine", {
			assignedTo: "sigma",
			orgId: "org-a",
			status: "in_progress",
		});
		await tick(t);
		expect(await tasksTitled(t, "Daily routine")).toHaveLength(1);
		const r = await row(t, id);
		expect(r?.skippedRuns).toBe(1);
		expect(r?.lastSkipReason).toContain(open);
		expect(r?.lastSkipReason).toContain("in_progress");
		expect(r?.lastTaskId).toBe(open);
	});

	test("the same title in ANOTHER org does not block", async () => {
		const id = await seedSchedule(t, { orgId: "org-a" });
		await seedOpenTask("Daily routine", { assignedTo: "sigma", orgId: "org-b" });
		await tick(t);
		const mine = (await tasksTitled(t, "Daily routine")).filter(
			(x) => x.orgId === "org-a",
		);
		expect(mine).toHaveLength(1);
		expect((await row(t, id))?.skippedRuns).toBe(0);
	});

	test("an unstamped (fleet) open task does not block an org-stamped schedule", async () => {
		await seedSchedule(t, { orgId: "org-a" });
		await seedOpenTask("Daily routine", { assignedTo: "sigma" });
		await tick(t);
		const mine = (await tasksTitled(t, "Daily routine")).filter(
			(x) => x.orgId === "org-a",
		);
		expect(mine).toHaveLength(1);
	});

	test("the same title for ANOTHER assignee agent ID does not block", async () => {
		await seedSchedule(t, { orgId: "org-a", assignedToId: "agent-sigma-1" });
		await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "Daily routine",
				assignedTo: "clio",
				assignedToId: "agent-clio-1",
				priority: "medium" as const,
				status: "todo" as const,
				createdBy: "sigma",
				orgId: "org-a",
				createdAt: Date.now() - DAY,
				updatedAt: Date.now() - DAY,
			}),
		);
		await tick(t);
		const mine = (await tasksTitled(t, "Daily routine")).filter(
			(x) => x.assignedTo === "sigma",
		);
		expect(mine).toHaveLength(1);
	});

	test("a schedule WITHOUT an agent ID never compares an assignee name: a same-title open task in its org blocks, whoever holds it", async () => {
		const id = await seedSchedule(t, { orgId: "org-a" });
		const other = await seedOpenTask("Daily routine", {
			assignedTo: "clio",
			orgId: "org-a",
		});
		await tick(t);
		expect(await tasksTitled(t, "Daily routine")).toHaveLength(1);
		const r = await row(t, id);
		expect(r?.skippedRuns).toBe(1);
		expect(r?.lastTaskId).toBe(other);
	});

	test("a lookup that hits its bound is UNKNOWN: the tick skips loudly instead of creating", async () => {
		const id = await seedSchedule(t, { orgId: "org-a" });
		await t.run(async (ctx) => {
			for (let i = 0; i < LEGACY_OPEN_LOOKUP_BOUND; i++) {
				await ctx.db.insert("tasks", {
					title: `unrelated ${i}`,
					assignedTo: "sigma",
					priority: "low" as const,
					status: "todo" as const,
					createdBy: "sigma",
					orgId: "org-a",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
		});
		await tick(t);
		expect(await tasksTitled(t, "Daily routine")).toHaveLength(0);
		const r = await row(t, id);
		expect(r?.skippedRuns).toBe(1);
		expect(r?.lastSkipReason).toContain("lookup hit its bound");
		expect(r?.lastTaskId).toBeUndefined();
	});

	test("a closed same-title task does not block", async () => {
		await seedSchedule(t, { orgId: "org-a" });
		const old = await seedOpenTask("Daily routine", {
			assignedTo: "sigma",
			orgId: "org-a",
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(old, { status: "done" });
		});
		await tick(t);
		expect(await tasksTitled(t, "Daily routine")).toHaveLength(2);
	});
});

describe("processDueTasks — different schedules do not block each other", () => {
	test("two schedules, same assignee, different titles: both create, both skip independently", async () => {
		const t = createT();
		const a = await seedSchedule(t, { title: "Routine A" });
		const b = await seedSchedule(t, { title: "Routine B" });
		await tick(t);
		expect(await tasksTitled(t, "Routine A")).toHaveLength(1);
		expect(await tasksTitled(t, "Routine B")).toHaveLength(1);

		// Close only A's instance.
		const [aTask] = await tasksTitled(t, "Routine A");
		await t.run(async (ctx) => {
			await ctx.db.patch(aTask._id, { status: "done" });
		});
		await makeDue(t, a);
		await makeDue(t, b);
		await tick(t);
		expect(await tasksTitled(t, "Routine A")).toHaveLength(2);
		expect(await tasksTitled(t, "Routine B")).toHaveLength(1);
		expect((await row(t, a))?.skippedRuns).toBe(0);
		expect((await row(t, b))?.skippedRuns).toBe(1);
	});
});

describe("processDueTasks — the open-instance lookup keys on the assignee agent ID", () => {
	let t: T;
	beforeEach(() => {
		t = createT();
	});

	async function seedTask(opts: {
		title: string;
		assignedTo: string;
		assignedToId?: string;
		orgId?: string;
	}) {
		return await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: opts.title,
				assignedTo: opts.assignedTo,
				...(opts.assignedToId !== undefined
					? { assignedToId: opts.assignedToId }
					: {}),
				priority: "medium" as const,
				status: "todo" as const,
				createdBy: "sigma",
				...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
				createdAt: Date.now() - DAY,
				updatedAt: Date.now() - DAY,
			}),
		);
	}

	test("(a) a schedule with assignedToId finds its open instance by ID even when the task's assignedTo name differs", async () => {
		const id = await seedSchedule(t, {
			orgId: "org-a",
			assignedTo: "sigma",
			assignedToId: "agent-sigma-1",
		});
		const open = await seedTask({
			title: "Daily routine",
			assignedTo: "sigma-renamed",
			assignedToId: "agent-sigma-1",
			orgId: "org-a",
		});
		await tick(t);
		expect(await tasksTitled(t, "Daily routine")).toHaveLength(1);
		const r = await row(t, id);
		expect(r?.skippedRuns).toBe(1);
		expect(r?.lastTaskId).toBe(open);
	});

	test("(a) the ID path stays inside the schedule's tenant", async () => {
		await seedSchedule(t, { orgId: "org-a", assignedToId: "agent-sigma-1" });
		await seedTask({
			title: "Daily routine",
			assignedTo: "sigma",
			assignedToId: "agent-sigma-1",
			orgId: "org-b",
		});
		await tick(t);
		const mine = (await tasksTitled(t, "Daily routine")).filter(
			(x) => x.orgId === "org-a",
		);
		expect(mine).toHaveLength(1);
	});

	test("(b) a schedule WITHOUT assignedToId still finds its open instance, by title within its tenant", async () => {
		const id = await seedSchedule(t, { orgId: "org-a", assignedTo: "sigma" });
		const open = await seedTask({
			title: "Daily routine",
			assignedTo: "sigma",
			assignedToId: "agent-sigma-1",
			orgId: "org-a",
		});
		await tick(t);
		expect(await tasksTitled(t, "Daily routine")).toHaveLength(1);
		expect((await row(t, id))?.lastTaskId).toBe(open);
	});

	test("(c) once the per-transaction scan budget is spent, a lookup answers unknown: the tick skips with a recorded reason", async () => {
		const assignees = ["a1", "a2", "a3", "a4", "a5"];
		const perAssignee = 900;
		expect(perAssignee * assignees.length).toBeGreaterThan(
			PROCESS_DUE_SCAN_BUDGET,
		);
		expect(perAssignee).toBeLessThan(LEGACY_OPEN_LOOKUP_BOUND);
		const ids: Id<"recurringTasks">[] = [];
		for (const a of assignees) {
			ids.push(
				await seedSchedule(t, {
					orgId: "org-a",
					assignedTo: a,
					assignedToId: `agent-${a}`,
				}),
			);
		}
		await t.run(async (ctx) => {
			for (const a of assignees) {
				for (let i = 0; i < perAssignee; i++) {
					await ctx.db.insert("tasks", {
						title: `unrelated ${a} ${i}`,
						assignedTo: a,
						assignedToId: `agent-${a}`,
						priority: "low" as const,
						status: "todo" as const,
						createdBy: "sigma",
						orgId: "org-a",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					});
				}
			}
		});
		await tick(t);
		const rows = await Promise.all(ids.map((i) => row(t, i)));
		const skipped = rows.filter((r) => (r?.skippedRuns ?? 0) === 1);
		expect(skipped.length).toBeGreaterThanOrEqual(1);
		for (const r of skipped) {
			expect(r?.lastSkipReason).toContain("scan budget");
			expect(r?.lastTaskId).toBeUndefined();
		}
		// A schedule inside the budget is unaffected: it created its task.
		expect(rows.filter((r) => (r?.skippedRuns ?? 0) === 0).length).toBeGreaterThanOrEqual(1);
		const created = (await t.run(async (ctx) => ctx.db.query("tasks").collect())).filter(
			(x) => x.title === "Daily routine",
		);
		expect(created).toHaveLength(rows.length - skipped.length);
	});
});
