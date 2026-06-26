/// <reference types="vite/client" />
//
// improvisationDigest.test.ts — PR-I TDD-RED phase
// ─────────────────────────────────────────────────────────────────────────────
//
// Tests for the `improvisationDigest:scanWindow` query.
// Mission k571gcctka8mq5jbkgpj0a0b2n892ctg — Bloc A PR-I.
//
// Pi-approved Option C (msg jn779tfjpg68v01db67b4ht20c189c8yw-class):
//   V1 data source = VP tasks + messages aggregation (NOT transcript replay).
//   Transcript replay (Option A) reserved for V2 evolution.
//
// Eta heuristic verbatim (msg jn7djm1hx4vjgxtz9mh80hzbkx893z17):
//   "flag a turn that emits a DURABLE ARTIFACT with NO recall/search/get
//    tool_use upstream in the same turn — calibrate on artifacts, not chat."
//
// V1 proxy (Option C — VP records, no tool-use logs):
//   DURABLE ARTIFACT =
//     (a) closed task  : completionNote is non-trivial (≥ ~15 chars)
//     (b) sent message : content includes [STATUS]|[DONE]|[REVIEW]|[INFO ONLY] marker
//     (c) stored memory: type = "reference" | "feedback" mentioning fleet/state
//
//   RECALL UPSTREAM proxy =
//     VP-Sources footer regex present in the artifact text:
//       VP-Sources:\s*(recall|search|hybrid)\("[^"]*"\)\s*→\s*\[[^\]]*\]\s*\|?\s*(none-needed:\s*[^|]+)?
//     OR standalone `none-needed:<reason>` clause.
//
//   FLEET/STATE SCOPE FILTER (Eta A5, msg jn7cjgzf90mss0vvc0ndvrrfms893j8j):
//     Artifact content MUST match at least ONE of:
//       - SHA pattern       \b[0-9a-f]{7,40}\b
//       - PR/issue number   \B#\d{2,5}\b
//       - Mission/task/memory id  \b[jkm][0-9a-z]{20,}\b
//       - Decisive verb     \b(merged|deployed|tested|approved|reviewed|verified|
//                              passed|failed|landed|shipped)\b  (case-insensitive)
//     Trivial turns (no fleet/state token) → SKIP, not flagged.
//
//   IMPROVISATION FLAG = passes scope filter AND has NO VP-Sources footer.
//   MODE = ADVISORY only — query NEVER blocks any action.
//
// Query args contract:
//   windowDays   : v.number()   — default 7
//   orchestrators: v.optional(v.array(v.string())) — scope to these roles
//
// Return contract:
//   countsByOrch      : { [orchRole: string]: number }
//   countsByCategory  : { complete_task: number; send_message: number; store_memory: number }
//   samples           : Array<{
//     orchestrator : string
//     day          : string   // ISO date "YYYY-MM-DD"
//     category     : "complete_task" | "send_message" | "store_memory"
//     snippet      : string   // ≤ 200 chars
//     artifactId   : string
//   }> — capped at 50, newest first
//
// RED STRATEGY:
//   T1–T7 call api.improvisationDigest.scanWindow (does not yet exist).
//   convex-test throws "Could not find public function for
//   'improvisationDigest:scanWindow'" — propagates naturally — RED.
//
// ─────────────────────────────────────────────────────────────────────────────

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

// Exclude RAG/search/backfill modules (standard pattern in this test suite)
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// ─── Seed helpers ─────────────────────────────────────────────────────────────

// VP-Sources footer that satisfies the proxy "recall upstream" check
const WITH_FOOTER =
	'\nVP-Sources: recall("PR-X merge state")→[k171xy] | none-needed:trivial-rename';

// A decisive-verb snippet that passes the fleet/state scope filter
const FLEET_SNIPPET = "merged PR #999";

// ISO date for seeded artifacts — use a recent fixed timestamp
const BASE_DAY_MS = new Date("2026-06-20T10:00:00Z").getTime();

// ─── T1: envelope shape with empty database ──────────────────────────────────

