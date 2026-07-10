/// <reference types="vite/client" />
//
// Issue #1064 extension (slice 5) — errorMonitor:getError, mirroring
// missions:get (slice 3, PR #1077) and messages:getById (PR #1076).
//
// `getError` takes `v.id("errorLogs")`. A well-formed ID from another table
// passes the MCP boundary regex (#1065) and dies one layer down, where
// Convex redacts the validator's message in prod. Relax to `v.string()`,
// narrow via `requireId`, throwing a structured `ConvexError` naming the
// offending argument.

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

// `ConvexError.data` is a JSON string under convex-test and the thrown object
// in prod — both measured. Accept both.
const decodePayload = (caught: unknown): WrongTablePayload => {
	const raw = (caught as ConvexError<string | WrongTablePayload>).data;
	return typeof raw === "string" ? (JSON.parse(raw) as WrongTablePayload) : raw;
};

const newErrorLog = (t: ReturnType<typeof createT>) =>
	t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert("errorLogs", {
			hash: "probe-hash",
			deployment: "prod",
			functionName: "probe:fn",
			errorMessage: "boom",
			firstSeen: now,
			lastSeen: now,
			count: 1,
		});
	});

const newTask = (t: ReturnType<typeof createT>) =>
	t.mutation(api.tasks.create, {
		title: "Probe task",
		assignedTo: "sigma",
		priority: "low",
		status: "todo",
		createdBy: "sigma",
	});

describe("errorMonitor:getError — wrong-table ID (issue #1064, reads)", () => {
	test("a tasks-table ID yields an actionable ConvexError naming errorId", async () => {
		const t = createT();
		const taskId = await newTask(t);

		let caught: unknown;
		try {
			await t.query(api.errorMonitor.getError, {
				errorId: taskId as unknown as Id<"errorLogs">,
			});
			throw new Error("getError did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.path).toBe("errorId");
		expect(payload?.expectedTable).toBe("errorLogs");
		expect(payload?.receivedId).toBe(taskId);
		expect(payload?.message).toContain("errorId");
		expect(payload?.message).toContain("errorLogs");
		// Literal hint string (not the imported constant) — a mutant that empties
		// the hint at the call-site must redden this.
		expect(payload?.message).toBe(
			"errorId is not a valid errorLogs ID. Use the full 32-char errorId returned by list_errors.",
		);
		expect(payload?.message).not.toBe(
			"errorId is not a valid errorLogs ID.",
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
			await t.query(api.errorMonitor.getError, {
				errorId: missionId as unknown as Id<"errorLogs">,
			});
			throw new Error("getError did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.expectedTable).toBe("errorLogs");
		expect(payload?.receivedId).toBe(missionId);
	});

	test("positive control: a real errorId still returns the document", async () => {
		const t = createT();
		const errorId = await newErrorLog(t);
		const doc = await t.query(api.errorMonitor.getError, { errorId });
		expect(doc?._id).toBe(errorId);
		expect(doc?.errorMessage).toBe("boom");
	});

	test("contract preserved: a valid errorLogs ID that no longer exists returns null, does NOT throw", async () => {
		const t = createT();
		const errorId = await newErrorLog(t);
		await t.run(async (ctx) => {
			await ctx.db.delete(errorId);
		});

		// A well-formed ID of the RIGHT table pointing at a deleted doc must stay
		// a `null` return, not an error. Widening the validator must not turn a
		// benign miss into a throw.
		await expect(
			t.query(api.errorMonitor.getError, { errorId }),
		).resolves.toBeNull();
	});
});
