/// <reference types="vite/client" />
//
// receiptTenantBackfill — both-ends resolver + one-action report/write proof.
// Task: sigma/receipt-tenant-count backfill for the 46906 undefined-tenant
// messageReceipts rows written before ead59b9 (T1 write-fix).
//
// THE RULE under test (Pi, binding, narrowed post-Eta-leak-finding): a
// receipt is backfilled ONLY IF its message's SENDER and its RECIPIENT both
// belong to the SAME single active client org. Otherwise it is left
// UNMARKED — "not touched", no unresolved bucket.
//
// WHY: the prior recipient-only rule stamped on the recipient alone. A
// fleet-internal message (sender "pi" -> recipient "sigma") where "sigma"
// ALSO sits in a client org's roster got stamped INTO that client org —
// leaking a fleet-internal receipt to a client. Both-ends-same-org closes
// that leak.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import {
	resolveReceiptPair,
	type ClientOrg,
	type ReceiptPairResolution,
} from "../receiptTenantBackfill";

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

// Seeds a message with a real `from` (sender) + an undefined-tenant receipt
// for `recipient` — mirrors how existing message tests seed the messages
// table (from/channel/content/createdAt).
async function seedUndefinedTenantReceipt(
	t: ReturnType<typeof createT>,
	opts: { from: string; recipient: string },
) {
	return await t.run(async (ctx) => {
		const messageId = await ctx.db.insert("messages", {
			from: opts.from,
			channel: "broadcast",
			content: `msg from ${opts.from} to ${opts.recipient}`,
			createdAt: Date.now(),
		});
		return await ctx.db.insert("messageReceipts", {
			messageId,
			recipient: opts.recipient,
			// tenantId intentionally omitted — the pre-fix undefined population.
		});
	});
}

