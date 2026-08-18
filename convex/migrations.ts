import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { syncParticipantIndex } from "./briefingNotes";

// ─────────────────────────────────────────────────────────────────────────────
// Migration: backfill startedAt + completedAt on tasks
// Run: npx convex run migrations:backfillTaskTimes
// ─────────────────────────────────────────────────────────────────────────────

export const backfillTaskTimes = internalMutation({
	args: {},
	handler: async (ctx) => {
		const tasks = await ctx.db.query("tasks").collect();
		let startedFixed = 0;
		let completedFixed = 0;

		for (const task of tasks) {
			const patch: Record<string, any> = {};

			// Backfill startedAt for in_progress/done/review tasks
			if (
				!task.startedAt &&
				(task.status === "in_progress" || task.status === "done" || task.status === "review")
			) {
				patch.startedAt = task.createdAt;
				startedFixed++;
			}

			// Backfill completedAt for done tasks
			if (!task.completedAt && task.status === "done") {
				patch.completedAt = task.updatedAt;
				completedFixed++;
			}

			// Calculate actualMinutes if both timestamps exist
			const startedAt = patch.startedAt ?? task.startedAt;
			const completedAt = patch.completedAt ?? task.completedAt;
			if (startedAt && completedAt && !task.actualMinutes) {
				patch.actualMinutes = Math.round((completedAt - startedAt) / 60_000);
			}

			if (Object.keys(patch).length > 0) {
				await ctx.db.patch(task._id, patch);
			}
		}

		console.log(`Backfilled: ${startedFixed} startedAt, ${completedFixed} completedAt`);
		return { startedFixed, completedFixed, total: tasks.length };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup: delete test briefing notes (MCP Test Briefing entries)
// Run: npx convex run migrations:deleteTestBriefings
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTestBriefings = internalMutation({
	args: {},
	handler: async (ctx) => {
		const notes = await ctx.db.query("briefingNotes").collect();
		let deleted = 0;

		for (const note of notes) {
			if (note.title === "MCP Test Briefing") {
				await ctx.db.delete(note._id);
				deleted++;
			}
		}

		console.log(`Deleted ${deleted} test briefing notes`);
		return { deleted };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup: delete test tasks created by MCP tester
// Run: npx convex run migrations:deleteTestTasks
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTestTasks = internalMutation({
	args: {},
	handler: async (ctx) => {
		const tasks = await ctx.db.query("tasks").collect();
		let deleted = 0;

		for (const task of tasks) {
			if (
				task.title === "Test task from MCP tester" ||
				task.title === "Mission-linked task from MCP tester"
			) {
				await ctx.db.delete(task._id);
				deleted++;
			}
		}

		console.log(`Deleted ${deleted} test tasks`);
		return { deleted };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup: delete test missions created by MCP tester
// Run: npx convex run migrations:deleteTestMissions
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTestMissions = internalMutation({
	args: {},
	handler: async (ctx) => {
		const missions = await ctx.db.query("missions").collect();
		let deleted = 0;

		for (const mission of missions) {
			if (
				mission.name === "Test mission from MCP tester" ||
				mission.name === "Updated test mission"
			) {
				await ctx.db.delete(mission._id);
				deleted++;
			}
		}

		console.log(`Deleted ${deleted} test missions`);
		return { deleted };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup: delete test memories from test/mcp-tester namespace
// Run: npx convex run migrations:deleteTestMemories
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTestMemories = internalMutation({
	args: {},
	handler: async (ctx) => {
		const memories = await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) => q.eq("namespace", "test/mcp-tester"))
			.collect();
		let deleted = 0;

		for (const mem of memories) {
			await ctx.db.delete(mem._id);
			deleted++;
		}

		console.log(`Deleted ${deleted} test memories from test/mcp-tester`);
		return { deleted };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup: delete test messages from MCP tester
// Run: npx convex run migrations:deleteTestMessages
// ─────────────────────────────────────────────────────────────────────────────

export const deleteTestMessages = internalMutation({
	args: {},
	handler: async (ctx) => {
		const messages = await ctx.db.query("messages").collect();
		let deleted = 0;

		for (const msg of messages) {
			if (msg.content === "Test message from MCP tester") {
				// Delete receipts first
				const receipts = await ctx.db
					.query("messageReceipts")
					.withIndex("by_message", (q) => q.eq("messageId", msg._id))
					.collect();
				for (const receipt of receipts) {
					await ctx.db.delete(receipt._id);
				}
				await ctx.db.delete(msg._id);
				deleted++;
			}
		}

		console.log(`Deleted ${deleted} test messages and their receipts`);
		return { deleted };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration: rename memory namespace "orchestrator/pi" → "orchestrator/sigma"
// Run: npx convex run migrations:migrateMemoriesNamespace
// ─────────────────────────────────────────────────────────────────────────────

export const migrateMemoriesNamespace = internalMutation({
	args: {},
	handler: async (ctx) => {
		const memories = await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) => q.eq("namespace", "orchestrator/pi"))
			.collect();
		let migrated = 0;

		for (const mem of memories) {
			await ctx.db.patch(mem._id, { namespace: "orchestrator/sigma" });
			migrated++;
		}

		console.log(`Migrated ${migrated} memories from orchestrator/pi to orchestrator/sigma`);
		return { migrated };
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration: change diary orchestrator "pi" → "sigma" for VPS entries
// Run: npx convex run migrations:migrateDiaryOrchestrator
// ─────────────────────────────────────────────────────────────────────────────

export const migrateDiaryOrchestrator = internalMutation({
	args: {},
	handler: async (ctx) => {
		const entries = await ctx.db
			.query("diary")
			.withIndex("by_orchestrator_date", (q) => q.eq("orchestrator", "pi"))
			.collect();
		let migrated = 0;
		let skipped = 0;

		for (const entry of entries) {
			const content = entry.content.toLowerCase();
			const isVpsRelated =
				content.includes("pi-vps") ||
				content.includes("sigma") ||
				content.includes("vps");

			if (isVpsRelated) {
				await ctx.db.patch(entry._id, { orchestrator: "sigma" });
				migrated++;
			} else {
				skipped++;
			}
		}

		console.log(
			`Diary migration: ${migrated} migrated to sigma, ${skipped} kept as pi`
		);
		return { migrated, skipped };
	},
});

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
