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
import { LEGACY_OPEN_LOOKUP_BOUND } from "../recurringTasks";
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
	opts: { title?: string; assignedTo?: string; orgId?: string } = {},
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

	test("the same title for ANOTHER assignee does not block", async () => {
		await seedSchedule(t, { orgId: "org-a" });
		await seedOpenTask("Daily routine", { assignedTo: "clio", orgId: "org-a" });
		await tick(t);
		const mine = (await tasksTitled(t, "Daily routine")).filter(
			(x) => x.assignedTo === "sigma",
		);
		expect(mine).toHaveLength(1);
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
