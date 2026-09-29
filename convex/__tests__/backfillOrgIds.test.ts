/// <reference types="vite/client" />
//
// backfillOrgIds — the tenant backfill for rows written before the create-time
// `orgId` stamp landed (task k17b9vte09jym8npfgfvav4nas8fbv7z).
//
// WHY THIS FILE WAS REWRITTEN. The first version of the migration read all four
// tables in ONE execution (`take(5000 + 1)` each). Against production the dry
// run died with "Too many bytes read in a single function execution (limit:
// 16777216 bytes)": `briefingNotes` rows are documents. It could neither measure
// nor apply, and the customer whose history it was meant to restore kept seeing
// none of it. R-31 says a bulk operation over an unbounded set batches BOTH its
// reads and its writes and reschedules itself; the poles below are that rule.
//
// EVERY POLE HERE IS HERMETIC. Nothing touches a deployment. convex-test's
// `transactionLimits` lets the read ceiling that killed production be reproduced
// at fixture scale (200 KiB instead of 16 MiB) — the corpus below is sized to
// exceed that ceiling ~1.5x when read in one go, exactly as production's was.
//
// THE FAILURE DIRECTION IS THE POINT. What happened in production was the GOOD
// failure: it refused instead of returning five zeros. A pass that cannot
// complete must refuse and say so; it must never degrade into a plausible
// number. The refusal poles pin that.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);

const KiB = 1024;
// The fixture-scale stand-in for Convex's 16 MiB read ceiling.
const READ_CEILING = 200 * KiB;
// Budgets that force many pages out of a ~80-row corpus.
const BUDGETS = { readRows: 10, readBytes: 128 * KiB, writeBudget: 4 };

const createT = () =>
	convexTest({
		schema,
		modules,
		transactionLimits: { bytesRead: READ_CEILING },
	});
type T = ReturnType<typeof createT>;

const now = () => 1_700_000_000_000;
const NONE = "<none>";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const backfill = internal.migrations.backfillOrgIds;
const drain = async (t: T) => {
	await t.finishAllScheduledFunctions(vi.runAllTimers);
};

// ── The corpus ──────────────────────────────────────────────────────────────
// Sized so every disposition is present and the sums are checkable by hand:
//
//   missions        7 stamped (4 org-a, 3 org-b) + 5 unstamped            = 12
//   tasks          25 derivable (child of a stamped mission)
//                   6 parent-unstamped (child of an unstamped mission)
//                   2 dangling (mission row deleted)
//                   5 orphan (no mission at all)
//                   9 already stamped                                     = 47
//   briefingNotes   3 stamped + 12 unstamped, 20 KB each (300 KB)         = 15
//   recurringTasks  1 stamped + 3 unstamped                               =  4
//                                                                           78
const EXPECTED = {
	examined: 78,
	alreadyStamped: 7 + 9 + 3 + 1,
	derivable: 25,
	parentUnstamped: 6 + 2,
	orphan: 5 + 12 + 3,
	unstampedMission: 5,
};

