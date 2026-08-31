/// <reference types="vite/client" />
//
// Mission fix-broadcast-org-scoped-v1, task T1 — cross-tenant broadcast leak.
//
// DEFECT (T0 audit, analysis/broadcast-org-scope-audit-t0-day157.md):
// sendMessage's broadcast branch (convex/messages.ts:60-66) collects every
// row in `profiles` with no tenant filter, so a client-scoped emitter's
// broadcast reaches every OTHER client tenant's orchestrators AND the
// internal fleet — and an internal/master emitter's broadcast reaches every
// client tenant's orchestrators too.
//
// FIX: bound the broadcast recipient set to the emitter's own tenant, derived
// from withOrgScope(ctx) (never the client-supplied args.tenantId):
//   - client-scoped emitter -> recipients restricted to its own org's
//     allowedOrchestrators (client_org_mapping.allowedOrchestrators).
//   - master/internal emitter -> recipients restricted to orchestrators NOT
//     bound to any active client org (i.e. all profiles minus the union of
//     every active client_org_mapping row's allowedOrchestrators).
//
// Tenant->orchestrator mapping source: convex/schema.ts client_org_mapping
// table (allowedOrchestrators field), the same table withOrgScope already
// resolves from (convex/lib/auth.ts:166-183). No schema migration.

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

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	clerkOrgSlug: string,
	allowedOrchestrators: string[],
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators,
			scopes: ["view-own-tasks", "view-own-missions"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function recipientsOf(
	t: ReturnType<typeof createT>,
	messageId: string,
) {
	const receipts = await t.run((ctx) =>
		ctx.db.query("messageReceipts").collect(),
	);
	return receipts
		.filter((r) => r.messageId === messageId)
		.map((r) => r.recipient);
}

describe("sendMessage broadcast — org-scoped fan-out (cross-tenant leak fix)", () => {
	test("client-scoped emitter: tenant-A broadcast reaches tenant-A peer, NOT tenant-B orchestrator", async () => {
		const t = createT();
		await seedOrgMapping(t, "tenant-a", ["victor", "noe"]);
		await seedOrgMapping(t, "tenant-b", ["marie"]);
		await seedProfile(t, "victor");
		await seedProfile(t, "noe");
		await seedProfile(t, "marie");

		const tA = t.withIdentity({
			subject: "user-tenant-a",
			organizationId: "tenant-a",
		} as Parameters<typeof t.withIdentity>[0]);

		const messageId = await tA.mutation(api.messages.sendMessage, {
			from: "victor",
			channel: "broadcast",
			content: "tenant-a broadcast",
		});

		const recipients = await recipientsOf(t, messageId);

		expect(recipients).toContain("noe");
		expect(recipients).not.toContain("marie");
	});

	test("internal/master emitter: broadcast reaches internal peer, NOT a client-bound orchestrator", async () => {
		const t = createT();
		await seedOrgMapping(t, "tenant-a", ["victor"]);
		await seedOrgMapping(t, "tenant-b", ["marie"]);
		await seedProfile(t, "pi");
		await seedProfile(t, "eta");
		await seedProfile(t, "victor");
		await seedProfile(t, "marie");

		// Service-account identity — the MCP server's real internal-fleet
		// identity, resolving to master via the CLERK_SERVICE_ACCOUNT_USER_ID
		// carve-out (convex/lib/auth.ts:111-121). vitest.config.ts sets
		// CLERK_SERVICE_ACCOUNT_USER_ID="test-service-account-user-id".
		// Broadcast is resolved FAIL-CLOSED (withOrgScope(ctx), no
		// allowNoIdentityMaster) — only a recognized identity resolves to
		// master, never mere absence of identity.
		const tInternal = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);

		const messageId = await tInternal.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "broadcast",
			content: "internal broadcast",
		});

		const recipients = await recipientsOf(t, messageId);

		expect(recipients).toContain("eta");
		expect(recipients).not.toContain("victor");
		expect(recipients).not.toContain("marie");
	});

	test("ANONYMOUS emitter (no identity): broadcast is fail-closed — bounces, never reaches the internal fleet", async () => {
		const t = createT();
		await seedProfile(t, "pi");
		await seedProfile(t, "eta");

		// No withIdentity() at all — anonymous caller. withOrgScope(ctx) with
		// no allowNoIdentityMaster resolves isMaster=false,
		// allowedOrchestrators=[], so the client branch yields zero
		// recipients for "pi" and the existing zero-recipient bounce fires.
		// This must NOT resolve to master and must NOT reach "eta".
		await expect(
			t.mutation(api.messages.sendMessage, {
				from: "pi",
				channel: "broadcast",
				content: "anonymous broadcast attempt",
			}),
		).rejects.toThrow();

		const receipts = await t.run((ctx) =>
			ctx.db.query("messageReceipts").collect(),
		);
		expect(receipts).toHaveLength(0);
	});

	// ── convex-reviewer CRITICAL follow-up: scope.isMaster is overloaded ──
	// (true internal service-account/Laurent vs a CLIENT org whose
	// client_org_mapping row carries the ["*"] read sentinel). The fleet-
	// wide master branch must be gated on isMaster AND orgSlug===null.

	test("CRITICAL: client-org emitter with allowedOrchestrators=['*'] does NOT reach the internal fleet", async () => {
		const t = createT();
		// tenant-wild is a CLIENT org misconfigured with the ["*"] read
		// sentinel — withOrgScope resolves isMaster=true (lib/auth.ts:182)
		// but orgSlug="tenant-wild" (set, non-null). This must NOT be
		// treated as the true internal master.
		await seedOrgMapping(t, "tenant-wild", ["*"]);
		await seedProfile(t, "pi");
		await seedProfile(t, "eta");
		await seedProfile(t, "sigma");
		await seedProfile(t, "victor");

		const tWild = t.withIdentity({
			subject: "user-tenant-wild",
			organizationId: "tenant-wild",
		} as Parameters<typeof t.withIdentity>[0]);

		let caught: unknown;
		let messageId: string | undefined;
		try {
			messageId = await tWild.mutation(api.messages.sendMessage, {
				from: "victor",
				channel: "broadcast",
				content: "wildcard client broadcast attempt",
			});
		} catch (e) {
			caught = e;
		}

		if (messageId !== undefined) {
			// Should never get here post-fix — the send must bounce
			// (zero real recipients, "*" never matches a real
			// orchestratorId). If it DID succeed, assert no leak anyway.
			const recipients = await recipientsOf(t, messageId);
			expect(recipients).not.toContain("pi");
			expect(recipients).not.toContain("eta");
			expect(recipients).not.toContain("sigma");
		} else {
			expect(caught).toBeDefined();
		}

		// Belt-and-suspenders: whatever the outcome, no receipt for any
		// internal orchestrator was ever written.
		const receipts = await t.run((ctx) =>
			ctx.db.query("messageReceipts").collect(),
		);
		const internalLeak = receipts.filter((r) =>
			["pi", "eta", "sigma"].includes(r.recipient),
		);
		expect(internalLeak).toHaveLength(0);
	});

	test("shared orchestrator in two active tenants: receives tenant-A broadcast, not tenant-B's disjoint recipient", async () => {
		const t = createT();
		// "shared" is listed in BOTH tenant-a and tenant-b.
		await seedOrgMapping(t, "tenant-a", ["victor", "shared"]);
		await seedOrgMapping(t, "tenant-b", ["marie", "shared"]);
		await seedProfile(t, "victor");
		await seedProfile(t, "marie");
		await seedProfile(t, "shared");

		const tA = t.withIdentity({
			subject: "user-tenant-a",
			organizationId: "tenant-a",
		} as Parameters<typeof t.withIdentity>[0]);

		const messageIdA = await tA.mutation(api.messages.sendMessage, {
			from: "victor",
			channel: "broadcast",
			content: "tenant-a broadcast",
		});
		const recipientsA = await recipientsOf(t, messageIdA);
		expect(recipientsA).toContain("shared");
		expect(recipientsA).not.toContain("marie");

		const tB = t.withIdentity({
			subject: "user-tenant-b",
			organizationId: "tenant-b",
		} as Parameters<typeof t.withIdentity>[0]);

		const messageIdB = await tB.mutation(api.messages.sendMessage, {
			from: "marie",
			channel: "broadcast",
			content: "tenant-b broadcast",
		});
		const recipientsB = await recipientsOf(t, messageIdB);
		expect(recipientsB).toContain("shared");
		expect(recipientsB).not.toContain("victor");
	});

	test("INACTIVE client mapping: its orchestrator stays excluded from an internal master broadcast (not re-absorbed into the fleet)", async () => {
		const t = createT();
		// tenant-disabled is INACTIVE. Its orchestrator ("disabled-org-bot")
		// still identifies as client-bound — an inactive row does not mean
		// "this orchestratorId is internal again". The exclusion set
		// considers ALL client_org_mapping rows (active or inactive),
		// deliberately, to avoid a disabled client's orchestrator silently
		// rejoining the internal broadcast pool.
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "tenant-disabled",
				allowedOrchestrators: ["disabled-org-bot"],
				scopes: ["view-own-tasks"],
				displayName: "tenant-disabled",
				isActive: false,
				createdAt: Date.now(),
			});
		});
		await seedProfile(t, "pi");
		await seedProfile(t, "eta");
		await seedProfile(t, "disabled-org-bot");

		const tInternal = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);

		const messageId = await tInternal.mutation(api.messages.sendMessage, {
			from: "pi",
			channel: "broadcast",
			content: "internal broadcast with an inactive client on record",
		});

		const recipients = await recipientsOf(t, messageId);
		expect(recipients).toContain("eta");
		expect(recipients).not.toContain("disabled-org-bot");
	});

	// ── Regression: must not break DMs / intra-tenant multi-recipient / bounce ──

	test("regression: DM to a specific role still delivers (internal caller)", async () => {
		const t = createT();
		await seedProfile(t, "pi");

		// Internal caller (title says so): authenticate as the service-account
		// master identity (tenant-scope-write-symmetry closed the silent
		// no-identity path — a real internal caller is never anonymous).
		const tInternal = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);

		const messageId = await tInternal.mutation(api.messages.sendMessage, {
			from: "eta",
			channel: "pi",
			content: "hello pi",
		});

		const recipients = await recipientsOf(t, messageId);
		expect(recipients).toEqual(["pi"]);
	});

	test("regression: intra-tenant comma-list multi-recipient still delivers", async () => {
		const t = createT();
		await seedOrgMapping(t, "tenant-a", ["victor", "noe"]);
		await seedProfile(t, "victor");
		await seedProfile(t, "noe");

		const tA = t.withIdentity({
			subject: "user-tenant-a",
			organizationId: "tenant-a",
		} as Parameters<typeof t.withIdentity>[0]);

		const messageId = await tA.mutation(api.messages.sendMessage, {
			from: "victor",
			channel: "noe",
			content: "hello noe",
		});

		const recipients = await recipientsOf(t, messageId);
		expect(recipients).toEqual(["noe"]);
	});

	test("regression: zero-recipient bounce contract still holds", async () => {
		const t = createT();

		await expect(
			t.mutation(api.messages.sendMessage, {
				from: "pi",
				channel: "role-inexistant-xyz",
				content: "hello",
			}),
		).rejects.toThrow();
	});
});
