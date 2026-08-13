/// <reference types="vite/client" />
//
// profiles.listPeersPaginationGap.test.ts — TDD-RED for mission k574p02m
// DEFECT 2: `list_peers` pagination returns an empty page before the true
// end, dropping rows strictly older than the cursor anchor.
//
// ROOT CAUSE (measured, file:line evidence): convex/profiles.ts:259-291
// (`listProfiles`, the query the MCP `list_peers` tool calls per
// mcp-server/src/tools.ts:3291 `convex.query("profiles:listProfiles", ...)`).
//
//   Without `orchestratorId` (the normal `list_peers` fan-out case), EVERY
//   call — page 1 AND every subsequent page — runs the SAME unbounded query:
//
//     rows = await ctx.db.query("profiles").order("desc").take(take);
//                                                            (line 280)
//
//   `createdBefore` is applied AFTER this take, as an in-memory filter
//   (lines 285-288):
//
//     if (args.createdBefore !== undefined) {
//       const before = args.createdBefore;
//       rows = rows.filter((r) => r._creationTime < before);
//     }
//
//   This re-fetches the TOP `take` most-recent rows on every page — never
//   an offset/range query anchored on `createdBefore` — then filters that
//   SAME top-N set for rows older than the cursor. Since the top-N set is
//   (up to insert-timing) identical to what page 1 already returned, every
//   row in it is >= the cursor anchor by construction, so the filter drops
//   ALL of them: page 2 returns `[]` even though strictly-older rows exist
//   further back in the table (e.g. `pi`, `eta` in the live symptom).
//
//   The MCP layer (mcp-server/src/tools.ts:3328-3338) computes `nextCursor`
//   from the LAST row of the (unfiltered-on-fetch) page, compounding the
//   defect: the cursor names a real boundary, but the query never uses it
//   to bound the FETCH, only to post-filter an already-wrong fetch.
//
// This mirrors the exact class already named and fixed for `updatedSince`
// in convex/__tests__/updated-since-page-filter.test.ts (tasks.ts,
// missions.ts, briefingNotes.ts) — profiles.ts:282-284 even says so in a
// comment ("post-take createdBefore filter mirrors briefingNotes pattern")
// but was never wired to an indexed range query.
//
// Fictitious identifiers only — no real client names.
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

type ListProfilesRow = FunctionReturnType<
	typeof api.profiles.listProfiles
>[number];

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

describe("defect 2 — list_peers pagination drops rows older than the cursor", () => {
	test("RED: paginating to the end must return every seeded peer, none dropped", async () => {
		const t = convexTest(schema, modules);

		const TOTAL = 12;
		const PAGE_LIMIT = 5; // strictly less than TOTAL so >1 page is required
		const seededIds: string[] = [];

		// Seed TOTAL profiles in strict creation order (oldest first), so
		// the first `PAGE_LIMIT` rows returned (desc order) are the NEWEST,
		// and the oldest rows (including the "pi"/"eta"-equivalent rows)
		// only surface on later pages.
		for (let i = 0; i < TOTAL; i++) {
			const orchestratorId = `test-peer-gap-${i}`;
			seededIds.push(orchestratorId);
			await t.mutation(api.profiles.upsertProfile, {
				orchestratorId,
				instanceId: `${orchestratorId}-vps`,
				name: `Test Peer ${i}`,
				static: { role: "test", workspace: "test-ws", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 0 },
			});
		}

		// Paginate exactly the way list_peers does: repeat listProfiles with
		// `createdBefore` = last row's `_creationTime` from the prior page,
		// stopping when a page returns fewer than PAGE_LIMIT rows (i.e. the
		// true end) OR is empty.
		const collected: { orchestratorId: string; _creationTime: number }[] = [];
		let createdBefore: number | undefined = undefined;
		let pages = 0;
		const MAX_PAGES = 10; // guard against infinite loop if defect regresses further

		while (pages < MAX_PAGES) {
			pages++;
			const page: ListProfilesRow[] = await t.query(
				api.profiles.listProfiles,
				{
					limit: PAGE_LIMIT,
					createdBefore,
				},
			);
			// Only look at our seeded rows, ignore any other fixture noise.
			const relevant = page.filter((p: ListProfilesRow) =>
				seededIds.includes(p.orchestratorId),
			);
			collected.push(
				...relevant.map((p: ListProfilesRow) => ({
					orchestratorId: p.orchestratorId,
					_creationTime: p._creationTime,
				})),
			);

			if (page.length < PAGE_LIMIT || page.length === 0) break;
			const last: ListProfilesRow = page[page.length - 1];
			createdBefore = last._creationTime;
		}

		const collectedIds = new Set(collected.map((r) => r.orchestratorId));
		const missing = seededIds.filter((id) => !collectedIds.has(id));

		// RED: this must fail against current code — the oldest seeded rows
		// (the "pi"/"eta" equivalents) are dropped because page >=2 re-fetches
		// the top-N and filters it to empty instead of bounding the fetch.
		expect(missing).toEqual([]);
		expect(collectedIds.size).toBe(TOTAL);
	});
});
