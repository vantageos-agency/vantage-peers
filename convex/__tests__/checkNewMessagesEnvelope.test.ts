/// <reference types="vite/client" />
//
// PR #759 — Eta REVISE fix: cursor bug in checkNewMessagesEnvelope.
//
// nextSince MUST be on the receipt._creationTime axis (the same axis the query
// filters with q.gt(q.field("_creationTime"), since)).  The pre-fix code
// returned message.createdAt which is stamped BEFORE the receipt insert, so
// resuming with since=nextSince would re-include the boundary receipt.
//
// Test 3 (cursor round-trip) is the regression test: it FAILS on pre-fix code
// and PASSES after the fix.

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

// ---------------------------------------------------------------------------
// Helper: seed a message from "alpha" to one or more recipients via sendMessage.
// channel is the comma-separated recipient list (as sendMessage expects).
// ---------------------------------------------------------------------------
async function seed(
	t: ReturnType<typeof createT>,
	opts: {
		from?: string;
		channel: string;
		content?: string;
	},
) {
	await t.mutation(api.messages.sendMessage, {
		from: opts.from ?? "alpha",
		channel: opts.channel,
		content: opts.content ?? "hello world",
		sessionDay: 1,
	});
}

// ---------------------------------------------------------------------------
// 1. Default args clamp + return shape
// ---------------------------------------------------------------------------
test("default args clamp + return shape", async () => {
	const t = createT();

	await seed(t, { channel: "sigma-vps" });
	await seed(t, { channel: "sigma-vps" });
	await seed(t, { channel: "sigma-vps" });

	const result = await t.query(api.messages.checkNewMessagesEnvelope, {
		recipient: "sigma",
		recipientInstanceId: "sigma-vps",
	});

	expect(result.messages).toHaveLength(3);
	expect(result.truncated).toBe(false);
	expect(result.nextSince).toBeNull();
	// All receipts are for sigma
	for (const m of result.messages) {
		expect(m.from).toBe("alpha");
		expect(typeof m.receiptId).toBe("string");
		expect(typeof m.messageId).toBe("string");
	}
});

// ---------------------------------------------------------------------------
// 2. Limit truncation triggers truncated flag + nextSince
// ---------------------------------------------------------------------------
test("limit truncation triggers truncated flag and nextSince", async () => {
	const t = createT();

	for (let i = 0; i < 5; i++) {
		await seed(t, { channel: "sigma-vps", content: `msg ${i}` });
	}

	const result = await t.query(api.messages.checkNewMessagesEnvelope, {
		recipient: "sigma",
		recipientInstanceId: "sigma-vps",
		limit: 2,
	});

	expect(result.messages).toHaveLength(2);
	expect(result.truncated).toBe(true);
	expect(typeof result.nextSince).toBe("number");
});

// ---------------------------------------------------------------------------
// 3. Cursor round-trip is dup-free and skip-free (the regression test)
//    This FAILS on pre-fix code (nextSince = message.createdAt instead of
//    receipt._creationTime) and PASSES after the fix.
// ---------------------------------------------------------------------------
test("cursor round-trip is dup-free and skip-free", async () => {
	const t = createT();

	for (let i = 0; i < 4; i++) {
		await seed(t, { channel: "sigma-vps", content: `page msg ${i}` });
	}

	const page1 = await t.query(api.messages.checkNewMessagesEnvelope, {
		recipient: "sigma",
		recipientInstanceId: "sigma-vps",
		limit: 2,
	});

	expect(page1.messages).toHaveLength(2);
	expect(page1.truncated).toBe(true);
	expect(page1.nextSince).not.toBeNull();

	const page2 = await t.query(api.messages.checkNewMessagesEnvelope, {
		recipient: "sigma",
		recipientInstanceId: "sigma-vps",
		limit: 2,
		since: page1.nextSince ?? undefined,
	});

	expect(page2.messages).toHaveLength(2);
	expect(page2.truncated).toBe(false);
	expect(page2.nextSince).toBeNull();

	// No duplicates and no skips across pages
	const allReceiptIds = [
		...page1.messages.map((m) => m.receiptId),
		...page2.messages.map((m) => m.receiptId),
	];
	expect(new Set(allReceiptIds).size).toBe(4);
});

// ---------------------------------------------------------------------------
// 4. Byte budget truncation
// ---------------------------------------------------------------------------
test("byte budget truncation stops at maxBytes", async () => {
	const t = createT();

	const bigContent = "x".repeat(20_000);
	for (let i = 0; i < 3; i++) {
		await seed(t, { channel: "sigma-vps", content: bigContent });
	}

	const result = await t.query(api.messages.checkNewMessagesEnvelope, {
		recipient: "sigma",
		recipientInstanceId: "sigma-vps",
		limit: 5,
		maxBytes: 45_000,
	});

	// First 2 fit (~20 KB each ≈ 40 KB total), 3rd would push past 45 KB
	expect(result.messages).toHaveLength(2);
	expect(result.truncated).toBe(true);
	expect(typeof result.nextSince).toBe("number");
});

// ---------------------------------------------------------------------------
// 5. At-least-one guarantee even if first row alone busts maxBytes
// ---------------------------------------------------------------------------
test("at-least-one guarantee even if first row exceeds maxBytes", async () => {
	const t = createT();

	const hugeContent = "x".repeat(50_000);
	await seed(t, { channel: "sigma-vps", content: hugeContent });
	await seed(t, { channel: "sigma-vps", content: hugeContent });

	const result = await t.query(api.messages.checkNewMessagesEnvelope, {
		recipient: "sigma",
		recipientInstanceId: "sigma-vps",
		limit: 5,
		maxBytes: 30_000,
	});

	// First message included even though it busts the budget (at-least-one rule)
	expect(result.messages).toHaveLength(1);
	expect(result.truncated).toBe(true);
	expect(typeof result.nextSince).toBe("number");
});

// ---------------------------------------------------------------------------
// 6. Instance + role merge dedup
//    Seed one role-level receipt (no recipientInstanceId) and one instance-level
//    receipt.  A call with recipientInstanceId should return BOTH without dup.
// ---------------------------------------------------------------------------
test("instance + role merge dedup returns both without duplicates", async () => {
	const t = createT();

	// Role-level: channel = "sigma" (no dash → recipient="sigma", recipientInstanceId=undefined)
	await seed(t, { channel: "sigma", content: "role message" });

	// Instance-level: channel = "sigma-vps" (has dash → recipient="sigma", recipientInstanceId="sigma-vps")
	await seed(t, { channel: "sigma-vps", content: "instance message" });

	const result = await t.query(api.messages.checkNewMessagesEnvelope, {
		recipient: "sigma",
		recipientInstanceId: "sigma-vps",
	});

	expect(result.messages).toHaveLength(2);
	// Verify no duplicate receipt IDs
	const ids = result.messages.map((m) => m.receiptId);
	expect(new Set(ids).size).toBe(2);
});

// ---------------------------------------------------------------------------
// 7. Scope isolation A != B
// ---------------------------------------------------------------------------
test("scope isolation: sigma query does not return kappa messages", async () => {
	const t = createT();

	await seed(t, { channel: "sigma", content: "sigma msg 1" });
	await seed(t, { channel: "sigma", content: "sigma msg 2" });
	await seed(t, { channel: "kappa", content: "kappa msg 1" });
	await seed(t, { channel: "kappa", content: "kappa msg 2" });

	const result = await t.query(api.messages.checkNewMessagesEnvelope, {
		recipient: "sigma",
	});

	expect(result.messages).toHaveLength(2);
	for (const m of result.messages) {
		expect(m.content).not.toContain("kappa");
	}
});
