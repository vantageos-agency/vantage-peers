/// <reference types="vite/client" />
//
// Issue #1064 slice-2 — the actionable wrong-table id class extended to
// `messages:getById` (mirrors `tasks:getById`, PR #1072).
//
// `messages:getById` takes `v.id("messages")`. A 32-char lowercase ID from
// another table passes the MCP boundary regex (#1065) and dies one layer
// down, where Convex redacts the validator's message in prod. The caller
// sees `[Request ID: …] Server Error` with `error.data` undefined — nothing
// to act on.
//
// Same contract as PR #1069 (`markAsRead`) and #1072 (`tasks:getById`): the
// `v.id()` validator runs BEFORE the handler, so there is no seam to
// intercept while it is in place. Relax to `v.string()`, then narrow via
// `requireId`, throwing a structured `ConvexError` naming the offending
// argument.

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

// Literal copy of the hint passed by `messages:getById` to `requireId`.
// Deliberately NOT imported from the source: an imported constant follows
// the mutant, and the assertion would prove nothing. If this string and the
// call-site drift apart, the test must fail — that is the point.
const HINT =
	"Use the full 32-char messageId returned by list_messages or checkNewMessages.";

type WrongTablePayload = {
	path?: string;
	expectedTable?: string;
	receivedId?: string;
	message?: string;
};

// `ConvexError.data` is a JSON string under convex-test and the thrown object
// in prod — both measured (see messages.markAsRead.wrongTable.test.ts). Accept both.
const decodePayload = (caught: unknown): WrongTablePayload => {
	const raw = (caught as ConvexError<string | WrongTablePayload>).data;
	return typeof raw === "string" ? (JSON.parse(raw) as WrongTablePayload) : raw;
};

describe("messages:getById — wrong-table ID (issue #1064, reads)", () => {
	test("a messageReceipts-table ID yields an actionable ConvexError naming messageId", async () => {
		const t = createT();
		await t.run((ctx) =>
			ctx.db.insert("profiles", {
				orchestratorId: "sigma",
				name: "sigma",
				static: { role: "sigma", workspace: "test", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 1 },
			}),
		);
		await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "sigma",
			content: "probe",
		});
		const receipts = await t.query(api.messages.checkNewMessages, {
			recipient: "sigma",
		});
		expect(receipts).toHaveLength(1);
		const wrongTableId = receipts[0].receiptId;

		let caught: unknown;
		try {
			await t.query(api.messages.getById, {
				messageId: wrongTableId as unknown as Id<"messages">,
			});
			throw new Error("getById did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.path).toBe("messageId");
		expect(payload?.expectedTable).toBe("messages");
		expect(payload?.receivedId).toBe(wrongTableId);
		expect(payload?.message).toContain("messageId");
		expect(payload?.message).toContain("messages");
		// The hint is the ONLY sentence telling the caller what to do — and it
		// is the last one, so a bare `toContain("messageId")` assertion cannot
		// see it vanish. Asserted as a LITERAL, not against an imported
		// constant (a constant would move with the mutant).
		expect(payload?.message).toContain(HINT);
		expect(payload?.message).not.toBe("messageId is not a valid messages ID.");
	});

	test("negative control: an ID from a THIRD table is also named, with its own value", async () => {
		const t = createT();
		const taskId = await t.mutation(api.tasks.create, {
			title: "Unrelated task — wrong-table probe",
			assignedTo: "pi",
			priority: "low",
			status: "todo",
			createdBy: "pi",
		});

		let caught: unknown;
		try {
			await t.query(api.messages.getById, {
				messageId: taskId as unknown as Id<"messages">,
			});
			throw new Error("getById did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.expectedTable).toBe("messages");
		expect(payload?.receivedId).toBe(taskId);
	});

	test("positive control: a real messageId still returns the document", async () => {
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
			content: "hello",
		});
		const doc = await t.query(api.messages.getById, { messageId });
		expect(doc?._id).toBe(messageId);
		expect(doc?.content).toBe("hello");
	});

	test("contract preserved: a valid messages ID that no longer exists returns null, does NOT throw", async () => {
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
			content: "to be deleted",
		});
		await t.run(async (ctx) => {
			await ctx.db.delete(messageId);
		});

		await expect(
			t.query(api.messages.getById, { messageId }),
		).resolves.toBeNull();
	});
});
