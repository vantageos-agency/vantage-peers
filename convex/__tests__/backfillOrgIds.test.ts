/// <reference types="vite/client" />
//
// backfillOrgIds — the tenant backfill for rows written before the create-time
// `orgId` stamp landed (task k17fknqwm6y336gpay2n8pdq2s8f7233).
//
// THIS TEST EXISTS BECAUSE THE FILE IT REPLACES SHIPPED UNTESTED.
// `populateOrgIds.ts` returned a count named `tasksPatched` while performing
// ZERO writes — a field named for an action that counted something else. No
// test ever observed the two disagreeing. So the properties pinned here are, in
// order of importance:
//
//   1. DRY RUN IS THE DEFAULT and it writes NOTHING. Called with no argument,
//      the database is byte-for-byte unchanged afterwards.
//   2. `stamped` COUNTS WRITES THAT HAPPENED, and nothing else. In a dry run it
//      is 0 while `wouldStamp` carries the projection; in an applied run the
//      two agree AND the rows really changed.
//   3. IT NEVER GUESSES. A task with no mission, a task whose mission is itself
//      unstamped, and a dangling parent are each reported as
//      `ownerNotDerivable` and left untouched — never assigned from an
//      orchestrator name.
//
// The migration is NOT run against production by this task; this fixture is the
// evidence handed over with it.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);

const createT = () => convexTest(schema, modules);
const now = () => 1_700_000_000_000;

/**
 * Seeds a fixture with a KNOWN disposition for every branch of the derivation
 * rule. Returns the ids so each row's post-run state can be asserted
 * individually rather than only through the aggregate counts.
 */
async function seedFixture(t: ReturnType<typeof createT>) {
	return await t.run(async (ctx) => {
		// A mission that STATES its tenant — the only evidence the migration
		// accepts.
		const stampedMission = await ctx.db.insert("missions", {
			name: "stamped mission",
			project: "p",
			status: "execute" as const,
			priority: "medium" as const,
			pilot: "sigma",
			agents: [],
			createdBy: "sigma",
			orgId: "org-a",
			createdAt: now(),
			updatedAt: now(),
		});
		// A mission with NO tenant. Nothing on the row establishes one, so it is
		// not derivable and neither are its children.
		const unstampedMission = await ctx.db.insert("missions", {
			name: "unstamped mission",
			project: "p",
			status: "execute" as const,
			priority: "medium" as const,
			pilot: "sigma",
			agents: [],
			createdBy: "sigma",
			createdAt: now(),
			updatedAt: now(),
		});

		const task = (extra: Record<string, unknown>) => ({
			title: "t",
			assignedTo: "sigma",
			priority: "medium" as const,
			status: "todo" as const,
			createdBy: "sigma",
			createdAt: now(),
			updatedAt: now(),
			...extra,
		});

		// DERIVABLE: child of a stamped mission.
		const derivable = await ctx.db.insert(
			"tasks",
			task({ missionId: stampedMission }),
		);
		// NOT DERIVABLE: parent exists but is itself unstamped.
		const parentUnstamped = await ctx.db.insert(
			"tasks",
			task({ missionId: unstampedMission }),
		);
		// NOT DERIVABLE: no parent at all. "sigma" is an orchestrator NAME and is
		// deliberately not consulted.
		const orphan = await ctx.db.insert("tasks", task({}));
		// ALREADY STAMPED: must be left exactly as-is.
		const already = await ctx.db.insert(
			"tasks",
			task({ orgId: "org-b", missionId: stampedMission }),
		);

		// The two report-only tables plus recurringTasks.
		await ctx.db.insert("briefingNotes", {
			title: "n",
			topic: "t",
			participants: ["sigma"],
			content: "c",
			createdBy: "sigma",
			createdAt: now(),
		});
		await ctx.db.insert("recurringTasks", {
			title: "daily",
			assignedTo: "sigma",
			priority: "medium" as const,
			cronExpression: "0 9 * * *",
			nextRunAt: now(),
			active: true,
			createdBy: "sigma",
			createdAt: now(),
			updatedAt: now(),
		});

		return { derivable, parentUnstamped, orphan, already, unstampedMission };
	});
}

/**
 * Reads each row's `orgId`, mapping an ABSENT stamp to the explicit sentinel
 * "<none>" rather than `undefined` — `undefined` is not a transportable Convex
 * value across the `t.run` boundary. The sentinel is only a transport detail:
 * "<none>" in an assertion means the row carries no tenant at all.
 */
const NONE = "<none>";
const orgIdsOf = (t: ReturnType<typeof createT>, ids: string[]) =>
	t.run(async (ctx) =>
		Promise.all(
			ids.map(async (id) => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const row = await ctx.db.get(id as any);
				return (row as { orgId?: string } | null)?.orgId ?? NONE;
			}),
		),
	);

