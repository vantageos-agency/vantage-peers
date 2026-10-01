import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { syncParticipantIndex } from "./briefingNotes";
import { REVIEW_OPEN_STATUSES, parseReviewTitle } from "./tasks";

// Retired one-shot migrations (removed 2026-10-01, backend-doctor R-31): the
// full-table `.collect()` forms of backfillTaskTimes (ran 2026-03-26, eaddaf5),
// deleteTest{Briefings,Tasks,Missions,Memories,Messages} (MCP-tester fixture
// cleanup, 2026-03-25, 2807f1f), migrateMemoriesNamespace and
// migrateDiaryOrchestrator (pi -> sigma rename, 2026-03-30, 1ebf16d) were
// deleted rather than paged: the writers set those fields since, and the
// literals they matched are retired fixtures. `git show 1ebf16d eaddaf5 2807f1f`
// recovers them.

// ─────────────────────────────────────────────────────────────────────────────
// Migration: backfill briefingNoteParticipants for pre-existing briefingNotes
// rows (task k178gg7wp3cre87mgw60trtpfh8cqfn3, Pi, urgent BLOCKER).
//
// PRODUCTION FINDING: the junction table is written only by the create/update
// mutations (Day 165 fix, k175ga65p654z200ydj7s8qv5s8cnxfc). Any note that
// existed BEFORE that fix deployed has zero rows in briefingNoteParticipants,
// so a scoped participant reading it is indistinguishable from a scoped
// caller reading a note they never participated in — both return null.
//
// This migration walks every briefingNotes row and re-runs
// syncParticipantIndex(ctx, note._id, note.participants) — the SAME function
// create/update call, so there is no second writer and no parallel
// convention to drift from the live code path.
//
// Idempotent: syncParticipantIndex deletes all existing rows for the note
// (by_note index) before re-inserting the deduped participant set, so
// running this migration N times leaves the junction table row count
// unchanged after the first run (verified below and in the paired test).
//
// PRODUCTION INCIDENT (task k17byc17kzyyra886h6v08ky3n8cqfqm, Pi, P0):
// the original one-shot `.collect()` form THREW on prod — "Too many bytes
// read in a single function execution (limit: 16777216 bytes)". A
// briefingNotes row carries kilobytes of `content` (schema: v.string(),
// full briefing text), and Convex reads cannot project fields — even a
// `.paginate()` page loads full documents. `.collect()` over the whole
// table exceeds the 16 MiB read-byte budget once the corpus + per-row
// content size grows past it; the loop below only ever needs `_id` and
// `participants`, but `content` is read anyway and is what exhausts the
// budget.
//
// FIX: bounded pages + self-scheduling. Each transaction processes at most
// BATCH rows via `.paginate()`, then reschedules itself with the
// continuation cursor via ctx.scheduler.runAfter(0, ...) until isDone. No
// single execution's read-byte footprint depends on corpus size anymore —
// only on BATCH.
//
// BATCH = 16, justified against the 16 MiB (16,777,216 byte) per-execution
// read budget:
//   - Convex documents are capped at ~1 MiB (1,048,576 bytes) per document
//     (Convex platform limit), so a single briefingNotes row's absolute
//     worst case is ~1 MiB.
//   - BATCH(16) x worst-case-row(1 MiB) = 16 MiB, which is the size of the
//     ENTIRE read budget with the assumption every row hits the document
//     size cap. Real briefingNotes.content rows are "kilobytes", not
//     megabytes (per the Pi finding), so in practice a page of 16 rows
//     reads a small fraction of a MiB — leaving comfortable headroom for
//     the query's own index-read overhead and the paginate() cursor
//     bookkeeping, while still being small enough that even a genuinely
//     pathological page (several rows near the 1 MiB cap) cannot approach
//     the limit.
//   - Kept intentionally conservative (not e.g. 1000) precisely because
//     Convex cannot skip loading `content` — the field that caused the
//     original incident — so the only lever available is page size.
//
// Run (kicks off the drain; it self-schedules until the corpus is fully
// processed):
//   npx convex run migrations:backfillBriefingNoteParticipants
// ─────────────────────────────────────────────────────────────────────────────

const BACKFILL_BATCH_SIZE = 16;

