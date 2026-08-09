/// <reference types="vite/client" />
//
// Task k17dr97dwpe07n9zfgzzypkfm18bv6ws — send_message bounce on empty
// recipients.
//
// DEFECT (T0 audit): sendMessage (convex/messages.ts) resolves a non-broadcast
// channel by splitting the string and inserting a receipt row per token
// WITHOUT checking any membership table. A phantom channel (unknown role,
// non-existent instance, reserved word "direct", empty string, or an unknown
// comma-list part) resolves to zero real recipients yet still returns a
// messageId with no error — a silent send-to-nobody.
//
// TARGET: channel resolves to >=1 REAL recipient (derived from the
// `profiles` table, same source the broadcast branch already uses) -> normal
// delivery. Zero real recipients -> throw an actionable ConvexError, and NO
// receipt rows are written (delivered=0 semantics).

import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

async function seedProfile(
	t: ReturnType<typeof createT>,
	orchestratorId: string,
	instanceId?: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId,
			instanceId,
			name: instanceId ?? orchestratorId,
			static: { role: orchestratorId, workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
}

describe("sendMessage — bounce on empty recipients (phantom channel)", () => {
	test("RED/GREEN: channel = reserved word 'direct' with no matching profile bounces", async () => {
		const t = createT();

		let caught: unknown;
		try {
			await t.mutation(api.messages.sendMessage, {
				from: "pi",
				channel: "direct",
				content: "hello",
			});
			throw new Error("sendMessage did not throw — expected a bounce");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const data = (caught as InstanceType<typeof ConvexError>).data;
		expect(typeof data === "string" ? data : JSON.stringify(data)).toContain(
			"direct",
		);
		expect(
			typeof data === "string" ? data : JSON.stringify(data),
		).toContain("ne correspond à aucun destinataire");

		// No receipt rows were written for the bounced channel.
		const receipts = await t.run((ctx) => ctx.db.query("messageReceipts").collect());
		expect(receipts).toHaveLength(0);
	});

	test("RED/GREEN: channel = unknown role 'role-inexistant-xyz' bounces", async () => {
		const t = createT();

		let caught: unknown;
		try {
			await t.mutation(api.messages.sendMessage, {
				from: "pi",
				channel: "role-inexistant-xyz",
				content: "hello",
			});
			throw new Error("sendMessage did not throw — expected a bounce");
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(ConvexError);
		const data = (caught as InstanceType<typeof ConvexError>).data;
		expect(typeof data === "string" ? data : JSON.stringify(data)).toContain(
			"role-inexistant-xyz",
		);

		const receipts = await t.run((ctx) => ctx.db.query("messageReceipts").collect());
		expect(receipts).toHaveLength(0);
	});

	test("channel = empty string bounces", async () => {
		const t = createT();

		await expect(
			t.mutation(api.messages.sendMessage, {
				from: "pi",
				channel: "",
				content: "hello",
			}),
		).rejects.toThrow(ConvexError);
	});

	test("comma-list with one unknown part bounces the whole send", async () => {
		const t = createT();
		await seedProfile(t, "eta");

		await expect(
			t.mutation(api.messages.sendMessage, {
				from: "pi",
				channel: "eta,talos",
				content: "hello",
			}),
		).rejects.toThrow(ConvexError);

		const receipts = await t.run((ctx) => ctx.db.query("messageReceipts").collect());
		expect(receipts).toHaveLength(0);
	});
});

describe("sendMessage — MUST_DELIVER: legitimate sends stay green", () => {
	test("broadcast delivers to all registered org peers", async () => {
		const t = createT();
		await seedProfile(t, "pi");
		await seedProfile(t, "eta");
		await seedProfile(t, "tau");

		// Broadcast is resolved fail-closed via withOrgScope(ctx) — the
		// service-account identity (MCP server's real internal-fleet
		// identity) resolves to master via the CLERK_SERVICE_ACCOUNT_USER_ID
		// carve-out. vitest.config.ts sets
		// CLERK_SERVICE_ACCOUNT_USER_ID="test-service-account-user-id".
		const messageId = await t
			.withIdentity({ subject: "test-service-account-user-id" } as Parameters<
				typeof t.withIdentity
			>[0])
			.mutation(api.messages.sendMessage, {
				from: "pi",
				channel: "broadcast",
				content: "hello everyone",
			});
		expect(messageId).toBeDefined();

		const receipts = await t.run((ctx) => ctx.db.query("messageReceipts").collect());
		// pi excluded (sender), eta + tau receive
		expect(receipts).toHaveLength(2);
	});

	test("a real registered role delivers", async () => {
		const t = createT();
		await seedProfile(t, "pi");

		const messageId = await t.mutation(api.messages.sendMessage, {
			from: "eta",
			channel: "pi",
			content: "hello pi",
		});
		expect(messageId).toBeDefined();

		const receipts = await t.run((ctx) => ctx.db.query("messageReceipts").collect());
		expect(receipts).toHaveLength(1);
		expect(receipts[0].recipient).toBe("pi");
	});

	test("a real registered instance delivers", async () => {
		const t = createT();
		await seedProfile(t, "pi", "pi-vps");

		const messageId = await t.mutation(api.messages.sendMessage, {
			from: "eta",
			channel: "pi-vps",
			content: "hello pi-vps",
		});
		expect(messageId).toBeDefined();

		const receipts = await t.run((ctx) => ctx.db.query("messageReceipts").collect());
		expect(receipts).toHaveLength(1);
		expect(receipts[0].recipientInstanceId).toBe("pi-vps");
	});

	test("a valid comma-list where each part exists delivers to both", async () => {
		const t = createT();
		await seedProfile(t, "eta");
		await seedProfile(t, "pi");

		const messageId = await t.mutation(api.messages.sendMessage, {
			from: "tau",
			channel: "eta,pi",
			content: "hello both",
		});
		expect(messageId).toBeDefined();

		const receipts = await t.run((ctx) => ctx.db.query("messageReceipts").collect());
		expect(receipts).toHaveLength(2);
	});
});
