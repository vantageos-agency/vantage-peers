/// <reference types="vite/client" />
//
// briefing-notes-updatedsince-never-edited.test.ts — PR #1261 REVISE fix.
//
// `updatedAt` on `briefingNotes` is OPTIONAL ("set on first update" — see
// convex/schema.ts). A note created and never edited has `updatedAt ===
// undefined`. That's the table's DEFAULT state: `create` (convex/
// briefingNotes.ts) and `_insertImportedBriefing` (convex/okfBundle.ts)
// never set it.
//
// The `updatedSince` branch of `briefingNotes.list` pushes the bound into
// the query via `.gte("updatedAt", since)` on `by_updatedAt` /
// `by_topic_updatedAt`. That index-range predicate can never match a row
// whose `updatedAt` is undefined, no matter how recently it was created —
// so every never-edited note silently fell out of `updatedSince`, a
// regression against the pre-index `(updatedAt ?? updatedAt's fallback
// createdAt) >= since` filter it replaced.
//
// This file proves the fix as three poles that must ALL hold in the same
// run, over the SAME fixture shape (no-topic branch AND topic branch):
//   1. POSITIVE CONTROL — a note WITH updatedAt inside the window is
//      returned (the instrument can return a row at all).
//   2. THE BITING CASE — a note CREATED inside the window and NEVER edited
//      (updatedAt undefined) is returned. At the pre-fix commit this
//      returns 0; on origin/main (pre-index) it returns 1 — same fixture,
//      this is the regression this branch introduced and this file closes.
//   3. THE REFUSAL POLE — a note created BEFORE the window and never
//      edited is NOT returned.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type Row = Record<string, unknown>;

function extractItems(result: unknown): Row[] {
	if (Array.isArray(result)) return result as Row[];
	if (result !== null && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (Array.isArray(r.items)) return r.items as Row[];
	}
	return [];
}

describe("briefingNotes.list — updatedSince covers never-edited notes (no-topic branch)", () => {
	test("all three poles in one run: positive control, biting case, refusal pole", async () => {
		const t = convexTest(schema, modules);
		const SINCE_THRESHOLD = Date.now() - 1_000;
		const INSIDE_WINDOW = Date.now(); // >= SINCE_THRESHOLD
		const BEFORE_WINDOW = Date.now() - 100_000_000; // < SINCE_THRESHOLD

		await t.run(async (ctx) => {
			// 1. Positive control — edited, updatedAt inside the window.
			await ctx.db.insert("briefingNotes", {
				title: "positive-control-edited-note",
				topic: "fixture-topic-never-edited",
				participants: ["test-orch-never-edited"],
				content: "fixture content",
				createdBy: "test-orch-never-edited",
				createdAt: BEFORE_WINDOW, // stale createdAt — only updatedAt should matter here
				updatedAt: INSIDE_WINDOW,
			} as never);

			// 2. The biting case — created inside the window, NEVER edited
			// (no updatedAt field at all).
			await ctx.db.insert("briefingNotes", {
				title: "biting-case-never-edited-note",
				topic: "fixture-topic-never-edited",
				participants: ["test-orch-never-edited"],
				content: "fixture content",
				createdBy: "test-orch-never-edited",
				createdAt: INSIDE_WINDOW,
				// updatedAt intentionally omitted.
			} as never);

			// 3. The refusal pole — created BEFORE the window, never edited.
			await ctx.db.insert("briefingNotes", {
				title: "refusal-pole-old-never-edited-note",
				topic: "fixture-topic-never-edited",
				participants: ["test-orch-never-edited"],
				content: "fixture content",
				createdBy: "test-orch-never-edited",
				createdAt: BEFORE_WINDOW,
				// updatedAt intentionally omitted.
			} as never);
		});

		const result = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.briefingNotes.list, {
				updatedSince: SINCE_THRESHOLD,
				limit: 10,
				fields: "full",
			});
		const items = extractItems(result);
		const titles = items.map((r) => r.title as string);

		expect(titles).toContain("positive-control-edited-note");
		expect(titles).toContain("biting-case-never-edited-note");
		expect(titles).not.toContain("refusal-pole-old-never-edited-note");
		expect(items.length).toBe(2);
	});
});

describe("briefingNotes.list — updatedSince covers never-edited notes (topic branch)", () => {
	test("all three poles in one run: positive control, biting case, refusal pole", async () => {
		const t = convexTest(schema, modules);
		const TOPIC = "fixture-topic-never-edited-scoped";
		const SINCE_THRESHOLD = Date.now() - 1_000;
		const INSIDE_WINDOW = Date.now();
		const BEFORE_WINDOW = Date.now() - 100_000_000;

		await t.run(async (ctx) => {
			await ctx.db.insert("briefingNotes", {
				title: "positive-control-edited-note-topic",
				topic: TOPIC,
				participants: ["test-orch-never-edited-topic"],
				content: "fixture content",
				createdBy: "test-orch-never-edited-topic",
				createdAt: BEFORE_WINDOW,
				updatedAt: INSIDE_WINDOW,
			} as never);

			await ctx.db.insert("briefingNotes", {
				title: "biting-case-never-edited-note-topic",
				topic: TOPIC,
				participants: ["test-orch-never-edited-topic"],
				content: "fixture content",
				createdBy: "test-orch-never-edited-topic",
				createdAt: INSIDE_WINDOW,
			} as never);

			await ctx.db.insert("briefingNotes", {
				title: "refusal-pole-old-never-edited-note-topic",
				topic: TOPIC,
				participants: ["test-orch-never-edited-topic"],
				content: "fixture content",
				createdBy: "test-orch-never-edited-topic",
				createdAt: BEFORE_WINDOW,
			} as never);

			// Different topic — must never leak into a topic-scoped query.
			await ctx.db.insert("briefingNotes", {
				title: "wrong-topic-never-edited-note",
				topic: "fixture-topic-never-edited-scoped-DIFFERENT",
				participants: ["test-orch-never-edited-topic"],
				content: "fixture content",
				createdBy: "test-orch-never-edited-topic",
				createdAt: INSIDE_WINDOW,
			} as never);
		});

		const result = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.briefingNotes.list, {
				topic: TOPIC,
				updatedSince: SINCE_THRESHOLD,
				limit: 10,
				fields: "full",
			});
		const items = extractItems(result);
		const titles = items.map((r) => r.title as string);

		expect(titles).toContain("positive-control-edited-note-topic");
		expect(titles).toContain("biting-case-never-edited-note-topic");
		expect(titles).not.toContain("refusal-pole-old-never-edited-note-topic");
		expect(titles).not.toContain("wrong-topic-never-edited-note");
		expect(items.length).toBe(2);
	});
});
