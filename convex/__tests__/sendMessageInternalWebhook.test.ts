/// <reference types="vite/client" />
//
// Task: sigma/tenant-scope-write-symmetry (T2/T3 — webhook rewire).
//
// DEFECT: public `sendMessage` (fixed in this task's T1) derives tenant from
// `withOrgScope(ctx)` and REFUSES an anonymous (non-master, no-org) caller.
// That refusal is correct for client callers, but convex/http.ts's
// GitHub-webhook `httpAction` is authed by GITHUB_WEBHOOK_SECRET (HMAC) and
// has NO Clerk identity in production — its 7 `ctx.runMutation(api.messages
// .sendMessage, ...)` call sites now hit the anonymous-refuse and RBAC_DENY
// real fleet notifications.
//
// FIX: `internal.messages.sendMessageInternal` — an internalMutation that
// resolves scope via `withOrgScope(ctx, { allowNoIdentityMaster: true })`
// (the TRUE-internal-master carve-out), mirroring `internal.tasks
// .createForWebhook`. http.ts's 7 sites now call this instead of the public
// `api.messages.sendMessage`.
//
// TWO POLES pinned here:
//   POLE A — the webhook path (no identity) still delivers via
//     sendMessageInternal, while the SAME no-identity call to the PUBLIC
//     sendMessage still refuses (proving the public refusal stands, only the
//     internal path bypasses it).
//   POLE B — sendMessageInternal is NOT reachable from the public api
//     surface (internalMutation registers only under `internal.*`).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
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
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId,
			name: orchestratorId,
			static: { role: orchestratorId, workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
}

async function receiptsFor(t: ReturnType<typeof createT>, messageId: string) {
	const receipts = await t.run((ctx) =>
		ctx.db.query("messageReceipts").collect(),
	);
	return receipts.filter((r) => r.messageId === messageId);
}

describe("sendMessageInternal — HMAC-webhook-only bypass", () => {
	test("POLE A: no-identity call to sendMessageInternal SUCCEEDS and writes message + receipt", async () => {
		const t = createT();
		await seedProfile(t, "eta");
		await seedProfile(t, "pi");

		// No withIdentity() at all — simulates the HMAC-authed GitHub webhook,
		// which has no Clerk identity for ctx.auth.getUserIdentity() to resolve.
		const messageId = await t.mutation(internal.messages.sendMessageInternal, {
			from: "system",
			channel: "eta",
			content: "[GitHub] webhook notification, no Clerk identity",
		});

		expect(messageId).toBeDefined();
		const receipts = await receiptsFor(t, messageId);
		expect(receipts.length).toBe(1);
		expect(receipts[0].recipient).toBe("eta");
		// Master carve-out (allowNoIdentityMaster): tenantId writes args.tenantId
		// verbatim (undefined here) — matches the TRUE-master branch of
		// sendMessageCore, mirroring createForWebhook's null-tenant fleet rows.
		expect(receipts[0].tenantId).toBeUndefined();
	});

	test("POLE A contrast: the SAME no-identity call to the PUBLIC sendMessage still REFUSES", async () => {
		const t = createT();
		await seedProfile(t, "eta");

		await expect(
			t.mutation(api.messages.sendMessage, {
				from: "system",
				channel: "eta",
				content: "anonymous public-surface attempt",
			}),
		).rejects.toThrow();
	});

	test("POLE B: sendMessageInternal is absent from the public api surface, present on internal", async () => {
		const apiMessages = api.messages as Record<string, unknown>;
		expect(Object.prototype.hasOwnProperty.call(apiMessages, "sendMessageInternal")).toBe(
			false,
		);
		expect(typeof apiMessages.sendMessage).not.toBe("undefined");

		const internalMessages = internal.messages as Record<string, unknown>;
		expect(typeof internalMessages.sendMessageInternal).not.toBe("undefined");
	});
});
