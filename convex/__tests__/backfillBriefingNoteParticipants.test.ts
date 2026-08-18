/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

// The per-execution read-byte budget the batched migration must stay under
// (Convex's documented per-function-execution read limit).
const CONVEX_READ_BYTE_BUDGET = 16 * 1024 * 1024; // 16,777,216 bytes

// Must match BACKFILL_BATCH_SIZE in convex/migrations.ts.
const BACKFILL_BATCH_SIZE = 16;

// Exclude RAG/search/backfill modules — same exclusion pattern as
// briefingNotesParticipantVisibility.test.ts. Safe: the "backfill" exclusion
// only matches convex/migrations/*.ts and oauth-backfill.test.ts, never the
// convex/migrations.ts module under test here (different path, no
// "backfill" substring).
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

function createTestConvex() {
	return convexTest(schema, modules);
}

// Direct-insert fixture: bypasses briefingNotes.create entirely, so
// syncParticipantIndex NEVER runs and briefingNoteParticipants stays empty
// for this note — exactly the production defect (task
// k178gg7wp3cre87mgw60trtpfh8cqfn3): rows that predate the Day 165 fix.
async function seedNoteWithoutSync(
	t: ReturnType<typeof createTestConvex>,
	participants: string[],
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("briefingNotes", {
			title: "pre-existing note",
			topic: "pre-existing-topic",
			participants,
			content: "content written before the Day 165 fix shipped",
			createdBy: "sigma",
			createdAt: Date.now(),
		});
	});
}

