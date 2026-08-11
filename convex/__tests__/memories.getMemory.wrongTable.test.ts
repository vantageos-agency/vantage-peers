/// <reference types="vite/client" />
//
// Issue #1064 extension (slice 4) — memories:getMemory, mirroring
// missions:get (PR #1077), messages:getById (PR #1076), briefingNotes:get /
// businessUnits:get (PR #1075).
//
// `memories:getMemory` takes `v.id("memories")`. A well-formed ID from
// another table passes the MCP boundary regex (#1065) and dies one layer
// down, where Convex redacts the validator's message in prod. The caller
// sees `[Request ID: …] Server Error` with `error.data` undefined — nothing
// to act on.
//
// Same contract as PR #1069 / #1072 / #1075 / #1076 / #1077: the `v.id()`
// validator runs BEFORE the handler, so there is no seam to intercept its
// rejection while it is in place. Relax to `v.string()`, then
// `ctx.db.normalizeId` via the `requireId` helper, throwing a structured
// `ConvexError` naming the offending argument.

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

// `storeMemory` / `softDeleteMemory` schedule `ragSync` functions via
// `ctx.scheduler.runAfter`. `ragSync` is excluded from `modules` above (keeps
// convex-test hermetic, no embedding deps), so on REAL timers those scheduled
// jobs fire after the test completes and reject with "Could not find module for:
// ragSync" as UNHANDLED errors — green assertions, red CI job. Fake timers keep
// the scheduler under test control so nothing leaks (same pattern as kb-ingest).
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

type WrongTablePayload = {
	path?: string;
	expectedTable?: string;
	receivedId?: string;
	message?: string;
};

// `ConvexError.data` is a JSON string under convex-test and the thrown object
// in prod — both measured. Accept both.
const decodePayload = (caught: unknown): WrongTablePayload => {
	const raw = (caught as ConvexError<string | WrongTablePayload>).data;
	return typeof raw === "string" ? (JSON.parse(raw) as WrongTablePayload) : raw;
};

const newMemory = (t: ReturnType<typeof createT>) =>
	t.mutation(api.memories.storeMemory, {
		namespace: "global",
		type: "reference",
		content: "Probe memory",
		createdBy: "sigma",
	});

const newMission = (t: ReturnType<typeof createT>) =>
	t.mutation(api.missions.create, {
		name: "Probe mission",
		project: "vantage-peers",
		status: "plan",
		priority: "medium",
		pilot: "sigma",
		agents: ["sigma"],
		createdBy: "sigma",
	});

describe("memories:getMemory — wrong-table ID (issue #1064, reads)", () => {
	test("a missions-table ID yields an actionable ConvexError naming memoryId", async () => {
		const t = createT();
		const missionId = await newMission(t);

		let caught: unknown;
		try {
			await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.memories.getMemory, {
				memoryId: missionId as unknown as Id<"memories">,
			});
			throw new Error("getMemory did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.path).toBe("memoryId");
		expect(payload?.expectedTable).toBe("memories");
		expect(payload?.receivedId).toBe(missionId);
		expect(payload?.message).toContain("memoryId");
		expect(payload?.message).toContain("memories");
		// Literal hint string (not the imported constant) — a mutant that empties
		// the hint at the call-site must redden this.
		expect(payload?.message).toBe(
			"memoryId is not a valid memories ID. Use the full 32-char memoryId returned by recall or store_memory.",
		);
		expect(payload?.message).not.toBe(
			"memoryId is not a valid memories ID.",
		);
	});

	test("positive control: a real memoryId still returns the document", async () => {
		const t = createT();
		const memoryId = await newMemory(t);
		const doc = await t.withIdentity({ subject: "test-service-account-user-id" }).query(api.memories.getMemory, { memoryId });
		expect(doc?._id).toBe(memoryId);
		expect(doc?.content).toBe("Probe memory");
	});

	test("contract preserved: a valid memories ID that no longer exists returns null, does NOT throw", async () => {
		const t = createT();
		const memoryId = await newMemory(t);
		await t.run(async (ctx) => {
			await ctx.db.delete(memoryId);
		});

		// A well-formed ID of the RIGHT table pointing at a deleted doc must stay
		// a `null` return, not an error. Widening the validator must not turn a
		// benign miss into a throw.
		await expect(
			t.withIdentity({ subject: "test-service-account-user-id" }).query(api.memories.getMemory, { memoryId }),
		).resolves.toBeNull();
	});
});
