/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

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
});
