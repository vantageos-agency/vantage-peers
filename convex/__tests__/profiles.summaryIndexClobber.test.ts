/// <reference types="vite/client" />
//
// profiles.summaryIndexClobber.test.ts — TDD-RED for mission k574p02m DEFECT 1.
//
// ROOT CAUSE (measured, file:line evidence):
//   - Schema: convex/schema.ts:135-139 — `dynamic` has a SINGLE optional
//     string field `currentTask`, no separate field for a durable
//     end-of-day index vs. a live session summary.
//   - Mutation: convex/profiles.ts:138-199 (`updateDynamic`, the mutation
//     the `set_summary` MCP tool calls per mcp-server/src/tools.ts:3203
//     `convex.mutation("profiles:updateDynamic" as any, ...)`).
//     Line 190 unconditionally patches:
//       currentTask: args.currentTask ?? profile.dynamic.currentTask,
//     into the SAME `dynamic.currentTask` field every time it is called —
//     whether the caller is `close-day` step 9 writing the end-of-day
//     index, or the next-morning `daily-start` sequence writing its own
//     live-status summary BEFORE `daily-start` step 3 reads the index back.
//   - Read path: convex/profiles.ts:41-68 (`getProfile`) and
//     convex/profiles.ts:259-291 (`listProfiles`, backing `list_peers`)
//     both surface `dynamic.currentTask` (profileDocValidator,
//     convex/profiles.ts:22-26) as the ONLY place either an index or a
//     live summary can live.
//
// CLASS: durable state (the end-of-day session index) written into a field
// that another routine (the next session's startup summary write) has a
// legitimate reason to overwrite. No versioning, no separate field, no
// append-only log — last writer wins, and the eventual read is guaranteed
// wrong every single morning.
//
// This test simulates the close-day -> daily-start sequence through the
// EXACT mutation `set_summary` uses (`profiles:updateDynamic`). Close-day
// writes the durable index via the explicit `endOfDayIndex` arg (NOT via
// `currentTask` — that is the real contract: the two are distinct fields,
// and only an explicit `endOfDayIndex` arg ever writes the durable index).
// The test asserts the index written by "close-day" is still readable after
// the "daily-start" live-status write, which only ever passes `currentTask`.
//
// SECOND POLE (guard against over-correction): the test also asserts that
// `updateDynamic` STILL updates the visible live summary on every call.
// A GREEN fix that freezes `dynamic.currentTask` after the first write
// would blind the fleet to live status — this assertion must keep passing
// post-fix.
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

describe("defect 1 — end-of-day index vs live summary share one field", () => {
	test("RED: close-day index must survive the next daily-start live-status write", async () => {
		const t = convexTest(schema, modules);
		const orchestratorId = "test-orch-defect1";
		const instanceId = "test-orch-defect1-vps";

		// Seed the profile so updateDynamic patches an existing row.
		await t.mutation(api.profiles.upsertProfile, {
			orchestratorId,
			instanceId,
			name: "Test Orchestrator",
			static: { role: "test", workspace: "test-ws", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 0 },
		});

		const CLOSE_DAY_INDEX =
			"EOD-INDEX 2026-08-12: 4 tasks closed, 2 PRs merged, mission k574 at 60%";

		// Step 1 — close-day writes the end-of-day index via the explicit
		// `endOfDayIndex` arg on the SAME mutation set_summary calls
		// (profiles:updateDynamic). It does NOT pass `currentTask`.
		await t.mutation(api.profiles.updateDynamic, {
			orchestratorId,
			instanceId,
			endOfDayIndex: CLOSE_DAY_INDEX,
		});

		// Step 2 — next morning, BEFORE daily-start step 3 reads the index,
		// the startup sequence writes its own live-status summary into the
		// same call path.
		const DAILY_START_LIVE_SUMMARY = "Booting session, reading messages";
		await t.mutation(api.profiles.updateDynamic, {
			orchestratorId,
			instanceId,
			currentTask: DAILY_START_LIVE_SUMMARY,
		});

		// Step 3 — daily-start step 3 tries to read back the end-of-day
		// index. This is the assertion that MUST FAIL against current code:
		// there is no separate field, so the index is gone.
		const profile = await t.query(api.profiles.getProfile, {
			orchestratorId,
			instanceId,
		});
		expect(profile).not.toBeNull();

		// EXPECTED (post-GREEN): a durable index field distinct from the
		// live summary field. Reading `dynamic.currentTask` alone can no
		// longer hold both, so this assertion fails today by design —
		// it names the exact contract the GREEN fix must satisfy.
		const indexStillIntact =
			profile !== null &&
			profile.dynamic.endOfDayIndex === CLOSE_DAY_INDEX;
		expect(indexStillIntact).toBe(true);

		// SECOND POLE — updateDynamic must still update the LIVE summary on
		// every call. This must remain true both now and after the GREEN
		// fix: a fix that freezes the field to protect the index would
		// blind the fleet to live status.
		expect(profile?.dynamic.currentTask).toBe(DAILY_START_LIVE_SUMMARY);
	});
});
