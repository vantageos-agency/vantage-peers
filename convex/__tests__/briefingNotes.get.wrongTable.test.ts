/// <reference types="vite/client" />
//
// Issue #1064 extension — briefingNotes:get, mirroring tasks:getById (PR #1072).
//
// `briefingNotes:get` takes `v.id("briefingNotes")`. A well-formed ID from
// another table passes the MCP boundary regex (#1065) and dies one layer
// down, where Convex redacts the validator's message in prod. The caller
// sees `[Request ID: …] Server Error` with `error.data` undefined — nothing
// to act on.
//
// Same contract as PR #1069 (`markAsRead`) and #1072 (`tasks.getById`): the
// `v.id()` validator runs BEFORE the handler, so there is no seam to
// intercept while it is in place. Relax to `v.string()`, then
// `ctx.db.normalizeId` per argument, throwing a structured `ConvexError`
// naming the offending argument.

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

function createT(): ReturnType<typeof convexTest> {
	return convexTest(schema, modules).withIdentity({
		subject: "test-service-account-user-id",
	}) as unknown as ReturnType<typeof convexTest>;
}

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

const newNote = (t: ReturnType<typeof createT>) =>
	t.mutation(api.briefingNotes.create, {
		title: "Probe note",
		topic: "daily",
		participants: ["sigma"],
		content: "probe",
		createdBy: "sigma",
	});

const newTask = (t: ReturnType<typeof createT>) =>
	t.mutation(api.tasks.create, {
		title: "Probe task",
		assignedTo: "sigma",
		priority: "low",
		status: "todo",
		createdBy: "sigma",
	});

describe("briefingNotes:get — wrong-table ID (issue #1064, reads)", () => {
	test("a messages-table ID yields an actionable ConvexError naming noteId", async () => {
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
			await t.query(api.briefingNotes.get, {
				noteId: messageId as unknown as Id<"briefingNotes">,
			});
			throw new Error("get did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.path).toBe("noteId");
		expect(payload?.expectedTable).toBe("briefingNotes");
		expect(payload?.receivedId).toBe(messageId);
		expect(payload?.message).toContain("noteId");
		expect(payload?.message).toContain("briefingNotes");
		// Literal hint string (not the imported constant) — a mutant that empties
		// the hint at the call-site must redden this.
		expect(payload?.message).toBe(
			"noteId is not a valid briefingNotes ID. Use the full 32-char noteId returned by list_briefing_notes or create_briefing_note.",
		);
		expect(payload?.message).not.toBe(
			"noteId is not a valid briefingNotes ID.",
		);
	});

	test("negative control: an ID from a THIRD table is also named, with its own value", async () => {
		const t = createT();
		const taskId = await newTask(t);

		let caught: unknown;
		try {
			await t.query(api.briefingNotes.get, {
				noteId: taskId as unknown as Id<"briefingNotes">,
			});
			throw new Error("get did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.expectedTable).toBe("briefingNotes");
		expect(payload?.receivedId).toBe(taskId);
	});

	test("positive control: a real noteId still returns the document", async () => {
		const t = createT();
		const noteId = await newNote(t);
		const doc = await t.query(api.briefingNotes.get, { noteId });
		expect(doc?._id).toBe(noteId);
		expect(doc?.title).toBe("Probe note");
	});

	test("contract preserved: a valid briefingNotes ID that no longer exists returns null, does NOT throw", async () => {
		const t = createT();
		const noteId = await newNote(t);
		await t.run(async (ctx) => {
			await ctx.db.delete(noteId);
		});

		// A well-formed ID of the RIGHT table pointing at a deleted doc must stay
		// a `null` return, not an error. Widening the validator must not turn a
		// benign miss into a throw.
		await expect(t.query(api.briefingNotes.get, { noteId })).resolves.toBeNull();
	});
});