async function seedManyUndefinedTenantReceipts(
	t: ReturnType<typeof createT>,
	opts: { from: string; recipient: string },
	count: number,
) {
	const ids = [];
	for (let i = 0; i < count; i++) {
		ids.push(await seedUndefinedTenantReceipt(t, opts));
	}
	return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveReceiptPair — the shared resolver, unit-level
// ─────────────────────────────────────────────────────────────────────────────

// The OLD recipient-only rule (pre-fix), reconstructed here ONLY to prove the
// RED/GREEN gap for the MUST_BLOCK leak poles below — never imported from
// production code (the leaky implementation is deliberately gone).
function resolveReceiptTenantRecipientOnly(
	clientOrgs: ClientOrg[],
	recipient: string,
): ReceiptPairResolution {
	const matches = clientOrgs.filter((org) =>
		org.allowedOrchestrators.includes(recipient),
	);
	if (matches.length === 1) {
		return {
			state: "same-client-org",
			tenant: matches[0].clerkOrgSlug,
			reason: "OLD recipient-only rule — reconstructed for the RED-proof only",
		};
	}
	return {
		state: "no-touch",
		tenant: null,
		reason: "OLD recipient-only rule — reconstructed for the RED-proof only",
	};
}

describe("resolveReceiptPair — decision table (both-ends)", () => {
	const clientOrgs: ClientOrg[] = [
		{ clerkOrgSlug: "acme-client", allowedOrchestrators: ["victor", "clio", "iris"] },
	];

	test("MUST_PASS: sender and recipient both in the same single client org -> same-client-org", () => {
		const r = resolveReceiptPair(clientOrgs, "victor", "victor");
		expect(r).toEqual({
			state: "same-client-org",
			tenant: "acme-client",
			reason: "sender and recipient both resolve to the same single active client org",
		});
	});

	test("MUST_PASS: distinct sender/recipient, both in the same org -> same-client-org", () => {
		const r = resolveReceiptPair(clientOrgs, "victor", "clio");
		expect(r.state).toBe("same-client-org");
		expect(r.tenant).toBe("acme-client");
	});

	test("MUST_BLOCK (the leak): fleet sender, client-org recipient -> no-touch", () => {
		// sender "pi" is fleet-internal (in no client org); recipient "sigma"
		// happens to ALSO sit in acme-client's roster. Under the OLD
		// recipient-only rule this stamped INTO acme-client — the exact leak.
		const orgsWithSigma: ClientOrg[] = [
			{ clerkOrgSlug: "acme-client", allowedOrchestrators: ["victor", "sigma"] },
		];

		// RED-proof: the OLD recipient-only rule DOES stamp this (the leak).
		const oldRuleResult = resolveReceiptTenantRecipientOnly(orgsWithSigma, "sigma");
		expect(oldRuleResult.state).toBe("same-client-org"); // RED: old rule leaks
		expect(oldRuleResult.tenant).toBe("acme-client");

		// GREEN: the new both-ends rule refuses because sender "pi" resolves
		// to NO client org (senderOrgs.length === 0 !== 1).
		const newRuleResult = resolveReceiptPair(orgsWithSigma, "pi", "sigma");
		expect(newRuleResult.state).toBe("no-touch"); // GREEN: leak closed
		expect(newRuleResult.tenant).toBeNull();
	});

	test("MUST_BLOCK: sender in one org, recipient in a DIFFERENT org -> no-touch", () => {
		const twoOrgs: ClientOrg[] = [
			{ clerkOrgSlug: "acme-client", allowedOrchestrators: ["victor"] },
			{ clerkOrgSlug: "other-client", allowedOrchestrators: ["clio"] },
		];
		const r = resolveReceiptPair(twoOrgs, "victor", "clio");
		expect(r.state).toBe("no-touch");
		expect(r.tenant).toBeNull();
	});

	test("no-touch: both ends fleet-internal (neither in any client org)", () => {
		const r = resolveReceiptPair(clientOrgs, "pi", "sigma");
		expect(r.state).toBe("no-touch");
	});

	test("no-touch: sender ambiguous (in >1 client org)", () => {
		const ambiguousOrgs: ClientOrg[] = [
			{ clerkOrgSlug: "acme-client", allowedOrchestrators: ["phi", "victor"] },
			{ clerkOrgSlug: "other-client", allowedOrchestrators: ["phi"] },
		];
		const r = resolveReceiptPair(ambiguousOrgs, "phi", "victor");
		expect(r.state).toBe("no-touch");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// backfillReceiptTenants — the one action, both poles
// ─────────────────────────────────────────────────────────────────────────────

describe("backfillReceiptTenants — report (dryRun:true) pole", () => {
	test("distribution, positive control, zero writes", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor", "sigma"], // "sigma" ALSO in roster — the leak trap
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "other-client",
			allowedOrchestrators: ["clio"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "master",
			allowedOrchestrators: ["*"],
		});

		// same-client-org: sender=victor, recipient=victor (both acme-client).
		const sameOrgIds = await seedManyUndefinedTenantReceipts(
			t,
			{ from: "victor", recipient: "victor" },
			3,
		);
		// MUST_BLOCK leak trap: sender=pi (fleet), recipient=sigma (in acme roster).
		const leakTrapIds = await seedManyUndefinedTenantReceipts(
			t,
			{ from: "pi", recipient: "sigma" },
			2,
		);
		// MUST_BLOCK memberships-differ: sender=victor (acme), recipient=clio (other).
		const differentOrgIds = await seedManyUndefinedTenantReceipts(
			t,
			{ from: "victor", recipient: "clio" },
			1,
		);

		const result = await t.action(
			internal.receiptTenantBackfill.backfillReceiptTenants,
			{ dryRun: true },
		);

		expect(result.total).toBe(6);
		expect(result.perScope["acme-client"]).toBe(3);
		expect(result.perScope["other-client"]).toBeUndefined();
		expect(result.notTouched).toBe(3); // 2 leak-trap + 1 memberships-differ
		expect(result.dryRun).toBe(true);
		expect(result.patched).toBe(0);

		// Positive control: proves the resolver CAN produce a non-null
		// same-client-org resolution at all.
		expect(result.positiveControlSample).not.toBeNull();
		expect(result.positiveControlSample?.tenant).toBe("acme-client");

		// Dry run wrote NOTHING — re-read every seeded receipt, all still undefined.
		await t.run(async (ctx) => {
			for (const id of [...sameOrgIds, ...leakTrapIds, ...differentOrgIds]) {
				const row = await ctx.db.get(id);
				expect(row?.tenantId).toBeUndefined();
			}
		});
	});
});

describe("backfillReceiptTenants — write (dryRun:false) pole", () => {
	test("stamps same-client-org rows only; leak trap and cross-org rows untouched", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor", "sigma"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "other-client",
			allowedOrchestrators: ["clio"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "master",
			allowedOrchestrators: ["*"],
		});

		const sameOrgIds = await seedManyUndefinedTenantReceipts(
			t,
			{ from: "victor", recipient: "victor" },
			4,
		);
		// MUST_BLOCK — the leak: fleet sender "pi" -> client-roster recipient "sigma".
		const leakTrapIds = await seedManyUndefinedTenantReceipts(
			t,
			{ from: "pi", recipient: "sigma" },
			2,
		);
		// MUST_BLOCK — memberships differ: sender in acme, recipient in other.
		const differentOrgIds = await seedManyUndefinedTenantReceipts(
			t,
			{ from: "victor", recipient: "clio" },
			1,
		);

		const result = await t.action(
			internal.receiptTenantBackfill.backfillReceiptTenants,
			{ dryRun: false },
		);

		expect(result.patched).toBe(4);
		expect(result.perScope["acme-client"]).toBe(4);
		expect(result.notTouched).toBe(3);

		await t.run(async (ctx) => {
			for (const id of sameOrgIds) {
				const row = await ctx.db.get(id);
				expect(row?.tenantId).toBe("acme-client");
			}
			// MUST_BLOCK regression: the leak trap rows stay undefined even
			// after a real write-mode run — this is the row that would fail if
			// the old recipient-only rule were reintroduced.
			for (const id of leakTrapIds) {
				const row = await ctx.db.get(id);
				expect(row?.tenantId).toBeUndefined();
			}
			for (const id of differentOrgIds) {
				const row = await ctx.db.get(id);
				expect(row?.tenantId).toBeUndefined();
			}
		});
	});

	test("idempotence: running dryRun:false twice patches 0 the second time", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor", "sigma"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "master",
			allowedOrchestrators: ["*"],
		});

		await seedManyUndefinedTenantReceipts(
			t,
			{ from: "victor", recipient: "victor" },
			3,
		);
		await seedManyUndefinedTenantReceipts(
			t,
			{ from: "pi", recipient: "sigma" },
			2,
		);

		const first = await t.action(
			internal.receiptTenantBackfill.backfillReceiptTenants,
			{ dryRun: false },
		);
		expect(first.patched).toBe(3);
		expect(first.perScope["acme-client"]).toBe(3);
		expect(first.notTouched).toBe(2);

		const second = await t.action(
			internal.receiptTenantBackfill.backfillReceiptTenants,
			{ dryRun: false },
		);
		// Second scan only sees rows still undefined — the already-stamped
		// "victor" rows have left the undefined-tenant population entirely.
		// The leak-trap rows stay undefined and are counted notTouched again.
		expect(second.patched).toBe(0);
		expect(second.perScope["acme-client"]).toBeUndefined();
		expect(second.notTouched).toBe(2); // same leak-trap rows, still not-touched
		expect(second.total).toBe(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Both-directions scoped-IDENTITY read (the litmus Eta named). Unchanged from
// the prior pole — `_receiptsForCaller` derives the tenant from `withOrgScope`,
// not a client-supplied arg, so identity IS the input.
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

		await seedManyUndefinedTenantReceipts(
			t,
			{ from: "victor", recipient: "victor" },
			3,
		);
		await seedManyUndefinedTenantReceipts(
			t,
			{ from: "clio", recipient: "clio" },
			2,
		);

		await t.action(internal.receiptTenantBackfill.backfillReceiptTenants, {
			dryRun: false,
		});

		// POLE A — identity: subject "user-acme", organizationId "acme-client".
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
		// LITMUS: this must return ZERO of acme-client's rows.
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
		await seedManyUndefinedTenantReceipts(
			t,
			{ from: "victor", recipient: "victor" },
			2,
		);
		await seedManyUndefinedTenantReceipts(
			t,
			{ from: "pi", recipient: "sigma" },
			1,
		); // stays undefined — no-touch

		await t.action(internal.receiptTenantBackfill.backfillReceiptTenants, {
			dryRun: false,
		});

		const tMaster = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);
		const masterRead = await tMaster.query(
			internal.receiptTenantBackfill._receiptsForCaller,
			{},
		);
		expect(masterRead.length).toBe(3); // 2 stamped acme rows + 1 still-null row
	});
});
