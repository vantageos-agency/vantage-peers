import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { closeSegmentsForCompletion } from "./lib/taskClosureGate";

// One-shot, re-runnable repair for rows that left "in_progress" before
// closeTrailingSegmentOnExit shipped: their LAST workSegments entry has no
// `end` while status is no longer "in_progress", so their duration cannot be
// derived and the work cannot be billed. Bounded/paginated — the tasks table
// has tens of thousands of rows and the vast majority need no repair at all.
//
// Run (dry run first, always):
//   npx convex run healStrandedSegments:healStrandedSegmentsPage '{"dryRun":true}'
//   npx convex run healStrandedSegments:healStrandedSegmentsAll '{"dryRun":true}'
// Then for real:
//   npx convex run healStrandedSegments:healStrandedSegmentsAll '{"dryRun":false}'

export const HEAL_STRANDED_SEGMENTS_PAGE_SIZE = 25;

const durationSourceValidator = v.union(v.literal("segments"), v.literal("legacy"));

const healedEntryValidator = v.object({
	taskId: v.id("tasks"),
	end: v.number(),
	actualMinutesBefore: v.optional(v.number()),
	actualMinutesAfter: v.optional(v.number()),
	durationSourceBefore: v.optional(durationSourceValidator),
	durationSourceAfter: v.optional(durationSourceValidator),
});

const survivorEntryValidator = v.object({
	taskId: v.id("tasks"),
	reason: v.string(),
});

export const healStrandedSegmentsPageReturns = v.object({
	scanned: v.number(),
	healed: v.array(healedEntryValidator),
	survivors: v.array(survivorEntryValidator),
	isDone: v.boolean(),
	continueCursor: v.string(),
});

/**
 * Processes ONE bounded page of the tasks table. For each row whose status
 * is not "in_progress" and whose last workSegments entry has no `end`:
 *   - completedAt present, and >= the open segment's start: closes the
 *     segment with end=completedAt, reusing closeSegmentsForCompletion (the
 *     SAME derivation the live terminal-close path uses, cap included) so
 *     actualMinutes/durationSource are recomputed from the now-closed
 *     segments rather than left stale. Reported in `healed` with the
 *     before/after values so the billing change is auditable.
 *   - completedAt present but precedes the segment's start: left untouched,
 *     reported in `survivors` — inventing an end here would fabricate a
 *     negative-duration segment.
 *   - completedAt absent: left untouched, reported in `survivors` — there is
 *     no machine timestamp to derive an end from, and this repair never
 *     invents one.
 * Rows still "in_progress" (a legitimately open segment) or already fully
 * closed are neither healed nor listed.
 *
 * `dryRun` (default true) computes and returns what WOULD change without
 * writing anything.
 */
export const healStrandedSegmentsPage = internalMutation({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
		dryRun: v.optional(v.boolean()),
		numItems: v.optional(v.number()),
	},
	returns: healStrandedSegmentsPageReturns,
	handler: async (ctx, args) => {
		const dryRun = args.dryRun ?? true;
		const numItems = args.numItems ?? HEAL_STRANDED_SEGMENTS_PAGE_SIZE;

		const page = await ctx.db.query("tasks").paginate({
			cursor: args.cursor ?? null,
			numItems,
		});

		const healed: Array<{
			taskId: (typeof page.page)[number]["_id"];
			end: number;
			actualMinutesBefore: number | undefined;
			actualMinutesAfter: number | undefined;
			durationSourceBefore: "segments" | "legacy" | undefined;
			durationSourceAfter: "segments" | "legacy" | undefined;
		}> = [];
		const survivors: Array<{ taskId: (typeof page.page)[number]["_id"]; reason: string }> = [];

		for (const task of page.page) {
			if (task.status === "in_progress") continue;

			const segments = task.workSegments ?? [];
			const lastIndex = segments.length - 1;
			if (lastIndex < 0 || segments[lastIndex].end !== undefined) continue;

			if (task.completedAt === undefined) {
				survivors.push({
					taskId: task._id,
					reason: "no completedAt — end not derivable",
				});
				continue;
			}

			if (task.completedAt < segments[lastIndex].start) {
				survivors.push({
					taskId: task._id,
					reason: "completedAt precedes segment start",
				});
				continue;
			}

			let derived: Awaited<ReturnType<typeof closeSegmentsForCompletion>>;
			try {
				derived = await closeSegmentsForCompletion(ctx, task, task.completedAt);
			} catch (err) {
				survivors.push({
					taskId: task._id,
					reason: `segment derivation refused: ${err instanceof Error ? err.message : String(err)}`,
				});
				continue;
			}

			healed.push({
				taskId: task._id,
				end: task.completedAt,
				actualMinutesBefore: task.actualMinutes,
				actualMinutesAfter: derived.actualMinutes,
				durationSourceBefore: task.durationSource,
				durationSourceAfter: derived.durationSource,
			});

			if (!dryRun) {
				await ctx.db.patch(task._id, {
					workSegments: derived.closedSegments,
					actualMinutes: derived.actualMinutes,
					durationSource: derived.durationSource,
				});
			}
		}

		console.log(
			`healStrandedSegmentsPage: scanned=${page.page.length} healed=${healed.length} survivors=${survivors.length} dryRun=${dryRun} isDone=${page.isDone}`,
		);

		return {
			scanned: page.page.length,
			healed,
			survivors,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});

export const healStrandedSegmentsAllReturns = v.object({
	pages: v.number(),
	totalScanned: v.number(),
	totalHealed: v.number(),
	totalSurvivors: v.number(),
});

/**
 * Walks every page of the tasks table via healStrandedSegmentsPage until
 * isDone, so an operator can run the repair end to end with one call. Always
 * run with dryRun:true first.
 */
export const healStrandedSegmentsAll = internalAction({
	args: {
		dryRun: v.optional(v.boolean()),
	},
	returns: healStrandedSegmentsAllReturns,
	handler: async (ctx, args) => {
		let cursor: string | null = null;
		let pages = 0;
		let totalScanned = 0;
		let totalHealed = 0;
		let totalSurvivors = 0;

		for (;;) {
			const result: Infer<typeof healStrandedSegmentsPageReturns> =
				await ctx.runMutation(
					internal.healStrandedSegments.healStrandedSegmentsPage,
					{ cursor, dryRun: args.dryRun },
				);
			pages += 1;
			totalScanned += result.scanned;
			totalHealed += result.healed.length;
			totalSurvivors += result.survivors.length;
			if (result.isDone) break;
			cursor = result.continueCursor;
		}

		console.log(
			`healStrandedSegmentsAll: pages=${pages} totalScanned=${totalScanned} totalHealed=${totalHealed} totalSurvivors=${totalSurvivors}`,
		);

		return { pages, totalScanned, totalHealed, totalSurvivors };
	},
});
