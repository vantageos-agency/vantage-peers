/// <reference types="vite/client" />
//
// R-11 fix (task k171ev3awqn4n2r9hfhbv2n1jx8df4tt) — tenant isolation for the
// instance-targeted branch of checkNewMessages / checkNewMessagesEnvelope must
// be an in-query index predicate (by_tenant_instance_unread /
// by_tenant_recipient_unread), not only a post-query .filter. Bipolar per
// function: ALLOW (caller sees only its own tenant's rows) and DENY (caller
// never sees another tenant's rows), for the recipientInstanceId branch that
// backend-doctor flagged at messages.ts:313 and messages.ts:455.

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

async function seedReceipt(
	t: ReturnType<typeof createT>,
	opts: {
		recipient: "pi" | "tau" | "phi";
		recipientInstanceId: string;
		tenantId: string;
		content: string;
	},
) {
	await t.run(async (ctx) => {
		const messageId = await ctx.db.insert("messages", {
			from: "alpha",
			channel: opts.recipientInstanceId,
			content: opts.content,
			tenantId: opts.tenantId,
			createdAt: Date.now(),
		});
		await ctx.db.insert("messageReceipts", {
			messageId,
			recipient: opts.recipient,
			recipientInstanceId: opts.recipientInstanceId,
			tenantId: opts.tenantId,
			readAt: undefined,
		});
	});
}

describe("checkNewMessages — instance branch tenant isolation (R-11)", () => {
	test("ALLOW: tenant-a caller sees its own instance-targeted message", async () => {
		const t = createT();
		await seedReceipt(t, {
			recipient: "pi",
			recipientInstanceId: "pi-vps",
			tenantId: "tenant-a",
			content: "tenant-a instance msg",
		});

		const results = await t
			.withIdentity({
				subject: "test-service-account-user-id",
			} as Parameters<typeof t.withIdentity>[0])
			.query(api.messages.checkNewMessages, {
			recipient: "pi",
			recipientInstanceId: "pi-vps",
			tenantId: "tenant-a",
		});

		expect(results.length).toBe(1);
		expect(results[0].content).toBe("tenant-a instance msg");
	});

	test("DENY: tenant-a caller never sees tenant-b's instance-targeted message", async () => {
		const t = createT();
		await seedReceipt(t, {
			recipient: "pi",
			recipientInstanceId: "pi-vps",
			tenantId: "tenant-a",
			content: "tenant-a instance msg",
		});
		await seedReceipt(t, {
			recipient: "pi",
			recipientInstanceId: "pi-vps",
			tenantId: "tenant-b",
			content: "tenant-b instance msg",
		});

		const results = await t
			.withIdentity({
				subject: "test-service-account-user-id",
			} as Parameters<typeof t.withIdentity>[0])
			.query(api.messages.checkNewMessages, {
			recipient: "pi",
			recipientInstanceId: "pi-vps",
			tenantId: "tenant-a",
		});

		expect(results.length).toBe(1);
		expect(results.every((r) => r.content !== "tenant-b instance msg")).toBe(
			true,
		);
	});
});

describe("checkNewMessagesEnvelope — instance branch tenant isolation (R-11)", () => {
	test("ALLOW: tenant-a caller sees its own instance-targeted message", async () => {
		const t = createT();
		await seedReceipt(t, {
			recipient: "pi",
			recipientInstanceId: "pi-vps",
			tenantId: "tenant-a",
			content: "tenant-a instance msg",
		});

		const result = await t
			.withIdentity({
				subject: "test-service-account-user-id",
			} as Parameters<typeof t.withIdentity>[0])
			.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "pi",
			recipientInstanceId: "pi-vps",
			tenantId: "tenant-a",
		});

		expect(result.messages.length).toBe(1);
		expect(result.messages[0].content).toBe("tenant-a instance msg");
	});

	test("DENY: tenant-a caller never sees tenant-b's instance-targeted message", async () => {
		const t = createT();
		await seedReceipt(t, {
			recipient: "pi",
			recipientInstanceId: "pi-vps",
			tenantId: "tenant-a",
			content: "tenant-a instance msg",
		});
		await seedReceipt(t, {
			recipient: "pi",
			recipientInstanceId: "pi-vps",
			tenantId: "tenant-b",
			content: "tenant-b instance msg",
		});

		const result = await t
			.withIdentity({
				subject: "test-service-account-user-id",
			} as Parameters<typeof t.withIdentity>[0])
			.query(api.messages.checkNewMessagesEnvelope, {
			recipient: "pi",
			recipientInstanceId: "pi-vps",
			tenantId: "tenant-a",
		});

		expect(result.messages.length).toBe(1);
		expect(
			result.messages.every((m) => m.content !== "tenant-b instance msg"),
		).toBe(true);
	});
});
