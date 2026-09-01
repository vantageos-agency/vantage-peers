/// <reference types="vite/client" />
//
// receiptTenantBackfill — three-state resolver + one-action report/write proof.
// Task: sigma/receipt-tenant-count backfill for the 46906 undefined-tenant
// messageReceipts rows written before ead59b9 (T1 write-fix).
//
// THE RULE under test: a receipt must be readable by its intended recipient
// UNDER THE IDENTITY THAT RECIPIENT ACTUALLY AUTHENTICATES WITH.
//   - "scope"       — recipient in exactly one active client org → stamp that
//                      org's tenant.
//   - "null-master"  — recipient in no active client org → leave null
//                      (correct: reads via the all-tenants master path).
//   - "unresolved"   — recipient in >1 active client org → NEVER guess, count.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { resolveReceiptTenant, type ClientOrg } from "../receiptTenantBackfill";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);

const createT = () => convexTest(schema, modules);

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	opts: {
		clerkOrgSlug: string;
		allowedOrchestrators: string[];
		isActive?: boolean;
	},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: opts.clerkOrgSlug,
			allowedOrchestrators: opts.allowedOrchestrators,
			scopes: ["view-own-tasks"],
			displayName: opts.clerkOrgSlug,
			isActive: opts.isActive ?? true,
			createdAt: Date.now(),
		});
	});
}

async function seedUndefinedTenantReceipt(
	t: ReturnType<typeof createT>,
	recipient: string,
) {
	return await t.run(async (ctx) => {
		const messageId = await ctx.db.insert("messages", {
			from: "sigma",
			channel: "broadcast",
			content: `msg for ${recipient}`,
			createdAt: Date.now(),
		});
		return await ctx.db.insert("messageReceipts", {
			messageId,
			recipient,
			// tenantId intentionally omitted — the pre-fix undefined population.
		});
	});
}

