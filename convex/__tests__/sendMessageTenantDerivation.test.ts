/// <reference types="vite/client" />
//
// Task: tenant-scope-write-symmetry.
//
// DEFECT: sendMessage stamps `tenantId: args.tenantId` (client-supplied,
// untrusted) into both the `messages` insert and every `messageReceipts`
// insert (convex/messages.ts). Meanwhile the scoped READS (listMessages,
// listByChannel, searchMessagesByKeyword) force `.eq("tenantId",
// scope.orgSlug)` for non-master callers. The write TRUSTS the caller and
// ACCEPTS ABSENCE; the read DEMANDS EQUALITY. Two consequences:
//   (a) a non-master send with no tenantId -> null-tenant row -> invisible
//       to that org's own scoped read (RED 1).
//   (b) a non-master send supplying a FOREIGN tenantId is accepted verbatim
//       -> a cross-tenant write spoof (RED 2).
//
// FIX: derive the stamped tenantId from the caller's own `withOrgScope(ctx)`
// scope (already resolved at the top of sendMessage), mirroring the read
// paths' equality filter, instead of trusting `args.tenantId`:
//   - TRUE internal master (isMaster && orgSlug===null): unchanged carve-out,
//     writes args.tenantId verbatim (declared at the site).
//   - Any real client org (orgSlug !== null, including the ["*"] sentinel):
//     derived = scope.orgSlug — args.tenantId is no longer trusted.
//   - Anonymous / no-identity non-master (orgSlug===null, isMaster===false):
//     refused loudly with a ConvexError (RED 3).
//
// Identity claim key for a non-master scope: `organizationId` (see
// convex/lib/auth.ts:126-131 — slug-first-id-fallback precedence; camelCase
// `organizationId` resolves the mapping, matching the existing pattern in
// convex/__tests__/broadcast-org-scoped.test.ts).

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

function identityFor(
	t: ReturnType<typeof createT>,
	subject: string,
	organizationId: string,
) {
	return t.withIdentity({
		subject,
		organizationId,
	} as Parameters<typeof t.withIdentity>[0]);
}

async function receiptsFor(t: ReturnType<typeof createT>, messageId: string) {
	const receipts = await t.run((ctx) =>
		ctx.db.query("messageReceipts").collect(),
	);
	return receipts.filter((r) => r.messageId === messageId);
}

