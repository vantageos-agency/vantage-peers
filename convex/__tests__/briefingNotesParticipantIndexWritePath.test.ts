/// <reference types="vite/client" />
//
// PR #1200 Eta REVISE item 1 — the existing participant-visibility suite
// (briefingNotesParticipantVisibility.test.ts) hand-inserts rows into BOTH
// `briefingNotes` and `briefingNoteParticipants` via `t.run`, so no test
// exercises `api.briefingNotes.create` / `api.briefingNotes.update` — the
// `syncParticipantIndex` calls inside those mutations (convex/briefingNotes.ts)
// could be deleted with the suite staying green.
//
// These tests call the REAL mutations (`t.mutation(api.briefingNotes.create,
// ...)` / `t.mutation(api.briefingNotes.update, ...)`) and assert the
// `briefingNoteParticipants` junction table is populated/kept in sync as a
// side effect — proving the write path, not just the read path.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

async function junctionParticipants(
	t: ReturnType<typeof createTestConvex>,
	noteId: string,
): Promise<string[]> {
	return await t.run(async (ctx) => {
		const rows = await ctx.db
			.query("briefingNoteParticipants")
			.withIndex("by_note", (q) => q.eq("noteId", noteId as never))
			.collect();
		return rows.map((r) => r.participant).sort();
	});
}

describe("briefingNotes.create — populates briefingNoteParticipants via the real mutation", () => {
	test("create through api.briefingNotes.create inserts one junction row per participant", async () => {
		const t = createTestConvex();

		const noteId = await t.mutation(api.briefingNotes.create, {
			title: "handoff",
			topic: "daily",
			participants: ["pi", "sigma", "prometheus"],
			content: "content",
			createdBy: "sigma",
		});

		const participants = await junctionParticipants(t, noteId);
		expect(participants).toEqual(["pi", "prometheus", "sigma"]);
	});

	test("a note created through the real path grants read to a scoped participant (end-to-end, not hand-seeded)", async () => {
		const t = createTestConvex();

		const noteId = await t.mutation(api.briefingNotes.create, {
			title: "handoff",
			topic: "daily",
			participants: ["pi", "sigma", "prometheus"],
			content: "content",
			createdBy: "sigma",
		});

		const note = await t.query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["prometheus"],
		});

		expect(note).not.toBeNull();
		expect(note?.title).toBe("handoff");
	});
});

describe("briefingNotes.update — keeps briefingNoteParticipants in sync via the real mutation", () => {
	test("update through api.briefingNotes.update replaces junction rows to match new participants", async () => {
		const t = createTestConvex();

		const noteId = await t.mutation(api.briefingNotes.create, {
			title: "handoff",
			topic: "daily",
			participants: ["pi", "sigma"],
			content: "content",
			createdBy: "sigma",
		});
		expect(await junctionParticipants(t, noteId)).toEqual(["pi", "sigma"]);

		await t.mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "sigma",
			participants: ["sigma", "eta"],
		});

		expect(await junctionParticipants(t, noteId)).toEqual(["eta", "sigma"]);
	});

	test("a participant added via update gains read access; a removed participant loses it (end-to-end)", async () => {
		const t = createTestConvex();

		const noteId = await t.mutation(api.briefingNotes.create, {
			title: "handoff",
			topic: "daily",
			participants: ["pi", "sigma"],
			content: "content",
			createdBy: "sigma",
		});

		await t.mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "sigma",
			participants: ["sigma", "eta"],
		});

		const etaCanRead = await t.query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["eta"],
		});
		expect(etaCanRead).not.toBeNull();

		const piCanRead = await t.query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["pi"],
		});
		expect(piCanRead).toBeNull();
	});

	test("update WITHOUT a participants field leaves the junction table untouched", async () => {
		const t = createTestConvex();

		const noteId = await t.mutation(api.briefingNotes.create, {
			title: "handoff",
			topic: "daily",
			participants: ["pi", "sigma"],
			content: "content",
			createdBy: "sigma",
		});

		await t.mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "sigma",
			title: "handoff v2",
		});

		expect(await junctionParticipants(t, noteId)).toEqual(["pi", "sigma"]);
	});
});
