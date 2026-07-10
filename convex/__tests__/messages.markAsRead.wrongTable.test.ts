/// <reference types="vite/client" />
//
// Issue #1064 — markAsRead receives a well-formed 32-char ID from the WRONG
// table (a messages._id instead of a messageReceipts._id). In prod, Convex
// redacts non-ConvexError messages before they reach the client, so the
// v.id() validator's rejection text never survives the wire. The client sees
// only "[Request ID: ...] Server Error" — nothing actionable.
//
// The fix must throw an explicit ConvexError (whose .data payload survives
// redaction) naming the exact array position, the expected table, and the
// check_messages provenance hint. This test asserts on payload CONTENT, not
// merely "it throws" — convex/tests.test.ts:757 already asserts throw-only,
// and that is precisely its insufficiency (see brief issue #1064).

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
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

// `ConvexError.data` has TWO shapes, and which one you get depends on the
// runtime — both measured, neither assumed:
//
//   • under `convex-test` (this suite, CI) → a JSON **string**
//   • against prod `compassionate-goldfinch-737` via `ConvexHttpClient`
//     → the **object** that was thrown
//
// Getting this wrong is easy: typing the generic as an object compiles fine and
// still yields `undefined` on every field under convex-test. Sigma and Eta each
// probed exactly one runtime and concluded the opposite of one another (PR #1069
// review, finding F1) — each right about the surface they measured, each wrong to
// generalise. `mcpConvexError` (mcp-server/src/tools.ts) tolerates both; so does
// this decoder. Both branches are exercised by the tests below — the object
// branch has no live caller in this suite, so nothing but a test can cover it.
const decodePayload = (caught: unknown): WrongTablePayload => {
	const raw = (caught as ConvexError<string | WrongTablePayload>).data;
	return typeof raw === "string" ? (JSON.parse(raw) as WrongTablePayload) : raw;
};

// The prod payload, captured verbatim from a real `ConvexHttpClient` call
// against `compassionate-goldfinch-737` after the #1069 deploy (2600380).
const PROD_PAYLOAD: WrongTablePayload = {
	expectedTable: "messageReceipts",
	message:
		"receiptIds[0] is not a valid messageReceipts ID. Use the receiptId returned by check_messages, not a messageId.",
	path: "receiptIds[0]",
	receivedId: "jn7d01yxmwes20jxaxwd95x5qx8a9qcj",
};

describe("decodePayload — both runtime shapes of ConvexError.data", () => {
	test("string branch: convex-test hands back a JSON string", () => {
		const caught = new ConvexError(JSON.stringify(PROD_PAYLOAD));
		expect(typeof caught.data).toBe("string");
		expect(decodePayload(caught)).toEqual(PROD_PAYLOAD);
	});

	test("object branch: prod hands back the thrown object", () => {
		const caught = new ConvexError(PROD_PAYLOAD);
		expect(typeof caught.data).toBe("object");
		// No JSON.parse must happen here — parsing an object throws.
		expect(decodePayload(caught)).toEqual(PROD_PAYLOAD);
	});
});

describe("markAsRead — wrong-table ID (issue #1064)", () => {
	test("rejects a messages-table ID at position [1] with an actionable ConvexError payload", async () => {
		const t = createT();

		// Real messageReceipts._id at position [0] — must NOT be the thing that
		// triggers the rejection; the bad element is at [1].
		const goodMessageId = await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "tau",
			content: "Good receipt provider",
		});
		const goodReceipts = await t.query(api.messages.checkNewMessages, {
			recipient: "tau",
		});
		expect(goodReceipts).toHaveLength(1);
		const goodReceiptId = goodReceipts[0].receiptId;

		// A real document in `messages` (wrong table) — its _id is well-formed
		// but belongs to `messages`, not `messageReceipts`.
		const wrongTableId = await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "tau",
			content: "This id belongs to the messages table",
		});

		let caught: unknown;
		try {
			await t.mutation(api.messages.markAsRead, {
				receiptIds: [
					goodReceiptId,
					wrongTableId as unknown as Id<"messageReceipts">,
				] as unknown as Id<"messageReceipts">[],
			});
			throw new Error("markAsRead did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);

		expect(payload).toBeTruthy();
		// Assert each field on its own. A stringified-payload `toContain` cannot
		// tell WHICH field carries the index, so a mutant that hardcodes
		// `path: "receiptIds[0]"` survives while `message` still interpolates the
		// real index. Both fields must independently name position 1.
		expect(payload?.path).toBe("receiptIds[1]");
		expect(payload?.expectedTable).toBe("messageReceipts");
		expect(payload?.message).toContain("receiptIds[1]");
		expect(payload?.receivedId).toBe(wrongTableId);
		expect(payload?.message?.toLowerCase()).toContain("check_messages");
		void goodMessageId;
	});

	test("positive control: a real messageReceipts id passes and returns the expected count", async () => {
		const t = createT();

		await t.mutation(api.messages.sendMessage, {
			from: "tau",
			channel: "pi",
			content: "Read me",
		});
		const receipts = await t.query(api.messages.checkNewMessages, {
			recipient: "pi",
		});
		expect(receipts).toHaveLength(1);

		const count = await t.mutation(api.messages.markAsRead, {
			receiptIds: [receipts[0].receiptId],
		});
		expect(count).toBe(1);
	});

	test("negative control: an id from a THIRD table (tasks) at position [0] is rejected with receiptIds[0]", async () => {
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
			await t.mutation(api.messages.markAsRead, {
				receiptIds: [taskId as unknown as Id<"messageReceipts">],
			});
			throw new Error("markAsRead did not throw — expected a ConvexError");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const payload = decodePayload(caught);
		expect(payload?.path).toBe("receiptIds[0]");
		expect(payload?.expectedTable).toBe("messageReceipts");
		expect(payload?.receivedId).toBe(taskId);
		expect(payload?.message).toContain("receiptIds[0]");
	});
});
