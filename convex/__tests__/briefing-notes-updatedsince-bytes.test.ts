/// <reference types="vite/client" />
//
// briefing-notes-updatedsince-bytes.test.ts — Issue #1260 regression.
//
// Production error (recurring, 24h+, fleet-wide): `briefingNotes:list` threw
// "Uncaught Error: Too many bytes read in a single function execution
// (limit: 16777216)".
//
// The guard at BRIEFING_NOTES_LIST_SCAN_CAP counted ROWS (cap = 2000). The
// platform ceiling that actually breaks is BYTES: `content` holds full
// briefing bodies, so a widened `.take(BRIEFING_NOTES_LIST_SCAN_CAP + 1)`
// reads up to 2001 whole documents — and can blow the 16MB read ceiling long
// before 2000 rows are ever reached. A row-count guard is blind to the
// quantity that breaks; it is a mute instrument showing green, not an
// absent guard.
//
// This file seeds far fewer than BRIEFING_NOTES_LIST_SCAN_CAP rows, but with
// `content` large enough that the OLD widened, creation-descending
// `.take(fetchCap)` reads them ALL in one query execution and exceeds 16MB —
// reproducing the production error verbatim (convex-test's own
// HeadroomTracker enforces the real 16MB-per-execution limit when
// `transactionLimits: true` is passed to `convexTest`, same ceiling
// production hits). The fix pushes `updatedSince` into the query via
// `by_updatedAt` / `by_topic_updatedAt` (convex/schema.ts,
// convex/briefingNotes.ts) so only the rows that actually match the window
// are read — a handful of small, fresh rows, never the large stale
// population.
//
// RED-before / GREEN-after: run with `git stash` on convex/briefingNotes.ts
// + convex/schema.ts to see this throw "Read too much data ... (limit:
// 16777216 bytes)" against the pre-fix widened-scan code; GREEN on HEAD.
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

// ~220KB of content per row. Far below BRIEFING_NOTES_LIST_SCAN_CAP (2000)
// rows are needed to blow the 16MB read ceiling at this size — proof the
// defect is bytes, not row count.
const LARGE_CONTENT = "x".repeat(220_000);
const STALE_ROW_COUNT = 90; // ~19.8MB of content alone — well over 16MB.
const WRITE_CHUNK = 30; // ~6.6MB per insert transaction — under the 16MB write ceiling.

type Row = Record<string, unknown>;

function extractItems(result: unknown): Row[] {
	if (Array.isArray(result)) return result as Row[];
	if (result !== null && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (Array.isArray(r.items)) return r.items as Row[];
	}
	return [];
}

describe("briefingNotes.list — updatedSince bound is BYTE-safe, not just row-count-safe (issue #1260)", () => {
	test("no-topic branch: large stale population would blow the 16MB read ceiling under a widened scan; the indexed updatedSince bound reads only the small fresh matches", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		const OLD_UPDATED_AT = Date.now() - 100_000_000; // stale — excluded by the window
		const RECENT_UPDATED_AT = Date.now(); // fresh — included
		const SINCE_THRESHOLD = Date.now() - 1_000;

		// Seed a large-content, stale population in chunks so the SETUP writes
		// (a separate 16MB ceiling, per t.run call) never trip — only the
		// single `list` query call under test is asserted against the read
		// ceiling.
		for (let chunk = 0; chunk < STALE_ROW_COUNT; chunk += WRITE_CHUNK) {
			const end = Math.min(chunk + WRITE_CHUNK, STALE_ROW_COUNT);
			await t.run(async (ctx) => {
				for (let i = chunk; i < end; i++) {
					await ctx.db.insert("briefingNotes", {
						title: `bytes-regression-stale-note-${i}`,
						topic: "fictitious-topic-bytes-regression",
						participants: ["test-orch-bytes-regression"],
						content: LARGE_CONTENT,
						createdBy: "test-orch-bytes-regression",
						createdAt: Date.now() + i,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});
		}
		// A handful of genuinely fresh, small rows — the only rows that
		// should ever be read once the bound is pushed into the index.
		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) {
				await ctx.db.insert("briefingNotes", {
					title: `bytes-regression-fresh-note-${i}`,
					topic: "fictitious-topic-bytes-regression",
					participants: ["test-orch-bytes-regression"],
					content: "fresh fixture content",
					createdBy: "test-orch-bytes-regression",
					createdAt: Date.now() + 1_000_000,
					updatedAt: RECENT_UPDATED_AT,
				} as never);
			}
		});

		// GREEN (post-fix): only the 3 fresh rows are candidates via the
		// indexed `.gte("updatedAt", since)` range predicate — total bytes
		// read stays a few hundred bytes, nowhere near the 16MB ceiling.
		const result = await t
			.withIdentity({ subject: "test-service-account-user-id" })
			.query(api.briefingNotes.list, {
				updatedSince: SINCE_THRESHOLD,
				limit: 10,
				fields: "full",
			});
		const items = extractItems(result);
		expect(items.length).toBe(3);
		expect(
			items.every((r) => (r.title as string).startsWith("bytes-regression-fresh-note-")),
		).toBe(true);
	});

	test("topic branch: same byte-ceiling proof via by_topic_updatedAt", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		const TOPIC = "fictitious-topic-bytes-regression-scoped";
		const OLD_UPDATED_AT = Date.now() - 100_000_000;
		const RECENT_UPDATED_AT = Date.now();
		const SINCE_THRESHOLD = Date.now() - 1_000;

		for (let chunk = 0; chunk < STALE_ROW_COUNT; chunk += WRITE_CHUNK) {
			const end = Math.min(chunk + WRITE_CHUNK, STALE_ROW_COUNT);
			await t.run(async (ctx) => {
				for (let i = chunk; i < end; i++) {
					await ctx.db.insert("briefingNotes", {
						title: `bytes-regression-topic-stale-note-${i}`,
						topic: TOPIC,
						participants: ["test-orch-bytes-regression-topic"],
						content: LARGE_CONTENT,
						createdBy: "test-orch-bytes-regression-topic",
						createdAt: Date.now() + i,
						updatedAt: OLD_UPDATED_AT,
					} as never);
				}
			});
		}
		await t.run(async (ctx) => {
			for (let i = 0; i < 3; i++) {
				await ctx.db.insert("briefingNotes", {
					title: `bytes-regression-topic-fresh-note-${i}`,
					topic: TOPIC,
					participants: ["test-orch-bytes-regression-topic"],
					content: "fresh fixture content",
					createdBy: "test-orch-bytes-regression-topic",
					createdAt: Date.now() + 1_000_000,
					updatedAt: RECENT_UPDATED_AT,
				} as never);
			}
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
		expect(items.length).toBe(3);
		expect(
			items.every((r) =>
				(r.title as string).startsWith("bytes-regression-topic-fresh-note-"),
			),
		).toBe(true);
	});
});
