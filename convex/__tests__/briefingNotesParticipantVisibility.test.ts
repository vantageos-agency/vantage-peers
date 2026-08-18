/// <reference types="vite/client" />
//
// Day 165 fix — task k175ga65p654z200ydj7s8qv5s8cnxfc.
//
// BUG: a briefing note shared via its `participants` array was NOT readable
// by a scoped participant. get_briefing_note for a note with
// createdBy="sigma", participants=["pi","sigma","prometheus","laurent"]
// returned "not found" for "prometheus" — the MCP-server post-query filter
// (scopeFilterGet/scopeFilterList) only ever consulted `createdBy`, never
// `participants`. It worked for master only, which bypasses the filter —
// that's why the bug was masked.
//
// FIX: visibility moves INSIDE the Convex query. get/list/search accept
// `callerIdentities` (the set of names the caller's token may act as) and
// `master`. A note is visible when the caller is master, is the creator, OR
// is one of `callerIdentities` present in the `briefingNoteParticipants`
// junction table (resolved via the `by_participant_note` index — an
// index-range predicate, never a table scan / never a post-query filter).

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

async function seedNote(
	t: ReturnType<typeof createTestConvex>,
	opts: {
		title: string;
		createdBy: string;
		participants: string[];
	},
) {
	return await t.run(async (ctx) => {
		const noteId = await ctx.db.insert("briefingNotes", {
			title: opts.title,
			topic: "daily",
			participants: opts.participants,
			content: `content for ${opts.title}`,
			createdBy: opts.createdBy,
			createdAt: Date.now(),
		});
		for (const participant of opts.participants) {
			await ctx.db.insert("briefingNoteParticipants", {
				noteId,
				participant,
			});
		}
		return noteId;
	});
}

describe("briefingNotes.get — participant visibility (Day 165)", () => {
	test("a SCOPED participant (not the creator) CAN read the note — RED before fix", async () => {
		const t = createTestConvex();
		const noteId = await seedNote(t, {
			title: "handoff",
			createdBy: "sigma",
			participants: ["pi", "sigma", "prometheus", "laurent"],
		});

		const note = await t.query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["prometheus"],
		});

		expect(note).not.toBeNull();
		expect(note?.title).toBe("handoff");
	});

	test("a non-participant, non-creator SCOPED caller gets null (no leak)", async () => {
		const t = createTestConvex();
		const noteId = await seedNote(t, {
			title: "handoff",
			createdBy: "sigma",
			participants: ["pi", "sigma", "prometheus", "laurent"],
		});

		const note = await t.query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["eta"],
		});

		expect(note).toBeNull();
	});

	test("the creator can always read their own note even if not listed in participants", async () => {
		const t = createTestConvex();
		const noteId = await seedNote(t, {
			title: "solo note",
			createdBy: "sigma",
			participants: [],
		});

		const note = await t.query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["sigma"],
		});

		expect(note).not.toBeNull();
	});

	test("master sees the note regardless of participants/creator — no regression", async () => {
		const t = createTestConvex();
		const noteId = await seedNote(t, {
			title: "handoff",
			createdBy: "sigma",
			participants: ["pi", "sigma"],
		});

		const note = await t.query(api.briefingNotes.get, {
			noteId,
			master: true,
			callerIdentities: [],
		});

		expect(note).not.toBeNull();
	});

	test("omitting callerIdentities (internal/back-compat call) preserves unscoped read", async () => {
		const t = createTestConvex();
		const noteId = await seedNote(t, {
			title: "handoff",
			createdBy: "sigma",
			participants: ["pi"],
		});

		const note = await t.query(api.briefingNotes.get, { noteId });

		expect(note).not.toBeNull();
	});

	test("membership is resolved via the by_participant_note index, not the participants array field", async () => {
		const t = createTestConvex();
		// A note whose `participants` array does NOT list "prometheus" but
		// whose junction table (source of truth for the query) DOES — proves
		// the query reads the index, not `note.participants` directly.
		const noteId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("briefingNotes", {
				title: "index-sourced",
				topic: "daily",
				participants: ["pi"], // stale/out-of-sync on purpose
				content: "content",
				createdBy: "sigma",
				createdAt: Date.now(),
			});
			await ctx.db.insert("briefingNoteParticipants", {
				noteId: id,
				participant: "prometheus",
			});
			return id;
		});

		const note = await t.query(api.briefingNotes.get, {
			noteId,
			master: false,
			callerIdentities: ["prometheus"],
		});

		expect(note).not.toBeNull();
	});
});

describe("briefingNotes.list — participant visibility parity", () => {
	test("a scoped participant sees a note they did not create", async () => {
		const t = createTestConvex();
		await seedNote(t, {
			title: "owned by pi",
			createdBy: "pi",
			participants: ["pi", "prometheus"],
		});
		await seedNote(t, {
			title: "owned by pi, no prometheus",
			createdBy: "pi",
			participants: ["pi"],
		});

		const notes = await t.query(api.briefingNotes.list, {
			fields: "full",
			master: false,
			callerIdentities: ["prometheus"],
		});

		const titles = notes.map((n: { title: string }) => n.title);
		expect(titles).toContain("owned by pi");
		expect(titles).not.toContain("owned by pi, no prometheus");
	});
});

describe("briefingNotes.searchBriefingNotesByKeyword — participant visibility parity", () => {
	test("a scoped participant, same tenant, finds a note they did not create via keyword search", async () => {
		const t = createTestConvex();
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "acme-hr",
				allowedOrchestrators: ["prometheus"],
				scopes: ["view-own-tasks"],
				displayName: "acme-hr",
				isActive: true,
				createdAt: Date.now(),
			});
		});
		const noteId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("briefingNotes", {
				title: "shared roadmap",
				topic: "daily",
				participants: ["pi", "prometheus"],
				content: "matchtoken content",
				createdBy: "pi",
				createdAt: Date.now(),
				orgId: "acme-hr",
			});
			await ctx.db.insert("briefingNoteParticipants", {
				noteId: id,
				participant: "prometheus",
			});
			return id;
		});

		const tScoped = t.withIdentity({
			subject: "user-prometheus",
			organizationId: "acme-hr",
		} as Parameters<typeof t.withIdentity>[0]);

		const results = await tScoped.query(
			api.briefingNotes.searchBriefingNotesByKeyword,
			{
				query: "matchtoken",
				master: false,
				callerIdentities: ["prometheus"],
			},
		);

		expect(
			results.some((r: { title: string }) => r.title === "shared roadmap"),
		).toBe(true);
		expect(noteId).toBeDefined();
	});
});
