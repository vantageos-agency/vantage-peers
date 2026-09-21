/// <reference types="vite/client" />
/**
 * messages.markAsRead / messages.deleteMessage — write-scope enforcement.
 *
 * DEFECT (pre-fix, on main): both mutations authorized solely on the
 * client-supplied `callerOrchestrator` STRING ARGUMENT — never a verified
 * identity. An anonymous caller (or a caller authenticated as a DIFFERENT
 * org) could pass any orchestrator name and mark another org's receipts
 * read, or pass "system"/the sender's own name and delete another org's
 * message. This is the class of defect
 * .claude/rules/authority-attached-to-anonymous-object.md describes: a
 * write surface must derive authority from the verified caller
 * (withOrgScope), never trust the client-supplied argument alone.
 *
 * This suite proves both mutations now enforce org scope via withOrgScope +
 * isOrchestratorAllowedForScope, both poles, while keeping the pre-existing
 * callerOrchestrator narrowing check intact.
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

async function seedOrgAMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedOrgBMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-b",
			allowedOrchestrators: ["seat-b"],
			scopes: ["view-own-tasks"],
			displayName: "org-b",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedMessageAndReceipt(
	t: ReturnType<typeof createT>,
	from: string,
	recipient: string,
) {
	return await t.run(async (ctx) => {
		const messageId = await ctx.db.insert("messages", {
			from,
			channel: recipient,
			content: "test content",
			createdAt: Date.now(),
		});
		const receiptId = await ctx.db.insert("messageReceipts", {
			messageId,
			recipient,
			readAt: undefined,
		});
		return { messageId, receiptId };
	});
}

describe("messages.markAsRead — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const { receiptId } = await seedMessageAndReceipt(t, "seat-b", "seat-a");

		await expect(
			t.mutation(api.messages.markAsRead, { receiptIds: [receiptId] }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("org-a trying to mark org-b's receipt as read is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const { receiptId } = await seedMessageAndReceipt(t, "seat-x", "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.messages.markAsRead, { receiptIds: [receiptId] }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("org-a marking its own receipt as read succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const { receiptId } = await seedMessageAndReceipt(t, "seat-x", "seat-a");
		const tA = asOrgA(t);

		const count = await tA.mutation(api.messages.markAsRead, {
			receiptIds: [receiptId],
		});
		expect(count).toBe(1);

		const receipt = await t.run(async (ctx) => await ctx.db.get(receiptId));
		expect(receipt?.readAt).toBeDefined();
	});

	test("the master/service-account identity marks any receipt as read", async () => {
		const t = createT();
		const { receiptId } = await seedMessageAndReceipt(t, "seat-x", "seat-b");
		const tMaster = asMaster(t);

		const count = await tMaster.mutation(api.messages.markAsRead, {
			receiptIds: [receiptId],
		});
		expect(count).toBe(1);
	});

	// Named attack M1: the scope check is skipped when
	// callerOrchestrator == receipt.recipient — i.e. a caller could bypass
	// isOrchestratorAllowedForScope by simply asserting the SAME value it is
	// trying to read as callerOrchestrator. The prior test never exercised
	// this because it omitted callerOrchestrator entirely. Passing
	// callerOrchestrator: "seat-b" (matching the receipt's own recipient) is
	// the exact shape that mutant would let through.
	test("org-a trying to mark org-b's receipt as read is refused even when callerOrchestrator matches the receipt's own recipient", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const { receiptId } = await seedMessageAndReceipt(t, "seat-x", "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.messages.markAsRead, {
				receiptIds: [receiptId],
				callerOrchestrator: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const receipt = await t.run(async (ctx) => await ctx.db.get(receiptId));
		expect(receipt?.readAt).toBeUndefined();
	});

	// Named attack M2: the scope check runs on the first receipt only. A
	// batch call that mixes a receipt the caller legitimately owns with one
	// it does not still needs to (a) throw RBAC_DENIED and (b) roll back the
	// legitimate receipt too — a per-item check that only fires on index 0
	// would let the own receipt patch through before the illegitimate one is
	// ever inspected.
	test("org-a marking [own receipt, seat-b's receipt] in one call is refused, and org-a's own receipt is not marked read either", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const { receiptId: ownReceiptId } = await seedMessageAndReceipt(
			t,
			"seat-x",
			"seat-a",
		);
		const { receiptId: foreignReceiptId } = await seedMessageAndReceipt(
			t,
			"seat-x",
			"seat-b",
		);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.messages.markAsRead, {
				receiptIds: [ownReceiptId, foreignReceiptId],
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const ownReceipt = await t.run(
			async (ctx) => await ctx.db.get(ownReceiptId),
		);
		expect(ownReceipt?.readAt).toBeUndefined();

		const foreignReceipt = await t.run(
			async (ctx) => await ctx.db.get(foreignReceiptId),
		);
		expect(foreignReceipt?.readAt).toBeUndefined();
	});
});

describe("messages.deleteMessage — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const { messageId } = await seedMessageAndReceipt(t, "seat-b", "seat-a");

		await expect(
			t.mutation(api.messages.deleteMessage, {
				messageId,
				callerOrchestrator: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("org-a trying to delete org-b's message is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const { messageId } = await seedMessageAndReceipt(t, "seat-b", "seat-x");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.messages.deleteMessage, {
				messageId,
				callerOrchestrator: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("org-a trying to delete org-b's message via the 'system' narrowing bypass is still refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const { messageId } = await seedMessageAndReceipt(t, "seat-b", "seat-x");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.messages.deleteMessage, {
				messageId,
				callerOrchestrator: "system",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("org-a deleting its own (sender seat-a) message succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const { messageId } = await seedMessageAndReceipt(t, "seat-a", "seat-x");
		const tA = asOrgA(t);

		const result = await tA.mutation(api.messages.deleteMessage, {
			messageId,
			callerOrchestrator: "seat-a",
		});
		expect(result.deleted).toBe(true);
	});

	test("the master/service-account identity deletes any message", async () => {
		const t = createT();
		const { messageId } = await seedMessageAndReceipt(t, "seat-b", "seat-x");
		const tMaster = asMaster(t);

		const result = await tMaster.mutation(api.messages.deleteMessage, {
			messageId,
			callerOrchestrator: "system",
		});
		expect(result.deleted).toBe(true);
	});

	// Reviewer's optional point: withOrgScope(ctx) must resolve BEFORE
	// ctx.db.get(args.messageId) — otherwise an anonymous caller can use
	// messageId existence ("Message not found" vs. a later RBAC error) as an
	// oracle to enumerate valid ids without ever authenticating. Deleting a
	// message that was never seeded proves the id lookup never ran ahead of
	// the scope check: RBAC_DENIED must fire first, not "Message not found".
	test("an anonymous deleteMessage on a non-existent message id is refused with RBAC_DENIED, not 'Message not found'", async () => {
		const t = createT();
		// Well-formed but non-existent messageId — created then deleted, so the
		// id passes v.id("messages")'s format check but no row backs it.
		const { messageId: nonExistentMessageId } = await seedMessageAndReceipt(
			t,
			"seat-b",
			"seat-a",
		);
		await t.run(async (ctx) => {
			await ctx.db.delete(nonExistentMessageId);
		});

		await expect(
			t.mutation(api.messages.deleteMessage, {
				messageId: nonExistentMessageId,
				callerOrchestrator: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});
