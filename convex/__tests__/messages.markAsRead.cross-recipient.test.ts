/// <reference types="vite/client" />
//
// RED-EXPECTED — cross-recipient ownership bypass on markAsRead.
//
// `messages:markAsRead` (convex/messages.ts) validates that each receiptId is
// a well-formed `messageReceipts` document ID (see the sibling wrong-table
// test), but it never checks that the receipt belongs to the caller. Any
// orchestrator that can enumerate or guess a `messageReceipts` ID (e.g. by
// observing it in a shared log, task payload, or MCP transcript) can mark
// another recipient's receipt as read — silently suppressing that
// recipient's "unread" signal on `check_messages` without their involvement.
//
// This test is `.skip`-ed deliberately: it is a reproduction, not a fix. It
// documents the current (vulnerable) behaviour and must be un-skipped only
// once an ownership check is added to `markAsRead` (or the MCP `mark_as_read`
// tool gains a `guardFrom`-style check tying `receiptIds` to the caller's
// declared identity). Flipping `.skip` to a live `test` at that point turns
// this into the regression guard.
//
// To confirm red-ness locally: change `.skip` to nothing and run
//   bunx vitest run convex/__tests__/messages.markAsRead.cross-recipient.test.ts
// — it fails today because `markAsRead` returns 1 (success) instead of
// throwing/rejecting the cross-recipient mutation.

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

const createT = () => convexTest(schema, modules);

describe("markAsRead — cross-recipient ownership (RED, no fix in this pass)", () => {
	test.skip("recipient A cannot mark recipient B's receipt as read", async () => {
		const t = createT();

		// pi sends one message to each of two distinct recipients.
		await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "alpha",
			content: "For alpha's eyes only",
		});
		await t.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "beta",
			content: "For beta's eyes only",
		});

		const alphaReceipts = await t.query(api.messages.checkNewMessages, {
			recipient: "alpha",
		});
		const betaReceipts = await t.query(api.messages.checkNewMessages, {
			recipient: "beta",
		});
		expect(alphaReceipts).toHaveLength(1);
		expect(betaReceipts).toHaveLength(1);

		const alphaReceiptId = alphaReceipts[0].receiptId;

		// beta (attacker) marks alpha's receipt as read. markAsRead has no
		// notion of "caller identity" at all — it accepts bare receiptIds and
		// never compares them against a recipient/caller argument, so there is
		// no ownership check to bypass in the traditional sense: the check
		// simply does not exist. This call should be REJECTED (e.g. a
		// ConvexError naming a permission failure) once a fix lands.
		await expect(
			t.mutation(api.messages.markAsRead, {
				receiptIds: [alphaReceiptId],
			}),
		).rejects.toThrow();

		// Cross-check: alpha's receipt must still be unread after the rejected
		// attempt — today it is NOT (the mutation succeeds and patches
		// readAt), which is exactly the isolation failure this test documents.
		const alphaReceiptsAfter = await t.query(api.messages.checkNewMessages, {
			recipient: "alpha",
		});
		expect(alphaReceiptsAfter).toHaveLength(1);
	});
});
