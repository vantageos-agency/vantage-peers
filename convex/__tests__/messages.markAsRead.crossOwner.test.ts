/// <reference types="vite/client" />
//
// k179nrp3apj700pm0h1ckewm2h8b3nz7 — mark_as_read cross-owner bypass.
//
// Before the fix: markAsRead accepted any caller-supplied receiptIds and
// patched readAt with NO ownership check — neither MCP-side (mcp-server
// tools.ts had no guard on mark_as_read) nor Convex-side (this handler
// validated the ID FORMAT only, never the `recipient` field). Any caller
// could mark another orchestrator's mail read.
//
// This test proves the Convex-side half of the fix: when callerOrchestrator
// is supplied, a receipt belonging to a DIFFERENT recipient is denied with
// RBAC_DENIED, and the receipt's readAt is left untouched.

import { ConvexError } from "convex/values";
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

describe("markAsRead — cross-owner bypass (k179nrp3apj700pm0h1ckewm2h8b3nz7)", () => {
	test("rejects marking a receipt read when callerOrchestrator is not the recipient", async () => {
		const t = createT();
		await t.run((ctx) =>
			ctx.db.insert("profiles", {
				orchestratorId: "tau",
				name: "tau",
				static: { role: "tau", workspace: "test", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 1 },
			}),
		);

		// Setup send: this test exercises markAsRead's ownership check, not
		// sendMessage's own auth — authenticate as the service-account master
		// identity (tenant-scope-write-symmetry closed the silent
		// no-identity path).
		await t
			.withIdentity({
				subject: "test-service-account-user-id",
			} as Parameters<typeof t.withIdentity>[0])
			.mutation(api.messages.sendMessage, {
				from: "pi",
				channel: "tau",
				content: "Private to tau",
			});
		const receipts = await t
			.withIdentity({
				subject: "test-service-account-user-id",
			} as Parameters<typeof t.withIdentity>[0])
			.query(api.messages.checkNewMessages, {
				recipient: "tau",
			});
		expect(receipts).toHaveLength(1);
		const receiptId = receipts[0].receiptId;

		let caught: unknown;
		try {
			await t.mutation(api.messages.markAsRead, {
				receiptIds: [receiptId],
				callerOrchestrator: "phi",
			});
			throw new Error("markAsRead did not throw — expected RBAC_DENIED");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const err = caught as ConvexError<string>;
		expect(String(err.data)).toContain("RBAC_DENIED");

		// The receipt must remain unread — the bypass never mutated state.
		const stillUnread = await t
			.withIdentity({
				subject: "test-service-account-user-id",
			} as Parameters<typeof t.withIdentity>[0])
			.query(api.messages.checkNewMessages, {
				recipient: "tau",
			});
		expect(stillUnread).toHaveLength(1);
	});

	test("positive control: the true recipient can mark its own receipt read", async () => {
		const t = createT();
		await t.run((ctx) =>
			ctx.db.insert("profiles", {
				orchestratorId: "tau",
				name: "tau",
				static: { role: "tau", workspace: "test", capabilities: [] },
				dynamic: { lastSeen: Date.now(), sessionCount: 1 },
			}),
		);

		// Setup send: this test exercises markAsRead's ownership check, not
		// sendMessage's own auth — authenticate as the service-account master
		// identity (tenant-scope-write-symmetry closed the silent
		// no-identity path).
		await t
			.withIdentity({
				subject: "test-service-account-user-id",
			} as Parameters<typeof t.withIdentity>[0])
			.mutation(api.messages.sendMessage, {
				from: "pi",
				channel: "tau",
				content: "Owned by tau",
			});
		const receipts = await t
			.withIdentity({
				subject: "test-service-account-user-id",
			} as Parameters<typeof t.withIdentity>[0])
			.query(api.messages.checkNewMessages, {
				recipient: "tau",
			});
		expect(receipts).toHaveLength(1);

		const count = await t.mutation(api.messages.markAsRead, {
			receiptIds: [receipts[0].receiptId],
			callerOrchestrator: "tau",
		});
		expect(count).toBe(1);
	});
});
