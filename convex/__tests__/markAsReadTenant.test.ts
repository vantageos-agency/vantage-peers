/// <reference types="vite/client" />
/**
 * messages:markAsRead / messages:deleteMessage — the row's TENANT must be the
 * caller's org.
 *
 * DEFECT (pre-fix): both authorized the caller against the orchestrator ROSTER
 * only (`allowedOrchestrators.includes(recipient | from)`), a string
 * membership, not a tenant boundary. A member of org-a whose roster names
 * "seat-x" could mark read / delete another org's receipts and messages for a
 * same-named "seat-x". A receipt or message carrying no tenantId grants
 * nothing to an org-scoped caller.
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
type T = ReturnType<typeof createT>;

const asOrgA = (t: T) =>
	t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
const asMaster = (t: T) =>
	t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);

// Both orgs name the SAME orchestrator "seat-x" on their roster.
async function seedMappings(t: T) {
	await t.run(async (ctx) => {
		for (const org of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				allowedOrchestrators: ["seat-x"],
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

async function seedRow(t: T, tenantId: string | undefined) {
	return await t.run(async (ctx) => {
		const messageId = await ctx.db.insert("messages", {
			from: "seat-x",
			tenantId,
			channel: "seat-x",
			content: "c",
			createdAt: Date.now(),
		});
		const receiptId = await ctx.db.insert("messageReceipts", {
			messageId,
			recipient: "seat-x",
			tenantId,
			readAt: undefined,
		});
		return { messageId, receiptId };
	});
}

describe("messages:markAsRead — receipt tenant", () => {
	test("a member cannot mark another org's receipt for a same-named orchestrator", async () => {
		const t = createT();
		await seedMappings(t);
		const { receiptId } = await seedRow(t, "org-b");
		await expect(
			asOrgA(t).mutation(api.messages.markAsRead, { receiptIds: [receiptId] }),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await t.run((ctx) => ctx.db.get(receiptId));
		expect(row?.readAt).toBeUndefined();
	});

	test("a receipt with no tenantId is not markable by an org member", async () => {
		const t = createT();
		await seedMappings(t);
		const { receiptId } = await seedRow(t, undefined);
		await expect(
			asOrgA(t).mutation(api.messages.markAsRead, { receiptIds: [receiptId] }),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await t.run((ctx) => ctx.db.get(receiptId));
		expect(row?.readAt).toBeUndefined();
	});

	test("an unstamped receipt is refused with the receipt-tenant-mismatch reason", async () => {
		const t = createT();
		await seedMappings(t);
		const { receiptId } = await seedRow(t, undefined);
		await expect(
			asOrgA(t).mutation(api.messages.markAsRead, { receiptIds: [receiptId] }),
		).rejects.toThrow(/receipt-tenant-mismatch/);
		const row = await t.run((ctx) => ctx.db.get(receiptId));
		expect(row?.readAt).toBeUndefined();
	});

	test("master marks a legacy receipt that carries no tenantId", async () => {
		const t = createT();
		await seedMappings(t);
		const { receiptId } = await seedRow(t, undefined);
		const n = await asMaster(t).mutation(api.messages.markAsRead, {
			receiptIds: [receiptId],
		});
		expect(n).toBe(1);
		const row = await t.run((ctx) => ctx.db.get(receiptId));
		expect(row?.readAt).toBeDefined();
	});

	test("a batch mixing own and foreign receipts is refused whole, nothing marked", async () => {
		const t = createT();
		await seedMappings(t);
		const own = await seedRow(t, "org-a");
		const foreign = await seedRow(t, "org-b");
		await expect(
			asOrgA(t).mutation(api.messages.markAsRead, {
				receiptIds: [own.receiptId, foreign.receiptId],
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		const row = await t.run((ctx) => ctx.db.get(own.receiptId));
		expect(row?.readAt).toBeUndefined();
	});

	test("positive: a member marks its own tenant's receipt", async () => {
		const t = createT();
		await seedMappings(t);
		const { receiptId } = await seedRow(t, "org-a");
		const n = await asOrgA(t).mutation(api.messages.markAsRead, {
			receiptIds: [receiptId],
		});
		expect(n).toBe(1);
		const row = await t.run((ctx) => ctx.db.get(receiptId));
		expect(row?.readAt).toBeDefined();
	});

	test("master marks any tenant's receipt", async () => {
		const t = createT();
		await seedMappings(t);
		const { receiptId } = await seedRow(t, "org-b");
		const n = await asMaster(t).mutation(api.messages.markAsRead, {
			receiptIds: [receiptId],
		});
		expect(n).toBe(1);
	});
});

describe("messages:deleteMessage — message tenant (sibling receipt mutation)", () => {
	test("a member cannot delete another org's message (and its receipts) for a same-named sender", async () => {
		const t = createT();
		await seedMappings(t);
		const { messageId, receiptId } = await seedRow(t, "org-b");
		await expect(
			asOrgA(t).mutation(api.messages.deleteMessage, {
				messageId,
				callerOrchestrator: "seat-x",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
		expect(await t.run((ctx) => ctx.db.get(messageId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.get(receiptId))).not.toBeNull();
	});

	test("an unstamped message is refused with the message-tenant-mismatch reason and its receipt survives", async () => {
		const t = createT();
		await seedMappings(t);
		const { messageId, receiptId } = await seedRow(t, undefined);
		await expect(
			asOrgA(t).mutation(api.messages.deleteMessage, {
				messageId,
				callerOrchestrator: "seat-x",
			}),
		).rejects.toThrow(/message-tenant-mismatch/);
		expect(await t.run((ctx) => ctx.db.get(messageId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.get(receiptId))).not.toBeNull();
	});

	test("positive: a member deletes its own tenant's message", async () => {
		const t = createT();
		await seedMappings(t);
		const { messageId } = await seedRow(t, "org-a");
		const r = await asOrgA(t).mutation(api.messages.deleteMessage, {
			messageId,
			callerOrchestrator: "seat-x",
		});
		expect(r.deleted).toBe(true);
	});
});
