/// <reference types="vite/client" />
//
// computeStaleInProgress (convex/lib/taskClosureGate.ts) was a bare
// `.collect()` on `by_assignee` with no cap — unlike its siblings
// computeStuckInProgress / computePeersStuckOnYou, which walk the same
// index via `walkIndexedTasks` (STATUS_SCAN_BUDGET-bounded scan,
// MATCH_ENTRY_CAP-bounded returned entries). A recipient with a very large
// stale in_progress backlog could blow the same "too many documents
// scanned" production ceiling checkNewMessagesEnvelope hit on the receipts
// side (issue #1285/#1220).
//
// checkNewMessagesEnvelope's `staleInProgress` return validator is a bare
// array (v.array(...), not the capped-list shape used by stuckInProgress /
// peersStuckOnYou) — a FROZEN return shape per the task brief ("prefer a
// fix that keeps the returned shape identical so no reader change is
// needed"). So this test asserts the externally-observable proxy for
// truncation available under that constraint: entries.length stays capped
// at MATCH_ENTRY_CAP even when far more than MATCH_ENTRY_CAP matching stale
// tasks exist in the backlog.
//
// RED on pre-fix code (bare `.collect()`, no cap): entries.length equals
// the full seeded count (unbounded).
// GREEN on fixed code (walkIndexedTasks + MATCH_ENTRY_CAP): entries.length
// is capped at MATCH_ENTRY_CAP.

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../schema";
import {
	computeStaleInProgress,
	MATCH_ENTRY_CAP,
	STATUS_SCAN_BUDGET,
} from "../lib/taskClosureGate";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1000;

test(
	`computeStaleInProgress caps entries at MATCH_ENTRY_CAP (${MATCH_ENTRY_CAP}) even with a STATUS_SCAN_BUDGET+N (${STATUS_SCAN_BUDGET}+50) stale backlog`,
	async () => {
		const t = convexTest(schema, modules);
		const seedCount = STATUS_SCAN_BUDGET + 50;
		const now = Date.now();
		const startedAt = now - TWENTY_FIVE_HOURS_MS;

		await t.run(async (ctx) => {
			for (let i = 0; i < seedCount; i++) {
				await ctx.db.insert("tasks", {
					title: `stale scan-cap task ${i}`,
					assignedTo: "victor",
					priority: "medium" as const,
					status: "in_progress" as const,
					startedAt,
					createdBy: "sigma",
					createdAt: startedAt,
					updatedAt: startedAt,
				});
			}
		});

		const entries = await t.run((ctx) =>
			computeStaleInProgress(ctx, "victor", now),
		);

		expect(entries.length).toBe(MATCH_ENTRY_CAP);
	},
	30_000,
);
