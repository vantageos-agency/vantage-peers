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
// against internally, which convex-test does not meter. There is no
// environment-only lever that reproduces the production 32,000-document
// ceiling here.
//
// SECOND VERSION — PR #1287, Eta refusal:
// https://github.com/vantageos-agency/vantage-peers/pull/1287#issuecomment-5670085757
// The first version of this test parsed `messages.ts` as raw text and
// required the literal substring `.eq("readAt", undefined)` inside each
// `.withIndex(...)` call. Eta correctly refused to gate on it: the check
// only bites on that EXACT string shape — a same-file `const` holding the
// index name, a helper function building the range bound, or a second
// receipt read added to a different file, would all sail through
// unnoticed. The only "bite proof" offered mutated the one string the test
// matched, proving nothing about shapes not chosen by the test's own
// author.
//
// THIS VERSION uses a real TypeScript AST (see
// `./lib/unreadIndexScan.ts` for the full design writeup, including the
// NAMED GAPS this scan does not close) to:
//   - derive the required field list for every "*_unread" index from
//     schema.ts itself (not re-typed here), so the assertion tracks the
//     schema instead of a second hand-maintained copy of it;
//   - resolve the index-name argument through a same-file `const` alias,
//     not only a string literal (closes MUST_BLOCK (a));
//   - resolve the range-builder argument through a same-file helper
//     function call, not only an inline arrow (closes MUST_BLOCK (b));
//   - scan EVERY non-generated, non-test `.ts` file under convex/, not
//     only messages.ts (closes MUST_BLOCK (c));
//   - require ALL of the index's fields to be bound, not just `readAt`, so
//     dropping a leading field (e.g. `recipient`) is caught too (closes
//     MUST_BLOCK (d));
//   - FAIL CLOSED on any withIndex-callback shape it cannot statically
//     resolve, rather than silently passing it.
//
// RED on pre-fix code: the untenanted branches' `.withIndex(...)` callback
// binds only `recipient` (or only `recipientInstanceId`) — no `.eq("readAt"`
// inside the withIndex call.
// GREEN on fixed code: every by_recipient_unread / by_instance_unread /
// by_tenant_recipient_unread / by_tenant_instance_unread withIndex call
// (anywhere under convex/) binds every field the index declares.

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { scanUnreadIndexBindings } from "./lib/unreadIndexScan";

const CONVEX_DIR = join(__dirname, "..");
const SCHEMA_PATH = join(CONVEX_DIR, "schema.ts");
const MESSAGES_PATH = join(CONVEX_DIR, "messages.ts");

describe("every *_unread index withIndex call, anywhere under convex/, binds the full index field list (readAt included) in its own range-builder chain", () => {
	test("schema.ts declares at least one unread index for messageReceipts (guard against a schema rename making this scan vacuous)", () => {
		const { schemaIndexes } = scanUnreadIndexBindings(CONVEX_DIR, SCHEMA_PATH);
		expect(Object.keys(schemaIndexes).length).toBeGreaterThan(0);
		expect(schemaIndexes.by_recipient_unread).toEqual(["recipient", "readAt"]);
		expect(schemaIndexes.by_instance_unread).toEqual(["recipientInstanceId", "readAt"]);
	});

	test("MUST_REFUSE: messages.ts must be readable and must itself contain resolvable by_recipient_unread / by_instance_unread withIndex calls — never pass vacuously off other files alone", () => {
		const { matches } = scanUnreadIndexBindings(CONVEX_DIR, SCHEMA_PATH);
		const inMessagesTs = matches.filter((m) => m.file === MESSAGES_PATH);
		const recipientCalls = inMessagesTs.filter((m) => m.indexName === "by_recipient_unread");
		const instanceCalls = inMessagesTs.filter((m) => m.indexName === "by_instance_unread");
		expect(
			recipientCalls.length,
			`expected at least one resolvable by_recipient_unread withIndex call in ${MESSAGES_PATH} — found ${recipientCalls.length}. Either the file is unreadable/renamed, or the known call-sites moved to a shape this scan cannot resolve.`,
		).toBeGreaterThan(0);
		expect(
			instanceCalls.length,
			`expected at least one resolvable by_instance_unread withIndex call in ${MESSAGES_PATH} — found ${instanceCalls.length}. Either the file is unreadable/renamed, or the known call-sites moved to a shape this scan cannot resolve.`,
		).toBeGreaterThan(0);
	});

	test("no unread-index withIndex call anywhere under convex/ is missing a required field, and no such call has an unresolved (fail-closed) shape", () => {
		const { matches } = scanUnreadIndexBindings(CONVEX_DIR, SCHEMA_PATH);
		expect(matches.length).toBeGreaterThan(0);

		const violations = matches.filter((m) => !m.resolved || m.missingFields.length > 0);
		if (violations.length > 0) {
			const detail = violations
				.map(
					(v) =>
						`${v.file}:${v.line} index="${v.indexName}" resolved=${v.resolved} missingFields=[${v.missingFields.join(", ")}]${v.reason ? ` reason="${v.reason}"` : ""}`,
				)
				.join("\n");
			throw new Error(`unread-index withIndex violations:\n${detail}`);
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
