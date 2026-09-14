/// <reference types="vite/client" />
//
// Issue #1285/#1220 — checkNewMessagesEnvelope timed out in production
// ("Scanned too many documents" / "Too many index ranges read") because the
// untenanted branches of the receipts fetch bound only the FIRST field of
// by_recipient_unread / by_instance_unread and pushed `readAt === undefined`
// into a post-index `.filter()` instead of the index range. A recipient with
// a large READ history and only a handful of unread receipts forces the scan
// to walk the recipient's entire receipt history before `.take()` is
// satisfied.
//
// WHY THIS TEST IS STRUCTURAL, NOT A RUNTIME READ-COUNT ASSERTION:
// convex-test's `transactionLimits` (HeadroomTracker) only tracks documents
// on the `1.0/get` and `1.0/queryStreamNext` syscalls
// (convex-test/dist/index.js `asyncSyscallImpl`). `startQuery` computes the
// ENTIRE filtered/sorted/limited result set synchronously in
// `_resolveQuerySource` before any syscall is issued — `queryStreamNext`
// then just shifts already-computed results one at a time. Verified
// empirically: seeding 200 read + 3 unread receipts and setting
// `transactionLimits: { documentsRead: 50 }` does NOT throw on either the
// pre-fix or post-fix code, because in both cases only the 3 final
// (post-filter, post-take) rows are ever passed to a tracked syscall — the
// defect is entirely in how many rows convex evaluates the range/filter
// against internally, which convex-test does not meter. This is exactly the
// "convex-test does not enforce the scanned-documents limit" gap the task
// brief calls out — there is no environment-only lever that reproduces the
// production 32,000-document ceiling here.
//
// So this test asserts the actual fix directly: it parses the compiled
// index-range builder call for every `by_recipient_unread` /
// `by_instance_unread` `.withIndex(...)` call-site in messages.ts and
// requires `readAt` to be bound INSIDE the index range (chained `.eq(...)`
// on the same builder `q`), not left to a later `.filter()`. This is
// "assert via the index-range shape" from the task brief.
//
// RED on pre-fix code: the untenanted branches' `.withIndex(...)` callback
// binds only `recipient` (or only `recipientInstanceId`) — no `.eq("readAt"`
// inside the withIndex call.
// GREEN on fixed code: every by_recipient_unread / by_instance_unread
// withIndex call binds `readAt` in the same chain.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const messagesSource = readFileSync(
	join(__dirname, "..", "messages.ts"),
	"utf8",
);

/**
 * Extracts the full source text of every `.withIndex(indexName, ...)` call
 * in `source`, using paren-depth matching so nested parens inside the
 * callback (e.g. `q.eq(...)`) don't truncate the match early.
 */
function extractWithIndexCalls(source: string, indexName: string): string[] {
	const marker = `.withIndex("${indexName}"`;
	const calls: string[] = [];
	let searchFrom = 0;
	for (;;) {
		const markerStart = source.indexOf(marker, searchFrom);
		if (markerStart === -1) break;
		const openParenIndex = source.indexOf("(", markerStart + ".withIndex".length);
		if (openParenIndex === -1) {
			throw new Error(`Malformed withIndex call at offset ${markerStart}`);
		}
		let depth = 0;
		let i = openParenIndex;
		for (; i < source.length; i++) {
			if (source[i] === "(") depth++;
			else if (source[i] === ")") {
				depth--;
				if (depth === 0) break;
			}
		}
		if (depth !== 0) {
			throw new Error(`Unbalanced parens scanning withIndex call at offset ${markerStart}`);
		}
		calls.push(source.slice(markerStart, i + 1));
		searchFrom = i + 1;
	}
	return calls;
}

describe("by_recipient_unread / by_instance_unread — readAt bound in the index range, not a post-index filter", () => {
	test("every by_recipient_unread withIndex call binds readAt in the same chain", () => {
		const calls = extractWithIndexCalls(messagesSource, "by_recipient_unread");
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call).toContain('.eq("readAt", undefined)');
		}
	});

	test("every by_instance_unread withIndex call binds readAt in the same chain", () => {
		const calls = extractWithIndexCalls(messagesSource, "by_instance_unread");
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call).toContain('.eq("readAt", undefined)');
		}
	});
});

// ---------------------------------------------------------------------------
// Behavioural parity companion (runtime): a recipient with a large read
// history and a few unread receipts still gets exactly the right unread
// receipts back. This does not, by itself, prove the scan is bounded (see
// the header comment) — it guards against a future edit reintroducing a
// correctness bug (e.g. dropping a receipt) while "fixing" performance.
// ---------------------------------------------------------------------------
import { convexTest } from "convex-test";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

test("role-only branch: a recipient with a large read history still gets exactly its unread receipts", async () => {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		for (let i = 0; i < 200; i++) {
			const messageId = await ctx.db.insert("messages", {
				from: "alpha",
				channel: "sigma",
				content: `read msg ${i}`,
				createdAt: Date.now(),
			});
			await ctx.db.insert("messageReceipts", {
				messageId,
				recipient: "sigma",
				readAt: Date.now(),
			});
		}
		for (let i = 0; i < 3; i++) {
			const messageId = await ctx.db.insert("messages", {
				from: "alpha",
				channel: "sigma",
				content: `unread msg ${i}`,
				createdAt: Date.now(),
			});
			await ctx.db.insert("messageReceipts", {
				messageId,
				recipient: "sigma",
				readAt: undefined,
			});
		}
	});

	const result = await t.query(api.messages.checkNewMessagesEnvelope, {
		recipient: "sigma",
	});

	expect(result.messages).toHaveLength(3);
	expect(result.truncated).toBe(false);
	for (const m of result.messages) {
		expect(m.content).toContain("unread");
	}
});
