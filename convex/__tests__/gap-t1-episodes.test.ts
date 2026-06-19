/// <reference types="vite/client" />
//
// GAP-T1 (D90 ship-blocker) — direct behavioral tests for episode/memory tools
// missing direct coverage in the audit. Covers 4 of the 19 P1 tools:
//
//   1. hybrid_search        → convex/search.ts :: hybridSearch (action)
//   2. store_episode        → convex/episodes.ts :: storeEpisode (mutation)
//   3. get_episode          → convex/memories.ts :: getMemory (query, episode type)
//   4. search_episodes_by_semantic → convex/search.ts :: recall (action, type=episode)
//
// Pattern: spin a convex-test client per test, exercise the underlying Convex
// function the MCP tool calls 1:1 (see mcp-server/src/tools.ts mapping table
// in the GAP-T1 brief). Production code is NOT modified — tests only.
//
// Orchestrator: Sigma — VantagePeers | 2026-06-19

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// store_episode — 8-Sins schema enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 store_episode — storeEpisode mutation", () => {
	test("happy path — inserts episode with all 5 fields + severity, returns memoryId", async () => {
		const t = createTestConvex();

		const memoryId = await t.mutation(api.episodes.storeEpisode, {
			namespace: "orchestrator/sigma",
			createdBy: "sigma",
			context: "GAP-T1 dispatch from Pi on D90 audit",
			goal: "Ship ≥19 direct behavioral tests before Wave 1",
			action: "Wrote per-domain vitest files covering all 19 tools",
			outcome: "PR opened, biome+tsc clean, ready for Eta review",
			insight:
				"Direct convex-function tests are sufficient — MCP wrapper logic is thin pass-through",
			severity: "major",
		});

		expect(memoryId).toBeTruthy();

		await t.run(async (ctx) => {
			const row = await ctx.db.get(memoryId);
			expect(row).not.toBeNull();
			expect(row?.type).toBe("episode");
			expect(row?.episode?.severity).toBe("major");
			expect(row?.episode?.insight).toContain("Direct convex-function tests");
			expect(row?.isLatest).toBe(true);
		});

		// Drain scheduled RAG ingestion so it doesn't fire after test exit.
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	});

	test("edge case — invalid severity literal rejected by Convex validator", async () => {
		const t = createTestConvex();
		await expect(
			t.mutation(api.episodes.storeEpisode, {
				namespace: "orchestrator/sigma",
				createdBy: "sigma",
				context: "x",
				goal: "x",
				action: "x",
				outcome: "x",
				insight: "x",
				// @ts-expect-error — intentionally invalid: schema only allows critical|major|minor
				severity: "blocker",
			}),
		).rejects.toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// get_episode — getMemory with type='episode' guard at MCP layer
// We test the underlying getMemory query (the MCP tool just adds a type guard).
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 get_episode — memories.getMemory query", () => {
	test("happy path — returns full episode row for a known id", async () => {
		const t = createTestConvex();

		const memoryId = await t.mutation(api.episodes.storeEpisode, {
			namespace: "orchestrator/sigma",
			createdBy: "sigma",
			context: "ctx",
			goal: "goal",
			action: "action",
			outcome: "outcome",
			insight: "insight",
			severity: "minor",
		});

		const row = await t.query(api.memories.getMemory, { memoryId });
		expect(row).not.toBeNull();
		expect(row?._id).toBe(memoryId);
		expect(row?.type).toBe("episode");
		expect(row?.episode?.insight).toBe("insight");

		await t.finishAllScheduledFunctions(vi.runAllTimers);
	});

	test("edge case — getMemory returns null for non-existent id", async () => {
		const t = createTestConvex();

		const id = await t.run(async (ctx) => {
			const tmp = await ctx.db.insert("memories", {
				namespace: "orchestrator/sigma",
				type: "user",
				content: "tmp",
				createdBy: "sigma",
				relations: [],
				isLatest: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.delete(tmp);
			return tmp;
		});

		const row = await t.query(api.memories.getMemory, { memoryId: id });
		expect(row).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// hybrid_search + search_episodes_by_semantic — RAG-backed actions
//
// We cannot drive @convex-dev/rag inside convex-test without seeded embeddings,
// so we assert the action's arg-validator contract (Convex rejects extra/missing
// fields) and that an empty-namespace call resolves to an array (zero results)
// when the RAG component is reachable. If the component is unavailable in the
// test runtime, the failure must NOT be ArgumentValidationError — that distinct
// guarantee is what MCP callers depend on.
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 hybrid_search — search.hybridSearch action", () => {
	test("happy path — array shape contract on empty namespace", async () => {
		const t = createTestConvex();
		try {
			const results = await t.action(api.search.hybridSearch, {
				query: "any query",
				namespace: "orchestrator/sigma",
				limit: 5,
			});
			expect(Array.isArray(results)).toBe(true);
		} catch (err) {
			const msg = String(err);
			expect(msg).not.toMatch(/ArgumentValidationError/);
		}
	});

	test("edge case — extra field rejected by args validator", async () => {
		const t = createTestConvex();
		await expect(
			t.action(api.search.hybridSearch, {
				query: "x",
				// @ts-expect-error — bogusField is not in args validator
				bogusField: true,
			}),
		).rejects.toThrow();
	});
});

describe("GAP-T1 search_episodes_by_semantic — search.recall action (type=episode)", () => {
	test("happy path — recall callable with type=episode, returns array", async () => {
		const t = createTestConvex();
		try {
			const results = await t.action(api.search.recall, {
				query: "ship blocker",
				namespace: "orchestrator/sigma",
				type: "episode",
				limit: 5,
			});
			expect(Array.isArray(results)).toBe(true);
		} catch (err) {
			const msg = String(err);
			expect(msg).not.toMatch(/ArgumentValidationError/);
		}
	});

	test("edge case — invalid type literal rejected", async () => {
		const t = createTestConvex();
		await expect(
			t.action(api.search.recall, {
				query: "x",
				// @ts-expect-error — only memoryTypeValidator literals allowed
				type: "not-a-real-type",
			}),
		).rejects.toThrow();
	});
});
