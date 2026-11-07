/// <reference types="vite/client" />
/**
 * store_episode CREATES, store_memory UPSERTS (task k177e8dyrnykk3c56yf2b0pgfs8hhz06).
 *
 * The oracle (.backend-doctor/vp-by-tool.csv) groups the two tools in one table
 * group (memories + oauth_access_tokens) and justifies the verb difference with an
 * exemption marker (verb) on store_episode (mcp-server/src/tools.ts). This suite
 * pins that difference on both poles, so the justification is a tested fact:
 *   - memories:storeMemory with an "updates" relation flips the target's isLatest;
 *   - episodes:storeEpisode with the same relation records it and supersedes nothing.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const master = { subject: "test-service-account-user-id" } as const;
const NS = "orchestrator/sigma";

describe("store_memory upserts, store_episode only creates", () => {
	test("POLE 1: storeMemory with an updates relation supersedes the target", async () => {
		const t = convexTest(schema, modules).withIdentity(master);
		const original = await t.mutation(api.memories.storeMemory, {
			namespace: NS,
			type: "project",
			content: "original",
			createdBy: "sigma",
		});
		await t.mutation(api.memories.storeMemory, {
			namespace: NS,
			type: "project",
			content: "newer",
			createdBy: "sigma",
			relations: [{ targetId: original, type: "updates" }],
		});
		const row = await t.run(async (ctx) => await ctx.db.get(original));
		expect(row?.isLatest).toBe(false);
	});

	test("POLE 2: storeEpisode with the same relation leaves the target latest", async () => {
		const t = convexTest(schema, modules).withIdentity(master);
		const original = await t.mutation(api.memories.storeMemory, {
			namespace: NS,
			type: "project",
			content: "original",
			createdBy: "sigma",
		});
		const episodeId = await t.mutation(api.episodes.storeEpisode, {
			namespace: NS,
			createdBy: "sigma",
			context: "c",
			goal: "g",
			action: "a",
			outcome: "o",
			insight: "i",
			severity: "minor",
			relations: [{ targetId: original, type: "updates" }],
		});
		const row = await t.run(async (ctx) => await ctx.db.get(original));
		const episode = await t.run(async (ctx) => await ctx.db.get(episodeId));
		expect(row?.isLatest).toBe(true);
		expect(episode?.isLatest).toBe(true);
	});
});
