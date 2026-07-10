/// <reference types="vite/client" />
//
// Issue #1064 extension (slice 5) — fixPatterns:get, mirroring
// missions:get (slice 3, PR #1077) and messages:getById (PR #1076).
//
// `get` takes `v.id("fixPatterns")`. A well-formed ID from another table
// passes the MCP boundary regex (#1065) and dies one layer down, where
// Convex redacts the validator's message in prod. Relax to `v.string()`,
// narrow via `requireId`, throwing a structured `ConvexError` naming the
// offending argument.

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

// `fixPatterns:create` schedules an internal RAG-sync job via
// `ctx.scheduler.runAfter(0, ...)`. Under `convex-test`, a real timer lets
// that scheduled job execute outside the calling transaction, leaking an
// "Write outside of transaction" unhandled rejection into the test run —
// green assertions, non-zero exit. Fake timers keep the scheduled job
// pending (never fired) for the duration of each test.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

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

// `ConvexError.data` is a JSON string under convex-test and the thrown object
// in prod — both measured. Accept both.
const decodePayload = (caught: unknown): WrongTablePayload => {
	const raw = (caught as ConvexError<string | WrongTablePayload>).data;
	return typeof raw === "string" ? (JSON.parse(raw) as WrongTablePayload) : raw;
};

const newFixPattern = (t: ReturnType<typeof createT>) =>
	t.mutation(api.fixPatterns.create, {
		symptom: "Probe symptom",
		rootCause: "Probe root cause",
		tags: ["probe"],
		stack: ["convex"],
		sourceProject: "vantage-peers",
		createdBy: "sigma",
		severity: "minor",
	});

const newTask = (t: ReturnType<typeof createT>) =>
	t.mutation(api.tasks.create, {
		title: "Probe task",
		assignedTo: "sigma",
		priority: "low",
		status: "todo",
		createdBy: "sigma",
	});

describe("fixPatterns:get — wrong-table ID (issue #1064, reads)", () => {
	test("a tasks-table ID yields an actionable ConvexError naming patternId", async () => {
		const t = createT();
		const taskId = await newTask(t);

		let caught: unknown;
		try {
			await t.query(api.fixPatterns.get, {
				patternId: taskId as unknown as Id<"fixPatterns">,
			});
			throw new Error("get did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.path).toBe("patternId");
		expect(payload?.expectedTable).toBe("fixPatterns");
		expect(payload?.receivedId).toBe(taskId);
		expect(payload?.message).toContain("patternId");
		expect(payload?.message).toContain("fixPatterns");
		// Literal hint string (not the imported constant) — a mutant that empties
		// the hint at the call-site must redden this.
		expect(payload?.message).toBe(
			"patternId is not a valid fixPatterns ID. Use the full 32-char patternId returned by list_fix_patterns or search_fix_patterns.",
		);
		expect(payload?.message).not.toBe(
			"patternId is not a valid fixPatterns ID.",
		);
	});

	test("negative control: an ID from a THIRD table is also named, with its own value", async () => {
		const t = createT();
		const missionId = await t.mutation(api.missions.create, {
			name: "Probe mission",
			project: "vantage-peers",
			status: "plan",
			priority: "medium",
			pilot: "sigma",
			agents: ["sigma"],
			createdBy: "sigma",
		});

		let caught: unknown;
		try {
			await t.query(api.fixPatterns.get, {
				patternId: missionId as unknown as Id<"fixPatterns">,
			});
			throw new Error("get did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.expectedTable).toBe("fixPatterns");
		expect(payload?.receivedId).toBe(missionId);
	});

	test("positive control: a real patternId still returns the document with attempts", async () => {
		const t = createT();
		const patternId = await newFixPattern(t);
		const doc = await t.query(api.fixPatterns.get, { patternId });
		expect(doc?._id).toBe(patternId);
		expect(doc?.symptom).toBe("Probe symptom");
		expect(doc?.attempts).toEqual([]);
	});

	test("contract preserved: a valid fixPatterns ID that no longer exists returns null, does NOT throw", async () => {
		const t = createT();
		const patternId = await newFixPattern(t);
		await t.run(async (ctx) => {
			await ctx.db.delete(patternId);
		});

		// A well-formed ID of the RIGHT table pointing at a deleted doc must stay
		// a `null` return, not an error. Widening the validator must not turn a
		// benign miss into a throw.
		await expect(
			t.query(api.fixPatterns.get, { patternId }),
		).resolves.toBeNull();
	});
});