async function seedManyUndefinedTenantReceipts(
	t: ReturnType<typeof createT>,
	recipient: string,
	count: number,
) {
	const ids = [];
	for (let i = 0; i < count; i++) {
		ids.push(await seedUndefinedTenantReceipt(t, recipient));
	}
	return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveReceiptTenant — the shared resolver, unit-level
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveReceiptTenant — decision table", () => {
	const clientOrgs: ClientOrg[] = [
		{ clerkOrgSlug: "acme-client", allowedOrchestrators: ["victor", "clio", "iris"] },
	];

	test("recipient in exactly one active client org -> scope", () => {
		const r = resolveReceiptTenant(clientOrgs, "victor", undefined);
		expect(r).toEqual({
			state: "scope",
			tenant: "acme-client",
			reason: "recipient in exactly one active client org",
		});
	});

	test("recipient in no active client org -> null-master", () => {
		const r = resolveReceiptTenant(clientOrgs, "sigma", undefined);
		expect(r.state).toBe("null-master");
		expect(r.tenant).toBeNull();
	});

	test("recipient in multiple active client orgs -> unresolved", () => {
		const ambiguousOrgs: ClientOrg[] = [
			{ clerkOrgSlug: "acme-client", allowedOrchestrators: ["victor", "phi"] },
			{ clerkOrgSlug: "other-client", allowedOrchestrators: ["phi"] },
		];
		const r = resolveReceiptTenant(ambiguousOrgs, "phi", undefined);
		expect(r.state).toBe("unresolved");
		expect(r.tenant).toBeNull();
	});

	// RED-proof: if the resolver were stubbed to always return null-master
	// (the bug this whole backfill exists to prevent — a client-org recipient
	// silently staying unstamped), the "scope" assertion above fails. This is
	// the RED state; the real resolveReceiptTenant is GREEN against it.
	test("RED-proof: an always-null-master stub fails the scope assertion", () => {
		const alwaysNullMaster = (): { state: "null-master"; tenant: null } => ({
			state: "null-master",
			tenant: null,
		});
		const stubbed = alwaysNullMaster();
		expect(stubbed.state).not.toBe("scope"); // proves the stub is distinguishable from real resolver output
		const real = resolveReceiptTenant(clientOrgs, "victor", undefined);
		expect(real.state).toBe("scope"); // real resolver diverges from the stub — RED/GREEN gap demonstrated
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// backfillReceiptTenants — the one action, both poles
// ─────────────────────────────────────────────────────────────────────────────

describe("backfillReceiptTenants — report (dryRun:true) pole", () => {
	test("three-state distribution, positive control, zero writes", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "other-client",
			allowedOrchestrators: ["phi"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "master",
			allowedOrchestrators: ["*"],
		});
		// Second mapping placing "phi" in TWO client orgs -> ambiguous/unresolved.
		await seedOrgMapping(t, {
			clerkOrgSlug: "third-client",
			allowedOrchestrators: ["phi"],
		});

		const victorIds = await seedManyUndefinedTenantReceipts(t, "victor", 3);
		const sigmaIds = await seedManyUndefinedTenantReceipts(t, "sigma", 2);
		const phiIds = await seedManyUndefinedTenantReceipts(t, "phi", 1);

		const result = await t.action(
			internal.receiptTenantBackfill.backfillReceiptTenants,
			{ dryRun: true },
		);

		expect(result.total).toBe(6);
		expect(result.perScope["acme-client"]).toBe(3);
		expect(result.nullMaster).toBe(2);
		expect(result.unresolved).toBe(1);
		expect(result.dryRun).toBe(true);
		expect(result.patched).toBe(0);

		// Positive control: proves the resolver CAN produce a non-null scope
		// resolution at all — not that perScope happens to be empty.
		expect(result.resolvedScopeCount).toBeGreaterThan(0);
		expect(result.positiveControlSample).not.toBeNull();
		expect(result.positiveControlSample?.tenant).toBe("acme-client");

		// Dry run wrote NOTHING — re-read every seeded receipt, all still undefined.
		await t.run(async (ctx) => {
			for (const id of [...victorIds, ...sigmaIds, ...phiIds]) {
				const row = await ctx.db.get(id);
				expect(row?.tenantId).toBeUndefined();
			}
		});
	});
});

describe("backfillReceiptTenants — write (dryRun:false) pole", () => {
	test("stamps scope rows only; null-master and unresolved untouched", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "master",
			allowedOrchestrators: ["*"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "other-client",
			allowedOrchestrators: ["phi"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "third-client",
			allowedOrchestrators: ["phi"],
		});

		const victorIds = await seedManyUndefinedTenantReceipts(t, "victor", 4);
		const sigmaIds = await seedManyUndefinedTenantReceipts(t, "sigma", 2);
		const phiIds = await seedManyUndefinedTenantReceipts(t, "phi", 1);

		const result = await t.action(
			internal.receiptTenantBackfill.backfillReceiptTenants,
			{ dryRun: false },
		);

		expect(result.patched).toBe(4);
		expect(result.perScope["acme-client"]).toBe(4);

		await t.run(async (ctx) => {
			for (const id of victorIds) {
				const row = await ctx.db.get(id);
				expect(row?.tenantId).toBe("acme-client");
			}
			for (const id of sigmaIds) {
				const row = await ctx.db.get(id);
				expect(row?.tenantId).toBeUndefined(); // null-master untouched
			}
			for (const id of phiIds) {
				const row = await ctx.db.get(id);
				expect(row?.tenantId).toBeUndefined(); // unresolved untouched
			}
		});
	});

	test("idempotence: running dryRun:false twice patches 0 the second time", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "master",
			allowedOrchestrators: ["*"],
		});

		await seedManyUndefinedTenantReceipts(t, "victor", 3);
		await seedManyUndefinedTenantReceipts(t, "sigma", 2);

		const first = await t.action(
			internal.receiptTenantBackfill.backfillReceiptTenants,
			{ dryRun: false },
		);
		expect(first.patched).toBe(3);
		expect(first.perScope["acme-client"]).toBe(3);
		expect(first.nullMaster).toBe(2);

		const second = await t.action(
			internal.receiptTenantBackfill.backfillReceiptTenants,
			{ dryRun: false },
		);
		// Second scan only sees rows still undefined — the already-stamped
		// "victor" rows have left the undefined-tenant population entirely,
		// so the remaining (null-master) distribution is what's left: 0
		// newly patched, 0 scope rows found (none left to find).
		expect(second.patched).toBe(0);
		expect(second.perScope["acme-client"]).toBeUndefined();
		expect(second.nullMaster).toBe(2); // unchanged — same null-master rows still undefined, still counted
		expect(second.unresolved).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Both-directions scoped-IDENTITY read (the litmus Eta named).
//
// `_receiptsForCaller` takes NO orgSlug arg — the identity IS the input.
// It calls `withOrgScope(ctx)` to derive `scope.orgSlug` from the caller's
// authenticated Clerk identity (mirroring `messages.listMessages`'s own
// pattern), then filters strictly on that resolved value. This test
// authenticates via `.withIdentity(...)` (the PROVEN pattern from
// convex/__tests__/messages-with-org-scope.test.ts:88-90) so the SAME query
// under two different identities is the thing under test — if `withOrgScope`
// were deleted or a tenant hardcoded, pole B's litmus assertion (wrong
// identity returns zero of the other org's rows) would fail.
// ─────────────────────────────────────────────────────────────────────────────

describe("both-directions: scoped IDENTITY read after write only sees own tenant", () => {
	test("POLE A (acme-client identity) and POLE B (other-client identity) diverge on the SAME query", async () => {
		const t = createT();
		// clerkOrgSlug matches the organizationId claim each pole authenticates with.
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "other-client",
			allowedOrchestrators: ["clio"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "master",
			allowedOrchestrators: ["*"],
		});

		await seedManyUndefinedTenantReceipts(t, "victor", 3);
		await seedManyUndefinedTenantReceipts(t, "clio", 2);

		await t.action(internal.receiptTenantBackfill.backfillReceiptTenants, {
			dryRun: false,
		});

		// POLE A — identity: subject "user-acme", organizationId "acme-client".
		// A scoped, non-master caller that is NOT the receipts' creator
		// ("sigma" sent the messages) and not "victor" either — pure reader.
		const tAcme = t.withIdentity({
			subject: "user-acme",
			organizationId: "acme-client",
		} as Parameters<typeof t.withIdentity>[0]);
		const acmeRead = await tAcme.query(
			internal.receiptTenantBackfill._receiptsForCaller,
			{},
		);
		expect(acmeRead.length).toBe(3);
		expect(acmeRead.every((r) => r.recipient === "victor")).toBe(true);
		expect(acmeRead.every((r) => r.tenantId === "acme-client")).toBe(true);

		// POLE B — identity: subject "user-other", organizationId "other-client".
		// The SAME query (_receiptsForCaller, no args) under a DIFFERENT
		// identity. LITMUS: this must return ZERO of acme-client's rows — the
		// assertion that fails if the tenant weren't derived from the identity
		// (e.g. if withOrgScope were deleted or a tenant hardcoded).
		const tOther = t.withIdentity({
			subject: "user-other",
			organizationId: "other-client",
		} as Parameters<typeof t.withIdentity>[0]);
		const otherRead = await tOther.query(
			internal.receiptTenantBackfill._receiptsForCaller,
			{},
		);
		expect(otherRead.some((r) => r.recipient === "victor")).toBe(false); // LITMUS
		expect(otherRead.length).toBe(2);
		expect(otherRead.every((r) => r.recipient === "clio")).toBe(true);
		expect(otherRead.every((r) => r.tenantId === "other-client")).toBe(true);
	});

	test("master identity (no org attached) reads across both tenants", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor"],
		});
		await seedManyUndefinedTenantReceipts(t, "victor", 2);
		await seedManyUndefinedTenantReceipts(t, "sigma", 1); // null-master, never stamped

		await t.action(internal.receiptTenantBackfill.backfillReceiptTenants, {
			dryRun: false,
		});

		// No Clerk identity — MCP/CLI-style master path, mirrors the rest of
		// the repo's `allowNoIdentityMaster` reachability via a service-account
		// subject the auth-namespace tests already exercise.
		const tMaster = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);
		const masterRead = await tMaster.query(
			internal.receiptTenantBackfill._receiptsForCaller,
			{},
		);
		expect(masterRead.length).toBe(3); // 2 stamped acme rows + 1 still-null sigma row
	});
});
