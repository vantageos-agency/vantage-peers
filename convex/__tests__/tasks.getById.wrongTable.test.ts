/// <reference types="vite/client" />
//
// Issue #1064 extension — the wrong-table class on READS, not just writes.
//
// `tasks:getById` takes `v.id("tasks")`. A 32-char lowercase ID from another
// table passes the MCP boundary regex (#1065) and dies one layer down, where
// Convex redacts the validator's message in prod. The caller sees
// `[Request ID: …] Server Error` with `error.data` undefined — nothing to act on.
//
// This is not hypothetical: on Day 127 Pi cited a well-formed taskId that did
// not decode to `tasks`, `complete_task` answered `Server Error`, and the round
// trip cost a full exchange. A read error that cannot be acted on costs as much
// as a write error.
//
// Same contract as PR #1069 (`markAsRead`): the `v.id()` validator runs BEFORE
// the handler, so there is no seam to intercept while it is in place. Relax to
// `v.string()`, then `ctx.db.normalizeId` per argument, throwing a structured
// `ConvexError` naming the offending argument.

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

// Literal copy of the hint passed by `tasks:getById` to `requireId`. Deliberately
// NOT imported from the source: an imported constant follows the mutant, and the
// assertion would prove nothing. If this string and the call-site drift apart, the
// test must fail — that is the point.
const HINT = "Use the full 32-char taskId returned by list_tasks or create_task.";

type WrongTablePayload = {
	path?: string;
	expectedTable?: string;
	receivedId?: string;
	message?: string;
};

// `ConvexError.data` is a JSON string under convex-test and the thrown object in
// prod — both measured (see messages.markAsRead.wrongTable.test.ts). Accept both.
const decodePayload = (caught: unknown): WrongTablePayload => {
	const raw = (caught as ConvexError<string | WrongTablePayload>).data;
	return typeof raw === "string" ? (JSON.parse(raw) as WrongTablePayload) : raw;
};

const newTask = (t: ReturnType<typeof createT>) =>
	t.mutation(api.tasks.create, {
		title: "Probe task",
		assignedTo: "sigma",
		priority: "low",
		status: "todo",
		createdBy: "sigma",
	});

describe("tasks:getById — wrong-table ID (issue #1064, reads)", () => {
	test("a messages-table ID yields an actionable ConvexError naming taskId", async () => {
		const t = createT();
		await t.run((ctx) =>
			ctx.db.insert("profiles", {
				orchestratorId: "sigma",
				name: "sigma",
				static: { role: "sigma", workspace: "test", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 1 },
			}),
		);
		const messageId = await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "sigma",
			content: "probe",
		});

		let caught: unknown;
		try {
			await t.query(api.tasks.getById, {
				taskId: messageId as unknown as Id<"tasks">,
			});
			throw new Error("getById did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.path).toBe("taskId");
		expect(payload?.expectedTable).toBe("tasks");
		expect(payload?.receivedId).toBe(messageId);
		expect(payload?.message).toContain("taskId");
		expect(payload?.message).toContain("tasks");
		// The hint is the ONLY sentence that tells the caller what to do, and it is
		// the last one — so a `toContain("taskId")` assertion is already satisfied by
		// the prefix `taskId is not a valid tasks ID.` and cannot see the hint vanish.
		// Eta's finding on #1072: dropping the hint left 4/4 green. Asserted here as a
		// LITERAL, not against an imported constant — a constant would move with the
		// mutant and the assertion would be tautological.
		expect(payload?.message).toContain(HINT);
		// And the message must be strictly richer than the bare label.
		expect(payload?.message).not.toBe("taskId is not a valid tasks ID.");
	});

	test("negative control: an ID from a THIRD table is also named, with its own value", async () => {
		const t = createT();
		const noteId = await t.mutation(api.briefingNotes.create, {
			topic: "daily",
			title: "Probe note",
			participants: ["sigma"],
			content: "probe",
			createdBy: "sigma",
		});

		let caught: unknown;
		try {
			await t.query(api.tasks.getById, {
				taskId: noteId as unknown as Id<"tasks">,
			});
			throw new Error("getById did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.expectedTable).toBe("tasks");
		expect(payload?.receivedId).toBe(noteId);
	});

	test("positive control: a real taskId still returns the document", async () => {
		const t = createT();
		const taskId = await newTask(t);
		const doc = await t.query(api.tasks.getById, { taskId });
		expect(doc?._id).toBe(taskId);
		expect(doc?.title).toBe("Probe task");
	});

	test("contract preserved: a valid tasks ID that no longer exists returns null, does NOT throw", async () => {
		const t = createT();
		const taskId = await newTask(t);
		await t.run(async (ctx) => {
			await ctx.db.delete(taskId);
		});

		// A well-formed ID of the RIGHT table pointing at a deleted doc must stay
		// a `null` return, not an error. Widening the validator must not turn a
		// benign miss into a throw.
		await expect(t.query(api.tasks.getById, { taskId })).resolves.toBeNull();
	});
});