describe("migrations:backfillBriefingNoteParticipants", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("RED then GREEN: scoped participant denied pre-migration, reads post-migration", async () => {
		const t = createTestConvex();
		const noteId = await seedNoteWithoutSync(t, ["laurent", "pi"]);

		// Sanity: junction table has zero rows for this note (sync never ran).
		const rowsBefore = await t.run(async (ctx) => {
			return await ctx.db
				.query("briefingNoteParticipants")
				.withIndex("by_note", (q) => q.eq("noteId", noteId))
				.collect();
		});
		expect(rowsBefore).toHaveLength(0);

		// RED: a scoped participant ("laurent") is denied — identical to a
		// scoped caller who is NOT a participant. The junction table is
		// empty, so callerCanRead's index-range probe finds nothing for
		// either case.
		const deniedBeforeMigration = await t.query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["laurent"],
		});
		expect(deniedBeforeMigration).toBeNull();

		// A caller who is NOT a participant is denied identically — proving
		// the pre-migration state cannot discriminate a real participant
		// from a stranger.
		const strangerBeforeMigration = await t.query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["stranger"],
		});
		expect(strangerBeforeMigration).toBeNull();

		// Run the migration.
		const result = await t.mutation(
			internal.migrations.backfillBriefingNoteParticipants,
			{},
		);
		expect(result.notesProcessed).toBeGreaterThanOrEqual(1);
		expect(result.participantRowsWritten).toBeGreaterThanOrEqual(2);

		// GREEN: junction rows now exist for the note.
		const rowsAfter = await t.run(async (ctx) => {
			return await ctx.db
				.query("briefingNoteParticipants")
				.withIndex("by_note", (q) => q.eq("noteId", noteId))
				.collect();
		});
		expect(rowsAfter).toHaveLength(2);
		expect(rowsAfter.map((r) => r.participant).sort()).toEqual([
			"laurent",
			"pi",
		]);

		// GREEN: the scoped participant now reads the note.
		const readAfterMigration = await t.query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["laurent"],
		});
		expect(readAfterMigration?._id).toBe(noteId);

		// The stranger is still correctly denied — the migration didn't
		// grant blanket access, only real participants.
		const strangerAfterMigration = await t.query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["stranger"],
		});
		expect(strangerAfterMigration).toBeNull();
	});

	test("idempotent: re-running the migration leaves the junction row count unchanged", async () => {
		const t = createTestConvex();
		await seedNoteWithoutSync(t, ["laurent", "pi", "tau"]);
		// A second pre-existing note, with an overlapping + distinct participant
		// set, to prove the migration handles multiple rows correctly.
		await seedNoteWithoutSync(t, ["laurent", "sigma"]);

		const first = await t.mutation(
			internal.migrations.backfillBriefingNoteParticipants,
			{},
		);
		const countAfterFirstRun = await t.run(async (ctx) => {
			return (await ctx.db.query("briefingNoteParticipants").collect())
				.length;
		});
		expect(countAfterFirstRun).toBe(first.participantRowsWritten);
		expect(countAfterFirstRun).toBe(5); // 3 + 2 participant rows

		const second = await t.mutation(
			internal.migrations.backfillBriefingNoteParticipants,
			{},
		);
		const countAfterSecondRun = await t.run(async (ctx) => {
			return (await ctx.db.query("briefingNoteParticipants").collect())
				.length;
		});

		expect(countAfterSecondRun).toBe(countAfterFirstRun);
		expect(second.participantRowsWritten).toBe(first.participantRowsWritten);
	});

	test("threshold-reaching: corpus whose collect() would exceed the 16 MiB read budget drains fully via bounded pages", async () => {
		const t = createTestConvex();

		// Each note's content is padded to ~64 KB. 64 KB was chosen (not a
		// realistic prod note size — Pi's finding is real notes are only
		// "kilobytes") specifically so a SMALL note count can still exceed
		// the 16 MiB budget under .collect(), keeping the test fast while
		// still proving the threshold claim with real numbers.
		const CONTENT_BYTES_PER_NOTE = 64 * 1024; // 65,536 bytes
		const contentPadding = "x".repeat(CONTENT_BYTES_PER_NOTE);

		// 300 notes x 64 KB = 18,432,000 bytes > 16,777,216 byte budget.
		const NOTE_COUNT = 300;
		const totalContentBytes = NOTE_COUNT * CONTENT_BYTES_PER_NOTE;
		expect(totalContentBytes).toBeGreaterThan(CONVEX_READ_BYTE_BUDGET);
		expect(totalContentBytes).toBe(19_660_800); // 300 * 65,536

		const noteIds: Array<Awaited<ReturnType<typeof seedNoteWithoutSync>>> =
			[];
		for (let i = 0; i < NOTE_COUNT; i++) {
			noteIds.push(
				await t.run(async (ctx) => {
					return await ctx.db.insert("briefingNotes", {
						title: `pre-existing note ${i}`,
						topic: "pre-existing-topic",
						participants: ["laurent", `participant-${i}`],
						content: contentPadding,
						createdBy: "sigma",
						createdAt: Date.now(),
					});
				}),
			);
		}

		// Sanity: zero junction rows before the drain (matches the
		// production defect — sync never ran for pre-existing rows).
		const rowsBefore = await t.run(async (ctx) => {
			return (await ctx.db.query("briefingNoteParticipants").collect())
				.length;
		});
		expect(rowsBefore).toBe(0);

		// Kick off the drain. The first execution processes exactly one
		// bounded page (BACKFILL_BATCH_SIZE rows) and self-schedules the
		// rest — no execution ever touches more than BACKFILL_BATCH_SIZE
		// rows, so no single execution's read footprint scales with the
		// 300-note / ~18.75 MiB corpus above.
		const first = await t.mutation(
			internal.migrations.backfillBriefingNoteParticipants,
			{},
		);
		expect(first.notesProcessed).toBe(BACKFILL_BATCH_SIZE);
		expect(first.isDone).toBe(false);

		// Drive every self-scheduled continuation to completion.
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		// GREEN: the full corpus drained — 2 participants per note x 300
		// notes = 600 junction rows, despite no execution ever reading more
		// than BACKFILL_BATCH_SIZE (16) rows / ~1 MiB in one transaction —
		// far below the 16,777,216 byte budget.
		const rowsAfter = await t.run(async (ctx) => {
			return (await ctx.db.query("briefingNoteParticipants").collect())
				.length;
		});
		expect(rowsAfter).toBe(NOTE_COUNT * 2);

		// Spot-check: the last note (which only a fully-drained corpus
		// reaches) is indexed.
		const lastNoteRows = await t.run(async (ctx) => {
			return await ctx.db
				.query("briefingNoteParticipants")
				.withIndex("by_note", (q) =>
					q.eq("noteId", noteIds[NOTE_COUNT - 1]),
				)
				.collect();
		});
		expect(lastNoteRows).toHaveLength(2);
	});

	test("idempotent across a resumed multi-page drain: re-running the full scheduled drain twice leaves the junction row count unchanged", async () => {
		const t = createTestConvex();

		// 40 notes spans 3 pages at BACKFILL_BATCH_SIZE=16 (16 + 16 + 8),
		// exercising the self-scheduling continuation path (not just a
		// single-page corpus).
		const NOTE_COUNT = 40;
		for (let i = 0; i < NOTE_COUNT; i++) {
			await seedNoteWithoutSync(t, ["laurent", `participant-${i}`]);
		}

		// First full drain (kick off + let it self-schedule to completion).
		await t.mutation(internal.migrations.backfillBriefingNoteParticipants, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const countAfterFirstDrain = await t.run(async (ctx) => {
			return (await ctx.db.query("briefingNoteParticipants").collect())
				.length;
		});
		expect(countAfterFirstDrain).toBe(NOTE_COUNT * 2);

		// Second full drain, from scratch — proves idempotence across a
		// complete resume/re-run of the multi-page scheduled chain, not
		// just a single-page mutation call.
		await t.mutation(internal.migrations.backfillBriefingNoteParticipants, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const countAfterSecondDrain = await t.run(async (ctx) => {
			return (await ctx.db.query("briefingNoteParticipants").collect())
				.length;
		});
		expect(countAfterSecondDrain).toBe(countAfterFirstDrain);

		// Resume-mid-corpus pole: simulate a drain that starts partway
		// through by passing an explicit cursor from a fresh page read, and
		// confirm re-processing already-synced notes doesn't duplicate rows
		// (syncParticipantIndex's delete-then-reinsert makes each page
		// idempotent regardless of where in the corpus it starts).
		const midCursor = await t.run(async (ctx) => {
			const firstPage = await ctx.db
				.query("briefingNotes")
				.paginate({ cursor: null, numItems: 20 });
			return firstPage.continueCursor;
		});
		await t.mutation(internal.migrations.backfillBriefingNoteParticipants, {
			cursor: midCursor,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const countAfterResume = await t.run(async (ctx) => {
			return (await ctx.db.query("briefingNoteParticipants").collect())
				.length;
		});
		expect(countAfterResume).toBe(countAfterFirstDrain);
	});
});