export const backfillBriefingNoteParticipants = internalMutation({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	returns: v.object({
		notesProcessed: v.number(),
		participantRowsWritten: v.number(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("briefingNotes")
			.paginate({
				cursor: args.cursor ?? null,
				numItems: BACKFILL_BATCH_SIZE,
			});

		let participantRowsWritten = 0;
		for (const note of page.page) {
			await syncParticipantIndex(ctx, note._id, note.participants);
			participantRowsWritten += new Set(note.participants).size;
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations.backfillBriefingNoteParticipants,
				{ cursor: page.continueCursor },
			);
		}

		console.log(
			`Backfilled briefingNoteParticipants page: ${page.page.length} notes processed, ${participantRowsWritten} participant rows written, isDone=${page.isDone}`
		);
		// NOTE (per Pi): this return value is a per-page count, not a
		// corpus-wide total — the drain spans multiple scheduled
		// executions. The proof of completion is an independent read of
		// the briefingNoteParticipants table, never this return value.
		return {
			notesProcessed: page.page.length,
			participantRowsWritten,
			isDone: page.isDone,
		};
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration: drop four orphan tables (task k173r2p1yh94m5f7yvgr1b30gx8dn3ez)
// Run: npx convex run migrations:countOrphanRows
//      npx convex run migrations:dropOrphanTables (repeat until moreRemain=false)
// ─────────────────────────────────────────────────────────────────────────────

export { countOrphanRows, dropOrphanTables } from "./migrations/drop_orphan_tables.js";

// ─────────────────────────────────────────────────────────────────────────────
// Migration: backfill reviewPrRepoFullName/reviewPrNumber on legacy "[Review]"
// tasks (issue #1293)
//
// findOpenReviewTasks/closeReviewTasksForPr now look rows up ONLY through the
// `by_review_pr` index — no by_status-scan fallback (that fallback was the
// exact defect: "no match" is the COMMON case on the hot webhook path, so a
// fallback there meant the unbounded scan still ran on most calls). Rows
// inserted by createOrUpdateReviewTask BEFORE that field existed have
// reviewPrRepoFullName/reviewPrNumber undefined, so they are now genuinely
// invisible to findOpenReviewTasks until backfilled once here.
//
// MUST RUN ONCE, IMMEDIATELY AFTER THIS DEPLOY. Until this migration reaches
// isDone, pre-existing open "[Review]" rows will not be found by
// findOpenReviewTasks (so createOrUpdateReviewTask may insert a duplicate for
// one of them, and closeReviewTasksForPr will not close it via the webhook
// path). The gap is covered in the interim by reviewBacklogSweep, which
// closes exactly these legacy rows by passing closeReviewTasksForPr the
// row's own `taskId` (a direct ctx.db.get from listReviewBacklogByLineage's
// own by_status scan, not a re-derived lookup) — so nothing is silently
// stuck, but running this migration promptly still matters for the webhook
// dedup path.
//
// Bounded + self-scheduling, same pattern as backfillBriefingNoteParticipants
// above: each execution reads at most BACKFILL_REVIEW_LINK_BATCH_SIZE rows via
// `.paginate()` on the SAME by_status index the old code used, then either
// continues the current status's cursor or advances to the next status in
// REVIEW_OPEN_STATUSES, until every open status is drained. No single
// execution's read footprint depends on corpus size.
//
// Run (kicks off the drain; it self-schedules until every open status is
// fully processed — call with no args):
//   npx convex run migrations:backfillReviewPrLinkFields
// ─────────────────────────────────────────────────────────────────────────────

const BACKFILL_REVIEW_LINK_BATCH_SIZE = 200;

export const backfillReviewPrLinkFields = internalMutation({
	args: {
		statusIndex: v.optional(v.number()),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	returns: v.object({
		scanned: v.number(),
		backfilled: v.number(),
		skippedAlreadySet: v.number(),
		skippedNoTitleMatch: v.number(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const statusIndex = args.statusIndex ?? 0;
		if (statusIndex >= REVIEW_OPEN_STATUSES.length) {
			return {
				scanned: 0,
				backfilled: 0,
				skippedAlreadySet: 0,
				skippedNoTitleMatch: 0,
				isDone: true,
			};
		}
		const status = REVIEW_OPEN_STATUSES[statusIndex];

		const page = await ctx.db
			.query("tasks")
			.withIndex("by_status", (q) => q.eq("status", status))
			.paginate({
				cursor: args.cursor ?? null,
				numItems: BACKFILL_REVIEW_LINK_BATCH_SIZE,
			});

		let backfilled = 0;
		let skippedAlreadySet = 0;
		let skippedNoTitleMatch = 0;

		for (const task of page.page) {
			if (
				task.reviewPrRepoFullName !== undefined &&
				task.reviewPrNumber !== undefined
			) {
				skippedAlreadySet++;
				continue;
			}
			const parsed = parseReviewTitle(task.title);
			if (!parsed) {
				skippedNoTitleMatch++;
				continue;
			}
			await ctx.db.patch(task._id, {
				reviewPrRepoFullName: parsed.repoFullName,
				reviewPrNumber: parsed.prNumber,
			});
			backfilled++;
		}

		let isDone = false;
		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations.backfillReviewPrLinkFields,
				{ statusIndex, cursor: page.continueCursor },
			);
		} else if (statusIndex + 1 < REVIEW_OPEN_STATUSES.length) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations.backfillReviewPrLinkFields,
				{ statusIndex: statusIndex + 1, cursor: null },
			);
		} else {
			isDone = true;
		}

		console.log(
			`backfillReviewPrLinkFields: status=${status} scanned=${page.page.length} backfilled=${backfilled} skippedAlreadySet=${skippedAlreadySet} skippedNoTitleMatch=${skippedNoTitleMatch} isDone=${isDone}`,
		);
		// NOTE (same discipline as backfillBriefingNoteParticipants): this is a
		// per-page count, not a corpus-wide total — the drain spans multiple
		// scheduled executions. `isDone` is the only field that means "the
		// whole migration is finished", not "this page found nothing".
		return {
			scanned: page.page.length,
			backfilled,
			skippedAlreadySet,
			skippedNoTitleMatch,
			isDone,
		};
	},
});