describe("sendMessage — tenant-scope write symmetry", () => {
	test("POSITIVE CONTROL: correctly-scoped acme send is read back under acme scope (proves an empty result elsewhere is denial, not a broken fixture)", async () => {
		const t = createT();
		await seedOrgMapping(t, "acme", ["victor", "noe"]);
		await seedProfile(t, "victor");
		await seedProfile(t, "noe");

		const sender = identityFor(t, "user-acme-victor", "acme");
		await sender.mutation(api.messages.sendMessage, {
			from: "victor",
			channel: "noe",
			content: "positive control acme message",
			tenantId: "acme",
		});

		const reader = identityFor(t, "user-acme-reader", "acme");
		const rows = await reader.query(api.messages.listMessages, {});
		expect(rows.some((r) => r.content === "positive control acme message")).toBe(
			true,
		);
	});

	test("RED 1: non-master acme send with NO tenantId arg — after fix, tenant is derived and the row IS visible under acme scope", async () => {
		const t = createT();
		await seedOrgMapping(t, "acme", ["victor", "noe"]);
		await seedProfile(t, "victor");
		await seedProfile(t, "noe");

		const sender = identityFor(t, "user-acme-victor", "acme");
		await sender.mutation(api.messages.sendMessage, {
			from: "victor",
			channel: "noe",
			content: "no tenantId supplied",
			// tenantId intentionally omitted — the defect: pre-fix this writes
			// a null-tenant row, invisible to the acme scoped read below.
		});

		const reader = identityFor(t, "user-acme-reader", "acme");
		const rows = await reader.query(api.messages.listMessages, {});
		expect(rows.some((r) => r.content === "no tenantId supplied")).toBe(true);
	});

	test("RED 2: non-master acme send SUPPLYING a foreign tenantId — after fix, the stamped tenant is derived (acme), not the spoofed foreign value", async () => {
		const t = createT();
		await seedOrgMapping(t, "acme", ["victor", "noe"]);
		await seedOrgMapping(t, "project/foreign", ["marie"]);
		await seedProfile(t, "victor");
		await seedProfile(t, "noe");
		await seedProfile(t, "marie");

		const sender = identityFor(t, "user-acme-victor", "acme");
		const messageId = await sender.mutation(api.messages.sendMessage, {
			from: "victor",
			channel: "noe",
			content: "spoofed foreign tenant attempt",
			tenantId: "project/foreign",
		});

		// The stored receipt's tenantId must be the DERIVED acme tenant, never
		// the client-supplied foreign value.
		const receipts = await receiptsFor(t, messageId);
		expect(receipts.length).toBeGreaterThan(0);
		for (const r of receipts) {
			expect(r.tenantId).toBe("acme");
			expect(r.tenantId).not.toBe("project/foreign");
		}

		const acmeReader = identityFor(t, "user-acme-reader", "acme");
		const acmeRows = await acmeReader.query(api.messages.listMessages, {});
		expect(
			acmeRows.some((r) => r.content === "spoofed foreign tenant attempt"),
		).toBe(true);

		const foreignReader = identityFor(
			t,
			"user-foreign-reader",
			"project/foreign",
		);
		const foreignRows = await foreignReader.query(api.messages.listMessages, {});
		expect(
			foreignRows.some((r) => r.content === "spoofed foreign tenant attempt"),
		).toBe(false);
	});

	test("RED 3: anonymous caller (no identity) sending to a known role — after fix, refused with a ConvexError naming the missing tenant", async () => {
		const t = createT();
		await seedProfile(t, "pi");

		// No withIdentity() at all — anonymous. withOrgScope(ctx) with no
		// allowNoIdentityMaster resolves isMaster=false, orgSlug=null. Pre-fix,
		// this silently writes a null-tenant receipt (no refusal). Post-fix, it
		// must throw — "an absent tenant is an event, never a rest".
		await expect(
			t.mutation(api.messages.sendMessage, {
				from: "eta",
				channel: "pi",
				content: "anonymous DM attempt",
			}),
		).rejects.toThrow();
	});

	test("MUST-PASS 1: TRUE master (service-account) send still succeeds — carve-out intact", async () => {
		const t = createT();
		await seedProfile(t, "pi");

		// Service-account identity — resolves to master via the
		// CLERK_SERVICE_ACCOUNT_USER_ID carve-out (convex/lib/auth.ts:111-121).
		// vitest.config.ts sets CLERK_SERVICE_ACCOUNT_USER_ID to this subject.
		const tInternal = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);

		const messageId = await tInternal.mutation(api.messages.sendMessage, {
			from: "eta",
			channel: "pi",
			content: "internal master DM, no tenantId",
		});

		expect(messageId).toBeDefined();
		const receipts = await receiptsFor(t, messageId);
		expect(receipts.length).toBe(1);
		// Carve-out: master path writes args.tenantId verbatim (undefined here).
		expect(receipts[0].tenantId).toBeUndefined();
	});

	test("MUST-PASS 2: correctly-scoped non-master send still succeeds after the fix (positive control, restated)", async () => {
		const t = createT();
		await seedOrgMapping(t, "acme", ["victor", "noe"]);
		await seedProfile(t, "victor");
		await seedProfile(t, "noe");

		const sender = identityFor(t, "user-acme-victor", "acme");
		const messageId = await sender.mutation(api.messages.sendMessage, {
			from: "victor",
			channel: "noe",
			content: "must-pass-2 acme message",
			tenantId: "acme",
		});

		expect(messageId).toBeDefined();
		const receipts = await receiptsFor(t, messageId);
		expect(receipts.length).toBe(1);
		expect(receipts[0].tenantId).toBe("acme");
	});
});
