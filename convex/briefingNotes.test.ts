/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Exclude RAG/search/backfill modules — same exclusion as tests.test.ts
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("./**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function createTestConvex() {
	// SECURITY REMEDIATION (task k1712yrxjr570m6ks81rnhjh5n8cryf0) — task
	// mutations now require a verified identity; seed with the master
	// service-account identity.
	return convexTest(schema, modules).withIdentity({
		subject: "test-service-account-user-id",
	});
}

// Helper: create a briefing note seeded with sensible defaults
async function seedNote(
	t: ReturnType<typeof createTestConvex>,
	overrides: {
		title?: string;
		topic?: string;
		participants?: string[];
		content?: string;
		decisions?: string[];
		createdBy?: string;
	} = {},
) {
	return await t.mutation(api.briefingNotes.create, {
		title: overrides.title ?? "old-title",
		topic: overrides.topic ?? "test-topic",
		participants: overrides.participants ?? ["sigma"],
		content: overrides.content ?? "test-content",
		decisions: overrides.decisions,
		createdBy: overrides.createdBy ?? "sigma",
	});
}

describe("briefingNotes:update", () => {
	test("update title only — other fields preserved", async () => {
		const t = createTestConvex();
		const noteId = await seedNote(t, {
			title: "old-title",
			content: "test-content",
			decisions: ["decision-1"],
		});
		await t.mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "sigma",
			title: "new-title",
		});
		const updated = await t.query(api.briefingNotes.get, { noteId });
		expect(updated?.title).toBe("new-title");
		expect(updated?.content).toBe("test-content"); // unchanged
		expect(updated?.decisions).toEqual(["decision-1"]); // unchanged
	});

	test("update content only — title preserved", async () => {
		const t = createTestConvex();
		const noteId = await seedNote(t, {
			title: "old-title",
			content: "old-content",
		});
		await t.mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "sigma",
			content: "new-content",
		});
		const updated = await t.query(api.briefingNotes.get, { noteId });
		expect(updated?.content).toBe("new-content");
		expect(updated?.title).toBe("old-title");
	});

	test("update decisions replaces (not appends) prior decisions", async () => {
		const t = createTestConvex();
		const noteId = await seedNote(t, {
			decisions: ["d1", "d2"],
		});
		await t.mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "sigma",
			decisions: ["d3"],
		});
		const updated = await t.query(api.briefingNotes.get, { noteId });
		expect(updated?.decisions).toEqual(["d3"]); // not ["d1", "d2", "d3"]
	});

	test("invalid linkedMemoryIds (foreign-table id) rejected by validator", async () => {
		const t = createTestConvex();
		const noteId = await seedNote(t);
		// Insert a tasks row to get a tasks-table id (wrong table for linkedMemoryIds)
		const taskId = await t.mutation(api.tasks.create, {
			title: "dummy task",
			assignedTo: "sigma",
			priority: "low",
			status: "todo",
			createdBy: "sigma",
		});
		await expect(
			t.mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: "sigma",
				linkedMemoryIds: [taskId as unknown as string] as never,
			}),
		).rejects.toThrow(/Expected ID for table "memories"/); // validator catches v.id("memories") mismatch
	});

	test("RBAC reject — non-creator non-system caller throws Unauthorized", async () => {
		const t = createTestConvex();
		const noteId = await seedNote(t, { createdBy: "sigma" });
		await expect(
			t.mutation(api.briefingNotes.update, {
				noteId,
				callerOrchestrator: "tau", // not sigma, not system
				title: "should-fail",
			}),
		).rejects.toThrow(/Unauthorized: tau is not creator/);
	});

	test("updatedAt + updatedBy set after successful patch", async () => {
		const t = createTestConvex();
		const noteId = await seedNote(t);
		const before = await t.query(api.briefingNotes.get, { noteId });
		expect(before?.updatedAt).toBeUndefined();
		await t.mutation(api.briefingNotes.update, {
			noteId,
			callerOrchestrator: "sigma",
			title: "new",
		});
		const after = await t.query(api.briefingNotes.get, { noteId });
		expect(after?.updatedAt).toBeGreaterThan(0);
		expect(after?.updatedBy).toBe("sigma");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// briefingNotes:create — linkedMemoryIds validator (Day 52 PM bug / k1764wwsyczv92a3g4q3gp0egn85n0q8)
//
// Root cause: caller passes a briefingNotes document ID in linkedMemoryIds[].
// Convex validates each element as v.id("memories") and rejects with
// ArgumentValidationError containing the path .linkedMemoryIds[N].
// ─────────────────────────────────────────────────────────────────────────────

describe("briefingNotes:create — linkedMemoryIds validator", () => {
	test("create rejects a briefingNotes-table ID in linkedMemoryIds with validator error", async () => {
		const t = createTestConvex();
		// First create a real briefing note to obtain its ID
		const briefingId = await seedNote(t);
		// Pass that briefingNotes ID as a linkedMemoryIds entry — wrong table
		await expect(
			t.mutation(api.briefingNotes.create, {
				title: "test-create",
				topic: "architecture",
				participants: ["sigma"],
				content: "test content",
				createdBy: "sigma",
				linkedMemoryIds: [briefingId as unknown as string] as never,
			}),
		).rejects.toThrow(/Expected ID for table "memories"/); // ArgumentValidationError at .linkedMemoryIds[0]
	});

	test("create rejects a tasks-table ID in linkedMemoryIds with validator error", async () => {
		const t = createTestConvex();
		const taskId = await t.mutation(api.tasks.create, {
			title: "dummy",
			assignedTo: "sigma",
			priority: "low",
			status: "todo",
			createdBy: "sigma",
		});
		await expect(
			t.mutation(api.briefingNotes.create, {
				title: "test-create",
				topic: "architecture",
				participants: ["sigma"],
				content: "test content",
				createdBy: "sigma",
				linkedMemoryIds: [taskId as unknown as string] as never,
			}),
		).rejects.toThrow(/Expected ID for table "memories"/);
	});

	test("create succeeds when linkedMemoryIds is omitted", async () => {
		const t = createTestConvex();
		const noteId = await t.mutation(api.briefingNotes.create, {
			title: "test",
			topic: "test",
			participants: ["sigma"],
			content: "test",
			createdBy: "sigma",
		});
		expect(noteId).toBeTruthy();
		expect(typeof noteId).toBe("string");
	});
});
