/// <reference types="vite/client" />
//
// Issue #1064 extension (slice 4) — memories:softDeleteMemory, mirroring
// missions:get (PR #1077), messages:getById (PR #1076), briefingNotes:get /
// businessUnits:get (PR #1075).
//
// Same contract as PR #1069 / #1072 / #1075 / #1076 / #1077: relax
// `v.id("memories")` to `v.string()` and narrow via the `requireId` helper
// on the first line of the handler. Critically, `requireId` only throws on
// WRONG-TABLE ids — a valid same-table id pointing at an already-deleted
// document must still hit the PRE-EXISTING `throw new Error(...)` path, not
// a `requireId` rejection. This file pins both branches.

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
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

type WrongTablePayload = {
	path?: string;
	expectedTable?: string;
	receivedId?: string;
	message?: string;
};

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

describe("memories:softDeleteMemory — wrong-table ID (issue #1064, writes)", () => {
	test("a missions-table ID yields an actionable ConvexError naming memoryId", async () => {
		const t = createT();
		const missionId = await newMission(t);

		let caught: unknown;
		try {
			await t.mutation(api.memories.softDeleteMemory, {
				memoryId: missionId as unknown as Id<"memories">,
			});
			throw new Error(
				"softDeleteMemory did not throw — expected a ConvexError",
			);
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.path).toBe("memoryId");
		expect(payload?.expectedTable).toBe("memories");
		expect(payload?.receivedId).toBe(missionId);
		expect(payload?.message).toBe(
			"memoryId is not a valid memories ID. Use the full 32-char memoryId returned by recall or store_memory.",
		);
		expect(payload?.message).not.toBe(
			"memoryId is not a valid memories ID.",
		);
	});

	test("positive control: a valid memoryId soft-deletes the document", async () => {
		const t = createT();
		const memoryId = await newMemory(t);

		await t.mutation(api.memories.softDeleteMemory, { memoryId });

		const doc = await t.run(async (ctx) => ctx.db.get(memoryId));
		expect(doc?.isLatest).toBe(false);
	});

	test("contract preserved: a valid-but-absent memoryId still throws the ORIGINAL Error, not a ConvexError", async () => {
		const t = createT();
		const memoryId = await newMemory(t);
		await t.run(async (ctx) => {
			await ctx.db.delete(memoryId);
		});

		let caught: unknown;
		try {
			await t.mutation(api.memories.softDeleteMemory, { memoryId });
			throw new Error(
				"softDeleteMemory did not throw — expected the not-found Error",
			);
		} catch (e) {
			caught = e;
		}

		// The requireId ConvexError path must NOT be taken here — a valid
		// same-table id for a deleted doc hits the pre-existing plain Error.
		expect(caught).not.toBeInstanceOf(ConvexError);
		expect((caught as Error).message).toContain("not found");
	});
});