async function seedCorpus(t: T) {
	return await t.run(async (ctx) => {
		const mission = (orgId: string | undefined, i: number) =>
			ctx.db.insert("missions", {
				name: `mission ${i}`,
				project: "p",
				status: "execute" as const,
				priority: "medium" as const,
				pilot: "sigma",
				agents: [],
				createdBy: "sigma",
				...(orgId === undefined ? {} : { orgId }),
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

		const stamped: { id: (typeof missionIds)[number]; org: string }[] = [];
		const missionIds = [] as Awaited<ReturnType<typeof mission>>[];
		for (let i = 0; i < 7; i++) {
			const org = i < 4 ? "org-a" : "org-b";
			const id = await mission(org, i);
			missionIds.push(id);
			stamped.push({ id, org });
		}
		const unstampedMissions = [] as typeof missionIds;
		for (let i = 0; i < 5; i++)
			unstampedMissions.push(await mission(undefined, 100 + i));

		const derivable: { id: string; org: string }[] = [];
		for (let i = 0; i < 25; i++) {
			const parent = stamped[i % stamped.length];
			const id = await ctx.db.insert("tasks", task({ missionId: parent.id }));
			derivable.push({ id, org: parent.org });
		}
		const parentUnstamped: string[] = [];
		for (let i = 0; i < 6; i++) {
			parentUnstamped.push(
				await ctx.db.insert(
					"tasks",
					task({ missionId: unstampedMissions[i % 5] }),
				),
			);
		}
		const dangling: string[] = [];
		for (let i = 0; i < 2; i++) {
			const gone = await mission("org-a", 200 + i);
			dangling.push(await ctx.db.insert("tasks", task({ missionId: gone })));
			await ctx.db.delete(gone);
		}
		const orphanTasks: string[] = [];
		for (let i = 0; i < 5; i++) {
			// "sigma"/"eta" are orchestrator NAMES and are never evidence.
			orphanTasks.push(
				await ctx.db.insert(
					"tasks",
					task({ assignedTo: i % 2 ? "eta" : "sigma" }),
				),
			);
		}
		const already: string[] = [];
		for (let i = 0; i < 9; i++) {
			already.push(
				await ctx.db.insert(
					"tasks",
					task({ orgId: "org-b", missionId: stamped[0].id }),
				),
			);
		}

		const notes: string[] = [];
		for (let i = 0; i < 15; i++) {
			notes.push(
				await ctx.db.insert("briefingNotes", {
					title: `n${i}`,
					topic: "t",
					participants: ["sigma"],
					content: "x".repeat(20 * KiB),
					createdBy: "sigma",
					...(i < 3 ? { orgId: "org-a" } : {}),
					createdAt: now(),
				}),
			);
		}
		const recurring: string[] = [];
		for (let i = 0; i < 4; i++) {
			recurring.push(
				await ctx.db.insert("recurringTasks", {
					title: `daily ${i}`,
					assignedTo: "sigma",
					priority: "medium" as const,
					cronExpression: "0 9 * * *",
					nextRunAt: now(),
					active: true,
					createdBy: "sigma",
					...(i === 0 ? { orgId: "org-b" } : {}),
					createdAt: now(),
					updatedAt: now(),
				}),
			);
		}
		return {
			derivable,
			parentUnstamped,
			dangling,
			orphanTasks,
			already,
			notes,
			recurring,
			unstampedMissions,
		};
	});
}
type Corpus = Awaited<ReturnType<typeof seedCorpus>>;

// Reads in chunks of 4: the test instrument is itself under the read ceiling,
// and 4 x 20 KiB notes fit where 15 do not.
const orgIdsOf = async (t: T, ids: string[]) => {
	const out: string[] = [];
	for (let i = 0; i < ids.length; i += 4) {
		const chunk = ids.slice(i, i + 4);
		out.push(
			...(await t.run(async (ctx) =>
				Promise.all(
					chunk.map(async (id) => {
						// biome-ignore lint/suspicious/noExplicitAny: id of a table chosen at runtime
						const row = await ctx.db.get(id as any);
						return (row as { orgId?: string } | null)?.orgId ?? NONE;
					}),
				),
			)),
		);
	}
	return out;
};

const everyRowOrg = (t: T, c: Corpus) =>
	orgIdsOf(t, [
		...c.derivable.map((d) => d.id),
		...c.parentUnstamped,
		...c.dangling,
		...c.orphanTasks,
		...c.already,
		...c.notes,
		...c.recurring,
		...c.unstampedMissions,
	]);

const statusOf = (t: T) => t.query(backfill.status, {});

const passJobs = (t: T) =>
	t.run(
		async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(j) => /backfillOrgIds(\.js)?:pass$/.test(j.name),
			).length,
	);

// The five counts, asserted as one object so a missing or extra one is a diff.
const fiveCounts = (totals: {
	derivable: number;
	parentUnstamped: number;
	orphan: number;
	alreadyStamped: number;
	unstampedMission: number;
}) => ({
	derivable: totals.derivable,
	parentUnstamped: totals.parentUnstamped,
	orphan: totals.orphan,
	alreadyStamped: totals.alreadyStamped,
	unstampedMission: totals.unstampedMission,
});
const EXPECTED_FIVE = {
	derivable: EXPECTED.derivable,
	parentUnstamped: EXPECTED.parentUnstamped,
	orphan: EXPECTED.orphan,
	alreadyStamped: EXPECTED.alreadyStamped,
	unstampedMission: EXPECTED.unstampedMission,
};

describe("the fixture is large enough to have killed the original", () => {
	test("reading the whole briefingNotes table in one execution exceeds the read ceiling", async () => {
		const t = createT();
		await seedCorpus(t);
		// The original's exact shape: one `take(SCAN_CAP + 1)` over the table.
		await expect(
			t.run(async (ctx) => ctx.db.query("briefingNotes").take(5001)),
		).rejects.toThrow(/Read too much data/);
	});
});

describe("a corpus larger than one page completes across reschedules", () => {
	test("a dry run reports counts that sum to the WHOLE corpus, over more than three passes", async () => {
		const t = createT();
		await seedCorpus(t);

		const started = await t.mutation(backfill.run, BUDGETS);
		expect(started.apply).toBe(false);
		await drain(t);

		const s = await statusOf(t);
		expect(s.status).toBe("complete");
		expect(s.complete).toBe(true);
		expect(s.finalCounts).not.toBeNull();
		const totals = s.finalCounts?.totals;
		if (!totals) throw new Error("no final counts");

		// The five counts, each hand-derived above.
		expect(fiveCounts(totals)).toEqual(EXPECTED_FIVE);
		// ...and they SUM to the corpus: nothing fell out of the report.
		expect(totals.examined).toBe(EXPECTED.examined);
		expect(
			totals.derivable +
				totals.parentUnstamped +
				totals.orphan +
				totals.alreadyStamped +
				totals.unstampedMission,
		).toBe(totals.examined);

		// PROOF the fixture forced many pages, not one that happened to fit: the
		// write budget alone caps a tasks page at 4 rows, so 47 tasks need >= 12
		// passes; the number of pass jobs that actually ran equals `passes`.
		expect(s.passes).toBeGreaterThanOrEqual(
			Math.ceil(47 / BUDGETS.writeBudget),
		);
		expect(s.passes).toBeGreaterThan(3);
		expect(await passJobs(t)).toBe(s.passes);
	});

	test("a dry run writes NOTHING and is the default", async () => {
		const t = createT();
		const c = await seedCorpus(t);
		const before = await everyRowOrg(t, c);

		// NO `apply` argument at all.
		await t.mutation(backfill.run, BUDGETS);
		await drain(t);

		const s = await statusOf(t);
		expect(s.apply).toBe(false);
		expect(s.finalCounts?.totals.stamped).toBe(0);
		expect(await everyRowOrg(t, c)).toEqual(before);
	});

	test("apply:true writes exactly what the dry run said it would, and no pass exceeds the write budget", async () => {
		const t = createT();
		const c = await seedCorpus(t);
		await t.mutation(backfill.run, BUDGETS);
		await drain(t);
		const dry = await statusOf(t);

		await t.mutation(backfill.run, { ...BUDGETS, apply: true });
		await drain(t);
		const applied = await statusOf(t);

		expect(applied.status).toBe("complete");
		expect(applied.apply).toBe(true);
		const dryTotals = dry.finalCounts?.totals;
		const appliedTotals = applied.finalCounts?.totals;
		if (!dryTotals || !appliedTotals) throw new Error("no final counts");
		// The projection and the action agree, and the rows corroborate both.
		expect(appliedTotals.stamped).toBe(dryTotals.derivable);
		expect(appliedTotals.stamped).toBe(25);
		expect(fiveCounts(appliedTotals)).toEqual(fiveCounts(dryTotals));

		const stampedNow = await orgIdsOf(
			t,
			c.derivable.map((d) => d.id),
		);
		expect(stampedNow).toEqual(c.derivable.map((d) => d.org));
		// The WRITE budget bound: no single pass wrote more than it, yet it did write.
		expect(applied.maxWritesInPass).toBeGreaterThan(0);
		expect(applied.maxWritesInPass).toBeLessThanOrEqual(BUDGETS.writeBudget);
	});

	test("re-running apply is IDEMPOTENT: a second apply writes nothing more", async () => {
		const t = createT();
		const c = await seedCorpus(t);
		await t.mutation(backfill.run, { ...BUDGETS, apply: true });
		await drain(t);
		const afterFirst = await everyRowOrg(t, c);

		await t.mutation(backfill.run, { ...BUDGETS, apply: true });
		await drain(t);
		const second = await statusOf(t);

		expect(second.status).toBe("complete");
		const totals = second.finalCounts?.totals;
		if (!totals) throw new Error("no final counts");
		expect(totals.stamped).toBe(0);
		expect(totals.derivable).toBe(0);
		// The 25 rows stamped last time now read as already stamped.
		expect(totals.alreadyStamped).toBe(EXPECTED.alreadyStamped + 25);
		expect(totals.parentUnstamped).toBe(EXPECTED.parentUnstamped);
		expect(totals.orphan).toBe(EXPECTED.orphan);
		expect(totals.examined).toBe(EXPECTED.examined);
		expect(second.maxWritesInPass).toBe(0);
		expect(await everyRowOrg(t, c)).toEqual(afterFirst);
	});
});

describe("it never guesses", () => {
	test("orphans, parent-unstamped and dangling rows are COUNTED and never stamped", async () => {
		const t = createT();
		const c = await seedCorpus(t);
		await t.mutation(backfill.run, { ...BUDGETS, apply: true });
		await drain(t);

		const untouched = [
			...c.parentUnstamped,
			...c.dangling,
			...c.orphanTasks,
			...c.unstampedMissions,
			// notes 3.. and recurring 1.. are the unstamped ones
			...c.notes.slice(3),
			...c.recurring.slice(1),
		];
		expect(await orgIdsOf(t, untouched)).toEqual(untouched.map(() => NONE));
		// Pre-existing stamps are never re-tenanted.
		expect(await orgIdsOf(t, c.already)).toEqual(c.already.map(() => "org-b"));

		const totals = (await statusOf(t)).finalCounts?.totals;
		expect(totals?.orphan).toBe(EXPECTED.orphan);
		expect(totals?.parentUnstamped).toBe(EXPECTED.parentUnstamped);
		expect(totals?.unstampedMission).toBe(EXPECTED.unstampedMission);
	});
});

describe("a partial result says it is partial", () => {
	test("before any pass has run, and mid-chain, there is no final count", async () => {
		const t = createT();
		await seedCorpus(t);
		await t.mutation(backfill.run, BUDGETS);

		// Job scheduled, nothing executed yet.
		const queued = await statusOf(t);
		expect(queued.status).toBe("running");
		expect(queued.complete).toBe(false);
		expect(queued.finalCounts).toBeNull();
		expect(queued.countsSoFar?.totals.examined).toBe(0);

		// Run a few passes, stop mid-chain.
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersToNextTimerAsync();
			await t.finishInProgressScheduledFunctions();
		}
		const mid = await statusOf(t);
		expect(mid.status).toBe("running");
		expect(mid.complete).toBe(false);
		expect(mid.finalCounts).toBeNull();
		const soFar = mid.countsSoFar?.totals.examined ?? -1;
		expect(soFar).toBeGreaterThan(0);
		expect(soFar).toBeLessThan(EXPECTED.examined);

		await drain(t);
		const done = await statusOf(t);
		expect(done.complete).toBe(true);
		expect(done.finalCounts?.totals.examined).toBe(EXPECTED.examined);
	});

	// Cancelling is the reachable way to end a chain without a `finish`. (The
	// other shape — a pass that SUCCEEDED with no successor and no finish — is
	// unreachable by construction and is covered by the mutant that deletes the
	// reschedule, not by this test.)
	test("a chain cancelled part-way is FAILED, never complete", async () => {
		const t = createT();
		await seedCorpus(t);
		await t.mutation(backfill.run, BUDGETS);
		// Run ONE pass, then cancel everything still scheduled: the chain never
		// finishes.
		await vi.advanceTimersToNextTimerAsync();
		await t.finishInProgressScheduledFunctions();
		await t.run(async (ctx) => {
			for (const job of await ctx.db.system
				.query("_scheduled_functions")
				.collect()) {
				if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
			}
		});
		vi.clearAllTimers();

		const s = await statusOf(t);
		expect(s.complete).toBe(false);
		expect(s.status).toBe("failed");
		expect(s.finalCounts).toBeNull();
	});

	test("with nothing to find, status is not_found — not zeros", async () => {
		const t = createT();
		const s = await statusOf(t);
		expect(s.status).toBe("not_found");
		expect(s.complete).toBe(false);
		expect(s.countsSoFar).toBeNull();
		expect(s.finalCounts).toBeNull();
		expect(s.failure).toMatch(/NOT a count of zero/);
	});
});

