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
import { UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT } from "../lib/inboxReader";
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

	test("master marks a legacy receipt that carries no tenantId (it is the fleet's), naming its owner", async () => {
		const t = createT();
		await seedMappings(t);
		const { receiptId } = await seedRow(t, undefined);
		const n = await asMaster(t).mutation(api.messages.markAsRead, {
			receiptIds: [receiptId],
			callerOrchestrator: "seat-x",
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

	// Task k17c5q842gm1gbh0j2qjtc80g18fx5kb: the service account asserting a bare
	// NAME is not a licence over every org's namesake. It marks the FLEET's
	// receipts; a client org's receipt is marked through the org's VERIFIED
	// identity, and the service account naming no owner at all is refused.
	test("master marks a client tenant's receipt only through the verified org, never by a bare name", async () => {
		const t = createT();
		await seedMappings(t);
		const { receiptId } = await seedRow(t, "org-b");
		// CONTRACT poles (inboxReader.ts UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT),
		// armed when the flag is flipped after the claim-sending MCP is live.
		if (!UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT) {
			await expect(
				asMaster(t).mutation(api.messages.markAsRead, {
					receiptIds: [receiptId],
					callerOrchestrator: "seat-x",
				}),
			).rejects.toThrow(/RBAC_DENIED.*messages:markAsRead/);
			await expect(
				asMaster(t).mutation(api.messages.markAsRead, {
					receiptIds: [receiptId],
				}),
			).rejects.toThrow(/RBAC_DENIED.*messages:markAsRead/);
		}
		const n = await asMaster(t).mutation(api.messages.markAsRead, {
			receiptIds: [receiptId],
			callerOrchestrator: "seat-x",
			verifiedOrg: { orgSlug: "org-b" },
		});
		expect(n).toBe(1);
	});
});

// Contract step (inboxReader.ts UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT
// `false`): the check-messages skill calls mark_as_read with only receiptIds.
// The claimless service account marks the FLEET's receipts (unstamped, or
// stamped with the operator slug) and is refused a client tenant's.
describe("messages:markAsRead — claimless service account, no owner named", () => {
	async function seedOperator(t: T) {
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "op-org",
				allowedOrchestrators: ["seat-x"],
				scopes: ["view-own-tasks"],
				displayName: "operator",
				isActive: true,
				createdAt: Date.now(),
				orgKind: "operator",
			});
		});
	}

	test.skipIf(UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT)(
		"marks the fleet's receipts (unstamped and operator-stamped) and returns the count",
		async () => {
			const t = createT();
			await seedMappings(t);
			await seedOperator(t);
			const unstamped = await seedRow(t, undefined);
			const stamped = await seedRow(t, "op-org");
			const n = await asMaster(t).mutation(api.messages.markAsRead, {
				receiptIds: [unstamped.receiptId, stamped.receiptId],
			});
			expect(n).toBe(2);
			for (const id of [unstamped.receiptId, stamped.receiptId]) {
				expect((await t.run((ctx) => ctx.db.get(id)))?.readAt).toBeDefined();
			}
		},
	);

	test.skipIf(UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT)(
		"is refused a client tenant's receipt, naming the door; the receipt stays unread, the batch is not partly marked",
		async () => {
			const t = createT();
			await seedMappings(t);
			await seedOperator(t);
			const fleet = await seedRow(t, undefined);
			const client = await seedRow(t, "org-b");
			await expect(
				asMaster(t).mutation(api.messages.markAsRead, {
					receiptIds: [client.receiptId],
				}),
			).rejects.toThrow(
				/RBAC_DENIED.*tenant-receipt-needs-verified-reader.*messages:markAsRead/,
			);
			await expect(
				asMaster(t).mutation(api.messages.markAsRead, {
					receiptIds: [fleet.receiptId, client.receiptId],
				}),
			).rejects.toThrow(/RBAC_DENIED.*messages:markAsRead/);
			expect(
				(await t.run((ctx) => ctx.db.get(client.receiptId)))?.readAt,
			).toBeUndefined();
			expect(
				(await t.run((ctx) => ctx.db.get(fleet.receiptId)))?.readAt,
			).toBeUndefined();
		},
	);
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