describe("improvisationDigest.scanWindow query (PR-I RED)", () => {
	test("T1: query exists + returns correct envelope shape with empty input", async () => {
		const t = convexTest(schema, modules);

		// RED: throws "Could not find public function for 'improvisationDigest:scanWindow'"
		const result = await t.query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
		});

		// Envelope shape assertions (will run post-T-GREEN)
		expect(result).toBeDefined();
		expect(typeof result.countsByOrch).toBe("object");
		expect(result.countsByOrch).not.toBeNull();
		expect(typeof result.countsByCategory).toBe("object");
		expect(typeof result.countsByCategory.complete_task).toBe("number");
		expect(typeof result.countsByCategory.send_message).toBe("number");
		expect(typeof result.countsByCategory.store_memory).toBe("number");
		expect(Array.isArray(result.samples)).toBe(true);
		// Empty DB → zero flags
		expect(result.countsByCategory.complete_task).toBe(0);
		expect(result.countsByCategory.send_message).toBe(0);
		expect(result.countsByCategory.store_memory).toBe(0);
		expect(result.samples).toHaveLength(0);
	});

	// ─── T2: complete_task with decisive verb + NO footer → 1 flag ───────────

	test("T2: complete_task with 'merged PR #999' + NO VP-Sources footer → 1 flag in countsByCategory.complete_task", async () => {
		const t = convexTest(schema, modules);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await t.run(async (ctx: any) => {
			const now = Date.now();
			const id = await ctx.db.insert("tasks", {
				title: "Ship feature",
				assignedTo: "sigma",
				priority: "medium",
				status: "done",
				createdBy: "sigma",
				completionNote: FLEET_SNIPPET, // "merged PR #999" — no footer
				completedAt: BASE_DAY_MS,
				createdAt: BASE_DAY_MS,
				updatedAt: now,
			} as never);
			return id;
		});

		// RED: throws today
		const result = await t.query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
		});

		expect(result.countsByCategory.complete_task).toBe(1);
		expect(result.countsByCategory.send_message).toBe(0);

		// Sample must carry orchestrator + snippet
		expect(result.samples).toHaveLength(1);
		expect(result.samples[0].orchestrator).toBe("sigma");
		expect(result.samples[0].category).toBe("complete_task");
		expect(result.samples[0].snippet.length).toBeGreaterThan(0);
		expect(result.samples[0].snippet.length).toBeLessThanOrEqual(200);
		expect(result.samples[0].artifactId).toBeTruthy();
	});

	// ─── T3: complete_task WITH VP-Sources footer → NOT flagged ──────────────

	test("T3: complete_task with 'merged PR #999' + VP-Sources footer → NOT flagged", async () => {
		const t = convexTest(schema, modules);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await t.run(async (ctx: any) => {
			const now = Date.now();
			await ctx.db.insert("tasks", {
				title: "Ship feature with recall",
				assignedTo: "sigma",
				priority: "medium",
				status: "done",
				createdBy: "sigma",
				// Footer present — proxy for "recall upstream" → NOT improvisation
				completionNote: FLEET_SNIPPET + WITH_FOOTER,
				completedAt: BASE_DAY_MS,
				createdAt: BASE_DAY_MS,
				updatedAt: now,
			} as never);
		});

		// RED: throws today
		const result = await t.query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
		});

		// Footer present → NOT flagged
		expect(result.countsByCategory.complete_task).toBe(0);
		expect(result.samples).toHaveLength(0);
	});

	// ─── T4: complete_task with no fleet/state token → NOT flagged (Eta A5) ──

	test("T4: complete_task with trivial completionNote (no fleet/state token) → NOT flagged (Eta A5 scope filter)", async () => {
		const t = convexTest(schema, modules);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await t.run(async (ctx: any) => {
			const now = Date.now();
			await ctx.db.insert("tasks", {
				title: "Minor cleanup",
				assignedTo: "pi",
				priority: "low",
				status: "done",
				createdBy: "pi",
				// "task closed cleanly" — no SHA, no #PR, no decisive verb, no id
				completionNote: "task closed cleanly",
				completedAt: BASE_DAY_MS,
				createdAt: BASE_DAY_MS,
				updatedAt: now,
			} as never);
		});

		// RED: throws today
		const result = await t.query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
		});

		// No fleet/state token → trivial turn → SKIP (Eta A5)
		expect(result.countsByCategory.complete_task).toBe(0);
		expect(result.samples).toHaveLength(0);
	});

	// ─── T5: send_message with [STATUS] marker + decisive verb + NO footer ────

	test("T5: send_message with [STATUS] marker + 'deployed prod' + NO footer → 1 flag in countsByCategory.send_message", async () => {
		const t = convexTest(schema, modules);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await t.run(async (ctx: any) => {
			const now = Date.now();
			await ctx.db.insert("messages", {
				from: "sigma",
				channel: "broadcast",
				// [STATUS] marker + decisive verb "deployed" → scope filter passes
				// No VP-Sources footer → flag as improvisation
				content: "[STATUS] deployed prod at 14:32 — PR #512 live",
				sessionDay: 109,
				createdAt: BASE_DAY_MS,
			} as never);
		});

		// RED: throws today
		const result = await t.query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
		});

		expect(result.countsByCategory.send_message).toBe(1);
		expect(result.countsByCategory.complete_task).toBe(0);

		expect(result.samples).toHaveLength(1);
		expect(result.samples[0].orchestrator).toBe("sigma");
		expect(result.samples[0].category).toBe("send_message");
	});

	// ─── T6: orchestrators filter — sigma vs pi isolation ────────────────────

	test("T6: orchestrators=['sigma'] filter — 2 sigma flags + 1 pi flag seeded → only 2 sigma flags returned", async () => {
		const t = convexTest(schema, modules);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await t.run(async (ctx: any) => {
			const now = Date.now();

			// 3 sigma artifacts — 2 flagged (no footer), 1 not flagged (footer present)
			await ctx.db.insert("tasks", {
				title: "Sigma task flagged A",
				assignedTo: "sigma",
				priority: "medium",
				status: "done",
				createdBy: "sigma",
				completionNote: "merged PR #101 into main",
				completedAt: BASE_DAY_MS,
				createdAt: BASE_DAY_MS,
				updatedAt: now,
			} as never);

			await ctx.db.insert("tasks", {
				title: "Sigma task flagged B",
				assignedTo: "sigma",
				priority: "medium",
				status: "done",
				createdBy: "sigma",
				completionNote: "deployed feature k571abc — approved by eta",
				completedAt: BASE_DAY_MS,
				createdAt: BASE_DAY_MS,
				updatedAt: now,
			} as never);

			await ctx.db.insert("tasks", {
				title: "Sigma task NOT flagged (footer)",
				assignedTo: "sigma",
				priority: "medium",
				status: "done",
				createdBy: "sigma",
				completionNote: "merged PR #202" + WITH_FOOTER,
				completedAt: BASE_DAY_MS,
				createdAt: BASE_DAY_MS,
				updatedAt: now,
			} as never);

			// 3 pi artifacts — 1 flagged (no footer), 2 not flagged
			await ctx.db.insert("tasks", {
				title: "Pi task flagged",
				assignedTo: "pi",
				priority: "medium",
				status: "done",
				createdBy: "pi",
				completionNote: "shipped alpha release #303",
				completedAt: BASE_DAY_MS,
				createdAt: BASE_DAY_MS,
				updatedAt: now,
			} as never);

			await ctx.db.insert("tasks", {
				title: "Pi task trivial A",
				assignedTo: "pi",
				priority: "low",
				status: "done",
				createdBy: "pi",
				completionNote: "task closed cleanly",
				completedAt: BASE_DAY_MS,
				createdAt: BASE_DAY_MS,
				updatedAt: now,
			} as never);

			await ctx.db.insert("tasks", {
				title: "Pi task with footer",
				assignedTo: "pi",
				priority: "medium",
				status: "done",
				createdBy: "pi",
				completionNote: "merged PR #404" + WITH_FOOTER,
				completedAt: BASE_DAY_MS,
				createdAt: BASE_DAY_MS,
				updatedAt: now,
			} as never);
		});

		// RED: throws today
		const result = await t.query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
			orchestrators: ["sigma"],
		});

		// Only sigma in countsByOrch
		expect(Object.keys(result.countsByOrch)).toEqual(["sigma"]);
		expect(result.countsByOrch["sigma"]).toBe(2);

		// countsByCategory totals from sigma only = 2 complete_task
		expect(result.countsByCategory.complete_task).toBe(2);
		expect(result.countsByCategory.send_message).toBe(0);

		// Pi excluded
		expect(result.countsByOrch["pi"]).toBeUndefined();
	});

	// ─── T7: samples cap at 50 — totals still accurate ───────────────────────

	test("T7: samples cap at 50 — seeding 60 flagged artifacts → samples.length=50, countsByCategory reports 60", async () => {
		const t = convexTest(schema, modules);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await t.run(async (ctx: any) => {
			const now = Date.now();
			// Seed 60 complete_task flagged artifacts (no footer, fleet token present)
			for (let i = 0; i < 60; i++) {
				await ctx.db.insert("tasks", {
					title: `Flagged task ${i}`,
					assignedTo: "sigma",
					priority: "medium",
					status: "done",
					createdBy: "sigma",
					// Each has a PR number → passes scope filter; no footer → flagged
					completionNote: `merged PR #${500 + i} into main`,
					// Stagger timestamps so ordering is deterministic
					completedAt: BASE_DAY_MS + i * 1000,
					createdAt: BASE_DAY_MS + i * 1000,
					updatedAt: now,
				} as never);
			}
		});

		// RED: throws today
		const result = await t.query(api.improvisationDigest.scanWindow, {
			windowDays: 7,
		});

		// samples CAPPED at 50
		expect(result.samples).toHaveLength(50);

		// countsByCategory reports FULL totals (60), not capped
		expect(result.countsByCategory.complete_task).toBe(60);

		// countsByOrch also reports full total
		expect(result.countsByOrch["sigma"]).toBe(60);
	});
});
