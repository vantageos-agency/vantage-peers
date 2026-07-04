/// <reference types="vite/client" />
//
// T1 (RED) — mission fix-kb-document-indexing-v1 (k57dh3jjaz1n3hgd0wdwyvmx8189w1z0).
//
// Bug (Day 122, sentinels SIGMAVERIFY): convex/kb.ts::storeDocumentChunked inserts
// each chunk via internal.kbMutations.insertChunk but never schedules
// internal.ragSync.addRagEntry — unlike memories:storeMemory (memories.ts:84) and
// episodes:storeEpisode (episodes.ts:70). Document chunks are therefore invisible
// to recall/hybrid_search.
//
// Strategy (locked in T0, analysis/day122-kb-indexing-fix-plan.md): convex-test
// cannot drive @convex-dev/rag without seeded embeddings (see
// gap-t1-episodes.test.ts:24,145), so this test does NOT assert retrieval via
// hybrid_search. It asserts SCHEDULING of ragSync.addRagEntry via the system
// table `_scheduled_functions` — one scheduled call expected per chunk.
//
// On current code (kb.ts has no scheduler.runAfter call) this is RED: expected
// chunkCount scheduled calls, actual 0.
//
// Orchestrator: Sigma — VantagePeers | 2026-07-04

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

// Same filter as gap-t1-episodes.test.ts — ragSync module itself is excluded from
// the test registry (cannot be driven without seeded embeddings), but the
// SCHEDULING call into it (an internal action reference) can still be inspected
// via the _scheduled_functions system table without the module being loaded.
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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function seedOrgMapping(
	t: ReturnType<typeof createTestConvex>,
	clerkOrgSlug: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function withTeamIdentity(
	t: ReturnType<typeof createTestConvex>,
	orgId: string,
): ReturnType<typeof t.withIdentity> {
	return t.withIdentity({
		subject: `user-${orgId}`,
		tokenIdentifier: `test|user-${orgId}`,
		organizationId: orgId,
	} as Parameters<typeof t.withIdentity>[0]);
}

function textToArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer;
}

async function countScheduledAddRagEntry(
	t: ReturnType<typeof createTestConvex>,
): Promise<number> {
	const scheduled = await t.run(async (ctx) => {
		return await ctx.db.system.query("_scheduled_functions").collect();
	});
	return scheduled.filter((fn) =>
		JSON.stringify(fn.name).includes("addRagEntry"),
	).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// RED — storeDocumentChunked must schedule 1 addRagEntry per chunk
// ─────────────────────────────────────────────────────────────────────────────

describe("T1 RED — kb.storeDocumentChunked schedules ragSync.addRagEntry per chunk", () => {
	test("document ingest with N chunks schedules N addRagEntry calls (currently schedules 0 — RED)", async () => {
		const t = createTestConvex();
		await seedOrgMapping(t, "team-a");
		const tA = withTeamIdentity(t, "team-a");

		// Long enough plain-text document to guarantee at least one non-trivial
		// chunk (paragraph-aware splitter, ~2000-char target per chunk).
		const longText =
			"First paragraph of the KB indexing regression document. ".repeat(10) +
			"\n\n" +
			"Second paragraph continues with more content to ensure the chunker " +
			"produces at least one well-formed chunk for this fixture. ".repeat(10) +
			"\n\n" +
			"Third paragraph closes out the document body for the RED test case.";

		const bytes = textToArrayBuffer(longText);
		const storageId = await t.run(async (ctx) => {
			return await ctx.storage.store(
				new Blob([new Uint8Array(bytes)], { type: "text/plain" }),
			);
		});

		const result = await tA.action(api.kb.storeDocumentChunked, {
			storageId,
			mimeType: "text/plain",
			filename: "kb-indexing-red.txt",
			orgId: "team-a",
			namespace: "team/team-a",
		});

		expect(result.chunkCount).toBeGreaterThan(0);

		// Inspect the system table BEFORE draining — this is the assertion that
		// must fail on current code (0 scheduled calls vs expected chunkCount).
		const scheduledAddRagEntryCount = await countScheduledAddRagEntry(t);
		expect(scheduledAddRagEntryCount).toBe(result.chunkCount);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Control (must PASS) — memories:storeMemory already schedules 1 addRagEntry.
// Confirms the _scheduled_functions assertion method itself is sound.
// ─────────────────────────────────────────────────────────────────────────────

describe("Control — memories.storeMemory schedules exactly 1 addRagEntry (non-regression)", () => {
	test("storeMemory schedules 1 ragSync.addRagEntry call", async () => {
		const t = createTestConvex();

		await t.mutation(api.memories.storeMemory, {
			namespace: "orchestrator/sigma",
			type: "user",
			content: "Control-group memory for T1 scheduling assertion.",
			createdBy: "sigma",
		});

		const scheduledAddRagEntryCount = await countScheduledAddRagEntry(t);
		expect(scheduledAddRagEntryCount).toBe(1);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
	});
});