describe("a pass that cannot complete REFUSES instead of returning a number", () => {
	// A single note larger than the whole read budget. The paginated read must
	// hand it over (it is the only row on its page), and the meter must refuse.
	async function seedOversizedNote(t: T) {
		return await t.run(async (ctx) => {
			const mission = await ctx.db.insert("missions", {
				name: "m",
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
			const tasks: string[] = [];
			for (let i = 0; i < 3; i++) {
				tasks.push(
					await ctx.db.insert("tasks", {
						title: "t",
						assignedTo: "sigma",
						priority: "medium" as const,
						status: "todo" as const,
						createdBy: "sigma",
						missionId: mission,
						createdAt: now(),
						updatedAt: now(),
					}),
				);
			}
			const note = await ctx.db.insert("briefingNotes", {
				title: "huge",
				topic: "t",
				participants: ["sigma"],
				content: "y".repeat(100 * KiB),
				createdBy: "sigma",
				createdAt: now(),
			});
			return { tasks, note };
		});
	}
	const TIGHT = { readRows: 10, readBytes: 64 * KiB, writeBudget: 4 };

	test("the refused pass throws a named refusal; the chain ends FAILED with no final count", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const t = createT();
		await seedOversizedNote(t);
		await t.mutation(backfill.run, { ...TIGHT, apply: true });
		await drain(t);

		const s = await statusOf(t);
		expect(s.status).toBe("failed");
		expect(s.complete).toBe(false);
		// The number is withheld: there is no total to mistake for one.
		expect(s.finalCounts).toBeNull();
		expect(s.failure).toMatch(/failed/);
		// It says WHERE it stopped, so the operator can resume rather than guess.
		expect(s.position?.table).toBe("briefingNotes");
		// Earlier passes committed; the report says so instead of hiding it.
		expect(s.countsSoFar?.totals.stamped).toBe(3);
	});

	test("called directly, the refused pass throws BACKFILL_READ_BUDGET_EXCEEDED", async () => {
		const t = createT();
		await seedOversizedNote(t);
		await expect(
			t.mutation(backfill.pass, {
				state: {
					apply: true,
					table: "briefingNotes",
					cursor: null,
					counts: {
						missions: zero(),
						tasks: zero(),
						briefingNotes: zero(),
						recurringTasks: zero(),
					},
					budgets: TIGHT,
					passes: 0,
					maxWritesInPass: 0,
					maxBytesReadInPass: 0,
				},
			}),
		).rejects.toThrow(/BACKFILL_READ_BUDGET_EXCEEDED/);
	});

	test("resume replays the refused page from where it stopped: nothing redone, nothing skipped", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const t = createT();
		const { note } = await seedOversizedNote(t);
		await t.mutation(backfill.run, { ...TIGHT, apply: true });
		await drain(t);
		expect((await statusOf(t)).status).toBe("failed");

		// The operator removes the oversized row, then resumes.
		await t.run(async (ctx) => ctx.db.delete(note));
		const resumed = await t.mutation(backfill.resume, {});
		expect(resumed.resumedAt.table).toBe("briefingNotes");
		await drain(t);

		const s = await statusOf(t);
		expect(s.status).toBe("complete");
		const totals = s.finalCounts?.totals;
		// 1 mission + 3 tasks; each counted ONCE although the run was interrupted.
		expect(totals?.examined).toBe(4);
		expect(totals?.stamped).toBe(3);
		expect(totals?.derivable).toBe(3);
		expect(totals?.alreadyStamped).toBe(1);
	});

	test("resume refuses when the chain did not fail, and run refuses while one is live", async () => {
		const t = createT();
		await seedCorpus(t);
		await t.mutation(backfill.run, BUDGETS);
		await expect(t.mutation(backfill.run, BUDGETS)).rejects.toThrow(
			/BACKFILL_ALREADY_RUNNING/,
		);
		await expect(t.mutation(backfill.resume, {})).rejects.toThrow(
			/BACKFILL_NOT_FAILED/,
		);
		await drain(t);
		await expect(t.mutation(backfill.resume, {})).rejects.toThrow(
			/BACKFILL_NOT_FAILED/,
		);
	});

	test("out-of-range budgets are refused, not clamped", async () => {
		const t = createT();
		await expect(t.mutation(backfill.run, { readBytes: 10 })).rejects.toThrow(
			/BACKFILL_ARGS_INVALID/,
		);
		await expect(t.mutation(backfill.run, { writeBudget: 0 })).rejects.toThrow(
			/BACKFILL_ARGS_INVALID/,
		);
		await expect(t.mutation(backfill.run, { readRows: 1.5 })).rejects.toThrow(
			/BACKFILL_ARGS_INVALID/,
		);
	});
});

function zero() {
	return {
		examined: 0,
		alreadyStamped: 0,
		derivable: 0,
		stamped: 0,
		parentUnstamped: 0,
		orphan: 0,
		unstampedMission: 0,
	};
}
