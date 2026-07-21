/// <reference types="vite/client" />
/**
 * listBroadcastStatus.contract.test.ts — TDD RED-before-GREEN.
 *
 * LIVE DEFECT: mcp-server/src/tools.ts `list_broadcast_status` handler always
 * injects `limit` into the `messages:listBroadcastStatus` Convex call
 * (`limit: limit ?? 20`), even when the caller never passed one. The backend
 * query historically declared only `{ fields, messageId }` — no `limit` — so
 * Convex rejects EVERY call with ArgumentValidationError: "Object contains
 * extra field 'limit'". This reproduces the exact args shape the MCP wrapper
 * sends (mcp-server/src/tools.ts ~line 3450-3457).
 *
 * Fix direction: the backend accepts and APPLIES `limit` to the `receipts`
 * array, with an explicit `truncated` flag so a capped list never renders
 * identically to a complete one.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

async function seedBroadcastWithReceipts(
	t: ReturnType<typeof createT>,
	receiptCount: number,
) {
	return await t.run(async (ctx) => {
		const messageId = await ctx.db.insert("messages", {
			from: "pi",
			channel: "broadcast",
			content: "critical announcement",
			createdAt: 1000,
		});
		const recipients = ["tau", "phi", "sigma", "eta", "beta"];
		for (let i = 0; i < receiptCount; i++) {
			await ctx.db.insert("messageReceipts", {
				messageId,
				recipient: recipients[i % recipients.length] + `-${i}`,
				readAt: i % 2 === 0 ? 2000 + i : undefined,
			});
		}
		return messageId;
	});
}

describe("listBroadcastStatus — MCP wrapper call shape (RED before GREEN)", () => {
	test("calling with the exact args the MCP wrapper sends (messageId, limit, fields) does NOT throw ArgumentValidationError", async () => {
		const t = createT();
		const messageId = await seedBroadcastWithReceipts(t, 3);

		// This is byte-for-byte the args object mcp-server/src/tools.ts builds:
		// { messageId, limit: limit ?? 20, fields: fields ?? "lite" }
		await expect(
			t.query(api.messages.listBroadcastStatus, {
				messageId,
				limit: 20,
				fields: "lite",
			} as any),
		).resolves.toBeTruthy();
	});

	test("calling WITHOUT limit (caller omitted it) still succeeds", async () => {
		const t = createT();
		const messageId = await seedBroadcastWithReceipts(t, 3);

		await expect(
			t.query(api.messages.listBroadcastStatus, {
				messageId,
				fields: "lite",
			} as any),
		).resolves.toBeTruthy();
	});

	test("receipts are actually present in the response for a message that has receipts", async () => {
		const t = createT();
		const messageId = await seedBroadcastWithReceipts(t, 3);

		const result = await t.query(api.messages.listBroadcastStatus, {
			messageId,
			fields: "lite",
		} as any);

		expect(result.receipts.length).toBe(3);
		expect(result.messageId).toBe(messageId);
		expect(result.from).toBe("pi");
	});

	test("limit truncates the receipts array and sets truncated=true", async () => {
		const t = createT();
		const messageId = await seedBroadcastWithReceipts(t, 5);

		const result = await t.query(api.messages.listBroadcastStatus, {
			messageId,
			limit: 2,
			fields: "lite",
		} as any);

		expect(result.receipts.length).toBe(2);
		expect(result.truncated).toBe(true);
	});

	test("no truncation when limit exceeds actual receipt count", async () => {
		const t = createT();
		const messageId = await seedBroadcastWithReceipts(t, 3);

		const result = await t.query(api.messages.listBroadcastStatus, {
			messageId,
			limit: 20,
			fields: "lite",
		} as any);

		expect(result.receipts.length).toBe(3);
		expect(result.truncated).toBe(false);
	});
});
