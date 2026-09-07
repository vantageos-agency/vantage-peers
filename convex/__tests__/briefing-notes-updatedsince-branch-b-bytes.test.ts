/// <reference types="vite/client" />
//
// briefing-notes-updatedsince-branch-b-bytes.test.ts — coordinator follow-up
// on PR #1261's REVISE fix.
//
// briefing-notes-updatedsince-bytes.test.ts proves branch A (the EDITED
// population, `updatedAt >= since`) is byte-safe when the EXCLUDED/stale
// superset is byte-heavy: the index range never reads those rows at all, so
// the widened scan's old 16MB crash cannot recur. But that fixture proves
// branch B (the NEVER-EDITED population, `updatedAt` undefined AND
// `createdAt >= since`) costs nothing ONLY because it matches ZERO rows in
// that fixture (every row there has `updatedAt` set). "It never matches in
// that fixture" is not the same claim as "it is byte-bounded when it DOES
// match" — a reviewer correctly flagged this asymmetry.
//
// Measured directly (see this PR's report): 100 never-edited rows at the
// SAME 220KB content scale as the existing byte test already throw the raw
// platform error — "Read too much data in a single function execution
// (limit: 16777216 bytes)" — via branch B's own `.take(CAP + 1)`, long
// before BRIEFING_NOTES_LIST_SCAN_CAP (2000) rows are read. A row-count cap
// applied AFTER the fetch cannot save you from a fetch that never returns.
//
// The fix (convex/briefingNotes.ts, `fetchCappedOrOverflow`): branch A and
// branch B's fetches are wrapped in a try/catch that recognizes the
// platform's own byte-ceiling error and treats it exactly like a row-count
// overflow — the caller always receives OUR SCAN_CAP_EXCEEDED ConvexError,
// never the raw platform crash, and an incomplete page is refused rather
// than silently rendered as complete.
//
// This file is the branch-B twin of briefing-notes-updatedsince-bytes.test.ts:
//   - convexTest({ transactionLimits: true }) — the real 16MB tracker.
//   - Fixture: NEVER-EDITED notes only (no `updatedAt` field at all),
//     `createdAt` inside the window, content at the same 220KB scale.
//   - Population strictly ABOVE BRIEFING_NOTES_LIST_SCAN_CAP so branch B is
//     the branch that saturates by BOTH measures (bytes and rows) — not a
//     fixture that happens to dodge the row cap while merely tripping bytes.
//   - Both the no-topic and the topic branch, mirroring the existing file's
//     structure.
//   - Assert: the call does NOT throw the raw platform byte error, DOES
//     throw our own SCAN_CAP_EXCEEDED ConvexError (same shape/remedy text
//     as the existing row-count overflow tests), and the page is refused
//     — never rendered as if it were a complete, correctly-filtered result.
//
// These fixtures are LARGE (population > 2000 rows at 220KB each — over
// 400MB of source content). Test timeouts are extended accordingly.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { BRIEFING_NOTES_LIST_SCAN_CAP } from "../briefingNotes";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// Same scale as briefing-notes-updatedsince-bytes.test.ts.
const LARGE_CONTENT = "x".repeat(220_000);
const WRITE_CHUNK = 30; // ~6.6MB per insert transaction — under the 16MB write ceiling.
// Strictly above BRIEFING_NOTES_LIST_SCAN_CAP (2000) so branch B saturates
// by ROW COUNT too, not merely by bytes — the fixture the coordinator asked
// for, not a weaker stand-in.
const NEVER_EDITED_ROW_COUNT = BRIEFING_NOTES_LIST_SCAN_CAP + 1;

const TEST_TIMEOUT_MS = 180_000;

describe("briefingNotes.list — branch B (never-edited population) is byte-bounded when it SATURATES, not just when it's empty", () => {
	test(
		"no-topic branch: population of never-edited, byte-heavy notes above the cap — refused via our own SCAN_CAP_EXCEEDED, never the raw platform byte error",
		async () => {
			const t = convexTest({ schema, modules, transactionLimits: true });
			const INSIDE_WINDOW = Date.now();
			const SINCE_THRESHOLD = Date.now() - 1_000;

			for (
				let chunk = 0;
				chunk < NEVER_EDITED_ROW_COUNT;
				chunk += WRITE_CHUNK
			) {
				const end = Math.min(chunk + WRITE_CHUNK, NEVER_EDITED_ROW_COUNT);
				await t.run(async (ctx) => {
					for (let i = chunk; i < end; i++) {
						await ctx.db.insert("briefingNotes", {
							title: `branch-b-bytes-never-edited-note-${i}`,
							topic: "fictitious-topic-branch-b-bytes",
							participants: ["test-orch-branch-b-bytes"],
							content: LARGE_CONTENT,
							createdBy: "test-orch-branch-b-bytes",
							createdAt: INSIDE_WINDOW + i,
							// updatedAt intentionally omitted — never-edited.
						} as never);
					}
				});
			}

			let thrown: unknown;
			try {
				await t
					.withIdentity({ subject: "test-service-account-user-id" })
					.query(api.briefingNotes.list, {
						updatedSince: SINCE_THRESHOLD,
						limit: 10,
						fields: "full",
					});
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeDefined();
			const message =
				thrown instanceof Error ? thrown.message : String(thrown);
			// Must NOT be the raw, unactionable platform crash.
			expect(message).not.toMatch(/16777216/);
			expect(message).not.toMatch(/too much data/i);
			// Must BE our own controlled refusal, naming the cap and a remedy.
			expect(message).toMatch(
				new RegExp(
					`SCAN_CAP_EXCEEDED.*cap of ${BRIEFING_NOTES_LIST_SCAN_CAP}`,
					"s",
				),
			);
			expect(message).toContain("shrink the updatedSince window");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"topic branch: same byte-saturation proof via by_topic_updatedAt_createdAt",
		async () => {
			const t = convexTest({ schema, modules, transactionLimits: true });
			const TOPIC = "fictitious-topic-branch-b-bytes-scoped";
			const INSIDE_WINDOW = Date.now();
			const SINCE_THRESHOLD = Date.now() - 1_000;

			for (
				let chunk = 0;
				chunk < NEVER_EDITED_ROW_COUNT;
				chunk += WRITE_CHUNK
			) {
				const end = Math.min(chunk + WRITE_CHUNK, NEVER_EDITED_ROW_COUNT);
				await t.run(async (ctx) => {
					for (let i = chunk; i < end; i++) {
						await ctx.db.insert("briefingNotes", {
							title: `branch-b-bytes-topic-never-edited-note-${i}`,
							topic: TOPIC,
							participants: ["test-orch-branch-b-bytes-topic"],
							content: LARGE_CONTENT,
							createdBy: "test-orch-branch-b-bytes-topic",
							createdAt: INSIDE_WINDOW + i,
						} as never);
					}
				});
			}

			let thrown: unknown;
			try {
				await t
					.withIdentity({ subject: "test-service-account-user-id" })
					.query(api.briefingNotes.list, {
						topic: TOPIC,
						updatedSince: SINCE_THRESHOLD,
						limit: 10,
						fields: "full",
					});
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeDefined();
			const message =
				thrown instanceof Error ? thrown.message : String(thrown);
			expect(message).not.toMatch(/16777216/);
			expect(message).not.toMatch(/too much data/i);
			expect(message).toMatch(
				new RegExp(
					`SCAN_CAP_EXCEEDED.*cap of ${BRIEFING_NOTES_LIST_SCAN_CAP}.*Narrow with topic.*shrink the updatedSince window`,
					"s",
				),
			);
		},
		TEST_TIMEOUT_MS,
	);
});