describe("backfillOrgIds — dry run is the default and writes nothing", () => {
	test("called with NO argument: applied=false, stamped=0, and no row changes", async () => {
		const t = createT();
		const ids = await seedFixture(t);

		const before = await orgIdsOf(t, [
			ids.derivable,
			ids.parentUnstamped,
			ids.orphan,
			ids.already,
		]);

		const res = await t.mutation(internal.migrations.backfillOrgIds.run, {});

		expect(res.applied).toBe(false);
		// `stamped` names an action. In a dry run that action did not happen.
		expect(res.tasks.stamped).toBe(0);
		// ...and the projection is carried by the field that is named for a
		// projection. This is the exact distinction populateOrgIds collapsed.
		expect(res.tasks.wouldStamp).toBe(1);

		const after = await orgIdsOf(t, [
			ids.derivable,
			ids.parentUnstamped,
			ids.orphan,
			ids.already,
		]);
		expect(after).toEqual(before);
		expect(after).toEqual([NONE, NONE, NONE, "org-b"]);
	});

	test("explicit apply:false is identical to the default", async () => {
		const t = createT();
		await seedFixture(t);
		const res = await t.mutation(internal.migrations.backfillOrgIds.run, {
			apply: false,
		});
		expect(res.applied).toBe(false);
		expect(res.tasks.stamped).toBe(0);
	});
});

describe("backfillOrgIds — an applied run stamps ONLY what it can derive", () => {
	test("apply:true stamps the derivable child and nothing else", async () => {
		const t = createT();
		const ids = await seedFixture(t);

		const res = await t.mutation(internal.migrations.backfillOrgIds.run, {
			apply: true,
		});

		expect(res.applied).toBe(true);
		// The count named for the action equals the writes that happened...
		expect(res.tasks.stamped).toBe(1);
		expect(res.tasks.stamped).toBe(res.tasks.wouldStamp);

		// ...and is corroborated by the ROWS, not just the return value.
		const [derivable, parentUnstamped, orphan, already] = await orgIdsOf(t, [
			ids.derivable,
			ids.parentUnstamped,
			ids.orphan,
			ids.already,
		]);
		// Inherited from its mission's STATED tenant.
		expect(derivable).toBe("org-a");
		// No evidence: left alone rather than guessed from "sigma".
		expect(parentUnstamped).toBe(NONE);
		expect(orphan).toBe(NONE);
		// Pre-existing stamp untouched — a backfill never re-tenants a row.
		expect(already).toBe("org-b");
	});

	test("the un-derivable rows are COUNTED, not silently dropped", async () => {
		const t = createT();
		await seedFixture(t);

		const res = await t.mutation(internal.migrations.backfillOrgIds.run, {
			apply: true,
		});

		// 4 tasks examined: 1 derivable, 1 already stamped, 2 not derivable.
		expect(res.tasks.examined).toBe(4);
		expect(res.tasks.alreadyStamped).toBe(1);
		expect(res.tasks.ownerNotDerivable).toBe(2);
		// The parts account for the whole — nothing fell out of the report.
		expect(
			res.tasks.alreadyStamped + res.tasks.stamped + res.tasks.ownerNotDerivable,
		).toBe(res.tasks.examined);
	});

	test("a second apply run is a no-op — the work is not double-counted", async () => {
		const t = createT();
		await seedFixture(t);
		await t.mutation(internal.migrations.backfillOrgIds.run, { apply: true });

		const second = await t.mutation(internal.migrations.backfillOrgIds.run, {
			apply: true,
		});
		expect(second.tasks.stamped).toBe(0);
		expect(second.tasks.wouldStamp).toBe(0);
		expect(second.tasks.alreadyStamped).toBe(2);
	});
});

describe("backfillOrgIds — the report-only tables state their gap honestly", () => {
	test("missions, briefingNotes and recurringTasks report, and never stamp", async () => {
		const t = createT();
		await seedFixture(t);

		const res = await t.mutation(internal.migrations.backfillOrgIds.run, {
			apply: true,
		});

		// A mission has no parent to inherit from: the information was never
		// recorded, and the migration says so rather than inventing it.
		expect(res.missions.examined).toBe(2);
		expect(res.missions.alreadyStamped).toBe(1);
		expect(res.missions.ownerNotDerivable).toBe(1);
		expect(res.missions.stamped).toBe(0);

		expect(res.briefingNotes.examined).toBe(1);
		expect(res.briefingNotes.ownerNotDerivable).toBe(1);
		expect(res.briefingNotes.stamped).toBe(0);

		// recurringTasks is reported too: each unstamped schedule is a RECURRING
		// source of unstamped tasks via processDueTasks, so leaving it out would
		// have understated the gap.
		expect(res.recurringTasks.examined).toBe(1);
		expect(res.recurringTasks.ownerNotDerivable).toBe(1);
		expect(res.recurringTasks.stamped).toBe(0);
	});

	test("an empty database reports zeroes and truncated=false, not an error", async () => {
		const t = createT();
		const res = await t.mutation(internal.migrations.backfillOrgIds.run, {});
		for (const report of [
			res.tasks,
			res.missions,
			res.briefingNotes,
			res.recurringTasks,
		]) {
			expect(report.examined).toBe(0);
			expect(report.stamped).toBe(0);
			expect(report.ownerNotDerivable).toBe(0);
			expect(report.truncated).toBe(false);
		}
	});
});
