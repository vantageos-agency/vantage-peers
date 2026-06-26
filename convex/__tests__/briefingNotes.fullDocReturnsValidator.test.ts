/// <reference types="vite/client" />
/**
 * convex/__tests__/briefingNotes.fullDocReturnsValidator.test.ts
 *
 * Regression suite for Day-101 sweep — briefingNotes.get returning 500 Server
 * Error due to full-doc returns-validator missing the `orgId` field added in
 * PR #360 (commit 44f0a93).
 *
 * Root cause: schema.ts briefingNotes table has `orgId: v.optional(v.string())`
 * since PR #360 (feat(scope): client_org_mapping + withOrgScope helper). The
 * returns validator of `briefingNotes.get` did not include orgId, so any
 * briefing note that has `orgId` set fails the Convex response validator → 500.
 *
 * Fix: add `orgId: v.optional(v.string())` to the inline returns block of
 * `briefingNotes.get`.
 *
 * Coverage:
 *   T1  get — note WITH orgId → 200 + full doc including orgId
 *   T2  get — note WITHOUT orgId → 200 + full doc (orgId omitted, not null)
 *   T3  update on note WITH orgId → mutation 200 + get still returns orgId
 *   T4  update on note WITHOUT orgId → mutation 200 (backward compat)
 *   T5  list regression — still returns docs without 500 (no returns validator → always passes, smoke)
 */

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

// ─── Seed helpers ─────────────────────────────────────────────────────────────

/** Insert a briefing note WITH orgId (simulates post-PR #360 tenant-scoped row). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedNoteWithOrgId(ctx: any): Promise<string> {
	return await ctx.db.insert("briefingNotes", {
		title: "Briefing with orgId",
		topic: "day-101-sweep",
		participants: ["sigma", "eta"],
		content: "Full content of the scoped briefing note",
		createdBy: "sigma",
		createdAt: Date.now(),
		orgId: "iris-rh", // the field missing from old validators
	});
}

/** Insert a briefing note WITHOUT orgId (pre-PR #360 legacy row — backward compat). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedNoteWithoutOrgId(ctx: any): Promise<string> {
	return await ctx.db.insert("briefingNotes", {
		title: "Briefing without orgId",
		topic: "day-101-sweep",
		participants: ["pi"],
		content: "Content of a legacy briefing note without orgId",
		createdBy: "pi",
		createdAt: Date.now(),
		// orgId intentionally omitted
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("briefingNotes.get — orgId returns-validator regression", () => {

	// ── T1: get — note WITH orgId ────────────────────────────────────────────
	test("T1: briefingNotes.get returns full doc for note WITH orgId (no validator 500)", async () => {
		const t = convexTest(schema, modules);
		let noteId: string | undefined;
		await t.run(async (ctx) => {
			noteId = await seedNoteWithOrgId(ctx);
		});

		// Before the fix this call triggered a 500: orgId was in the stored doc
		// but absent from the returns validator → Convex rejects the response.
		const result = await t.query(api.briefingNotes.get, { noteId: noteId as any });

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Briefing with orgId");
		// After fix: orgId is present in the returned document
		expect((result as any).orgId).toBe("iris-rh");
	});

	// ── T2: get — note WITHOUT orgId (backward compat) ──────────────────────
	test("T2: briefingNotes.get returns full doc for note WITHOUT orgId (backward compat)", async () => {
		const t = convexTest(schema, modules);
		let noteId: string | undefined;
		await t.run(async (ctx) => {
			noteId = await seedNoteWithoutOrgId(ctx);
		});

		const result = await t.query(api.briefingNotes.get, { noteId: noteId as any });

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Briefing without orgId");
		// orgId absent in old doc — field must be omitted (not null, not error)
		expect((result as any).orgId).toBeUndefined();
	});
});

describe("briefingNotes.update — smoke test with orgId note shapes", () => {

	// ── T3: update on note WITH orgId ────────────────────────────────────────
	test("T3: briefingNotes.update on note WITH orgId → updates + get returns full doc with orgId", async () => {
		const t = convexTest(schema, modules);
		let noteId: string | undefined;
		await t.run(async (ctx) => {
			noteId = await seedNoteWithOrgId(ctx);
		});

		// update mutation — should not throw
		await t.mutation(api.briefingNotes.update, {
			noteId: noteId as any,
			callerOrchestrator: "sigma",
			content: "Updated content after orgId fix",
		});

		// get should return the updated doc (with orgId still present)
		const result = await t.query(api.briefingNotes.get, { noteId: noteId as any });
		expect(result?.content).toBe("Updated content after orgId fix");
		expect((result as any).orgId).toBe("iris-rh");
	});

	// ── T4: update on note WITHOUT orgId ─────────────────────────────────────
	test("T4: briefingNotes.update on note WITHOUT orgId → updates + get returns full doc (backward compat)", async () => {
		const t = convexTest(schema, modules);
		let noteId: string | undefined;
		await t.run(async (ctx) => {
			noteId = await seedNoteWithoutOrgId(ctx);
		});

		await t.mutation(api.briefingNotes.update, {
			noteId: noteId as any,
			callerOrchestrator: "pi",
			content: "Updated legacy content without orgId",
		});

		const result = await t.query(api.briefingNotes.get, { noteId: noteId as any });
		expect(result?.content).toBe("Updated legacy content without orgId");
		expect((result as any).orgId).toBeUndefined();
	});
});

describe("briefingNotes.list — regression guard (no returns validator — smoke)", () => {

	// ── T5: list regression ──────────────────────────────────────────────────
	test("T5: briefingNotes.list still returns docs for notes with and without orgId", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await seedNoteWithOrgId(ctx);
			await seedNoteWithoutOrgId(ctx);
		});

		const result = await t.query(api.briefingNotes.list, { limit: 10 });

		expect(Array.isArray(result)).toBe(true);
		const items = result as Array<Record<string, unknown>>;
		expect(items.length).toBe(2);

		// full-doc list: must have _id, title, topic, content, createdBy
		for (const item of items) {
			expect(item).toHaveProperty("_id");
			expect(item).toHaveProperty("title");
			expect(item).toHaveProperty("topic");
			expect(item).toHaveProperty("content");
			expect(item).toHaveProperty("createdBy");
		}
	});
});
