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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

// #1259 fix: `backfillReceiptTenants` is now a self-scheduling
// `internalMutation` (one bounded page per execution, modeled on
// `backfillReviewPrLinkFields`), so fake timers + `finishAllScheduledFunctions`
// drive every continuation to completion — same discipline as
// backfillBriefingNoteParticipants.test.ts / drop_orphan_tables.test.ts.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

// Runs the first page, then drains every self-scheduled continuation.
// Every test in this file either seeds few enough rows that the FIRST page
// already covers the whole corpus (isDone true on the first call, so its
// returned totals ARE the whole-backfill totals), or is the dedicated
// pagination test below, which asserts on `ctx.db` state after the drain
// rather than on a single call's return value (the scheduled continuations'
// own returns are not observable from the caller).
async function runBackfillToCompletion(
	t: ReturnType<typeof createT>,
	args: { dryRun: boolean; batchSize?: number },
) {
	const result = await t.mutation(
		internal.receiptTenantBackfill.backfillReceiptTenants,
		args,
	);
	if (!result.isDone) {
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	}
	return result;
}

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

// Seeds a message + an ALREADY-STAMPED receipt (tenantId set) — for the
// SCAN_CAP_EXCEEDED pole, which reads `_receiptsForCaller` directly and has
// no need to run the backfill action first.
async function seedStampedReceipt(
	t: ReturnType<typeof createT>,
	opts: { from: string; recipient: string; tenantId: string },
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
			tenantId: opts.tenantId,
		});
	});
}

async function seedManyStampedReceipts(
	t: ReturnType<typeof createT>,
	opts: { from: string; recipient: string; tenantId: string },
	count: number,
) {
	const ids = [];
	for (let i = 0; i < count; i++) {
		ids.push(await seedStampedReceipt(t, opts));
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
			orgSlug: matches[0].clerkOrgSlug,
			reason: "OLD recipient-only rule — reconstructed for the RED-proof only",
		};
	}
	return {
		state: "no-touch",
		orgSlug: null,
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
			orgSlug: "acme-client",
			reason: "sender and recipient both resolve to the same single active client org",
		});
	});

	test("MUST_PASS: distinct sender/recipient, both in the same org -> same-client-org", () => {
		const r = resolveReceiptPair(clientOrgs, "victor", "clio");
		expect(r.state).toBe("same-client-org");
		expect(r.orgSlug).toBe("acme-client");
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
		expect(oldRuleResult.orgSlug).toBe("acme-client");

		// GREEN: the new both-ends rule refuses because sender "pi" resolves
		// to NO client org (senderOrgs.length === 0 !== 1).
		const newRuleResult = resolveReceiptPair(orgsWithSigma, "pi", "sigma");
		expect(newRuleResult.state).toBe("no-touch"); // GREEN: leak closed
		expect(newRuleResult.orgSlug).toBeNull();
	});

	test("MUST_BLOCK: sender in one org, recipient in a DIFFERENT org -> no-touch", () => {
		const twoOrgs: ClientOrg[] = [
			{ clerkOrgSlug: "acme-client", allowedOrchestrators: ["victor"] },
			{ clerkOrgSlug: "other-client", allowedOrchestrators: ["clio"] },
		];
		const r = resolveReceiptPair(twoOrgs, "victor", "clio");
		expect(r.state).toBe("no-touch");
		expect(r.orgSlug).toBeNull();
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

		const result = await runBackfillToCompletion(t, { dryRun: true });

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

		const result = await runBackfillToCompletion(t, { dryRun: false });

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

		const first = await runBackfillToCompletion(t, { dryRun: false });
		expect(first.patched).toBe(3);
		expect(first.perScope["acme-client"]).toBe(3);
		expect(first.notTouched).toBe(2);

		const second = await runBackfillToCompletion(t, { dryRun: false });
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

		await runBackfillToCompletion(t, { dryRun: false });

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

		await runBackfillToCompletion(t, { dryRun: false });

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

// ─────────────────────────────────────────────────────────────────────────────
// SCAN_CAP_EXCEEDED — the loud pole (coordinator follow-up). A `.take(CAP)`
// read that quietly hands back a short list is indistinguishable from "this
// is everyone". `scanCapOverride` lets this pole seed CAP+1 rows without
// seeding thousands.
// ─────────────────────────────────────────────────────────────────────────────

describe("SCAN_CAP_EXCEEDED: the read is loud on overflow, never a silent short list", () => {
	const TEST_CAP = 3;

	test("scoped branch: CAP+1 rows in the caller's own tenant throws, not a truncated page", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor"],
		});
		await seedManyStampedReceipts(
			t,
			{ from: "victor", recipient: "victor", tenantId: "acme-client" },
			TEST_CAP + 1,
		);

		const tAcme = t.withIdentity({
			subject: "user-acme",
			organizationId: "acme-client",
		} as Parameters<typeof t.withIdentity>[0]);

		await expect(
			tAcme.query(internal.receiptTenantBackfill._receiptsForCaller, {
				scanCapOverride: TEST_CAP,
			}),
		).rejects.toThrow(/SCAN_CAP_EXCEEDED/);
	});

	test("scoped branch: exactly CAP rows in the caller's own tenant still returns the full set", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor"],
		});
		await seedManyStampedReceipts(
			t,
			{ from: "victor", recipient: "victor", tenantId: "acme-client" },
			TEST_CAP,
		);

		const tAcme = t.withIdentity({
			subject: "user-acme",
			organizationId: "acme-client",
		} as Parameters<typeof t.withIdentity>[0]);

		const rows = await tAcme.query(
			internal.receiptTenantBackfill._receiptsForCaller,
			{ scanCapOverride: TEST_CAP },
		);
		expect(rows.length).toBe(TEST_CAP);
	});

	test("master branch: CAP+1 rows across the whole table throws, not a truncated page", async () => {
		const t = createT();
		await seedManyStampedReceipts(
			t,
			{ from: "victor", recipient: "victor", tenantId: "acme-client" },
			TEST_CAP + 1,
		);

		const tMaster = t.withIdentity({
			subject: "test-service-account-user-id",
		} as Parameters<typeof t.withIdentity>[0]);

		await expect(
			tMaster.query(internal.receiptTenantBackfill._receiptsForCaller, {
				scanCapOverride: TEST_CAP,
			}),
		).rejects.toThrow(/SCAN_CAP_EXCEEDED/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// #1259 REVISE follow-ups (Eta) — the guard that an already-tenanted receipt
// is never re-tenanted, the refusal for a scope with no resolvable identity,
// and the paginated resume path.
// ─────────────────────────────────────────────────────────────────────────────

describe("guard: an already-tenanted receipt is never re-tenanted", () => {
	test("pre-stamped receipt (tenantId=A) stays on A even though the resolver would give B", async () => {
		const t = createT();
		// acme-client: sender "victor" -> resolver would give "acme-client" (B)
		// for this pair if it were ever visited.
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "master",
			allowedOrchestrators: ["*"],
		});

		// Pre-stamped to "legacy-tenant" (A) BEFORE this run — the receipt is
		// already tenanted, so it must never even be visited by the
		// `by_tenant`/`eq(undefined)` page, let alone re-patched to
		// "acme-client" (B).
		const preStampedId = await seedStampedReceipt(t, {
			from: "victor",
			recipient: "victor",
			tenantId: "legacy-tenant",
		});

		await runBackfillToCompletion(t, { dryRun: false });

		const row = await t.run(async (ctx) => ctx.db.get(preStampedId));
		expect(row?.tenantId).toBe("legacy-tenant"); // GREEN: never re-tenanted to "acme-client"

		// RED-proof performed manually (reported alongside this PR, not
		// committed): with the `by_tenant`/`eq(undefined)` selection widened to
		// a full-table scan AND the in-loop `ctx.db.get`/`tenantId===undefined`
		// re-check removed, this same assertion fails — the row gets
		// re-patched to "acme-client".
	});
});

describe("guard: an identity with no resolvable scope is refused, not defaulted to master", () => {
	test("anonymous caller (no identity at all) reads zero rows via the early return", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor"],
		});
		await seedManyStampedReceipts(
			t,
			{ from: "victor", recipient: "victor", tenantId: "acme-client" },
			2,
		);

		// No `.withIdentity()` at all — `ctx.auth.getUserIdentity()` resolves to
		// null, `withOrgScope` returns the fail-closed
		// `{ isMaster: false, orgSlug: null }` default, and `_receiptsForCaller`'s
		// early return (`if (!scope.isMaster && scope.orgSlug === null) return
		// [];`) must refuse before ever touching `messageReceipts`.
		const rows = await t.query(internal.receiptTenantBackfill._receiptsForCaller, {});
		expect(rows).toEqual([]); // refused explicitly, not a partial/master read

		// Manual verification performed alongside this PR (reported, not
		// committed): the early return was temporarily deleted and this same
		// assertion was re-run. FINDING (reported honestly, not the RED this
		// test was expected to produce): with the guard removed, the call
		// falls through to `.withIndex("by_tenant", (q) => q.eq("tenantId",
		// orgSlug))` with `orgSlug` cast from a real `null` — Convex's index
		// equality treats `null` as distinct from BOTH a stored string tenant
		// AND an absent (`undefined`) `tenantId`, so this fallthrough matches
		// zero rows under the CURRENT schema and the assertion still passed
		// (no RED). This guard is therefore verified-present defense-in-depth
		// (mirrors `listMessages`'s own degenerate-scope guard, and is the
		// correct fail-closed shape — refuse before ever touching
		// `messageReceipts`, rather than rely on an index-equality coincidence)
		// rather than a data-leak fix provable by this black-box return-value
		// test; removing it is still a regression in INTENT (an implicit,
		// coincidental non-match standing in for an explicit refusal) even
		// though it produced no observable difference in THIS run.
	});
});

describe("pagination: forced-small batch resumes via continueCursor across multiple pages", () => {
	const TEST_BATCH_SIZE = 3;

	test("more rows than one batch: the drain stamps every resolvable row; a second run stamps 0", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor", "sigma"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "master",
			allowedOrchestrators: ["*"],
		});

		// 10 same-client-org rows across a batch size of 3 forces 4 pages
		// (3 + 3 + 3 + 1), exercising the self-scheduling continuation path.
		const sameOrgIds = await seedManyUndefinedTenantReceipts(
			t,
			{ from: "victor", recipient: "victor" },
			10,
		);
		// 2 leak-trap rows (never resolvable) mixed into the same population.
		const leakTrapIds = await seedManyUndefinedTenantReceipts(
			t,
			{ from: "pi", recipient: "sigma" },
			2,
		);

		const first = await runBackfillToCompletion(t, {
			dryRun: false,
			batchSize: TEST_BATCH_SIZE,
		});
		expect(first.isDone).toBe(false); // first execution covers only ONE page (3 of 12 rows)
		expect(first.patched).toBeLessThanOrEqual(TEST_BATCH_SIZE);

		// The drain (inside runBackfillToCompletion) has already run every
		// self-scheduled continuation via finishAllScheduledFunctions — assert
		// on final `ctx.db` state, which IS observable across executions.
		await t.run(async (ctx) => {
			for (const id of sameOrgIds) {
				const row = await ctx.db.get(id);
				expect(row?.tenantId).toBe("acme-client");
			}
			for (const id of leakTrapIds) {
				const row = await ctx.db.get(id);
				expect(row?.tenantId).toBeUndefined();
			}
		});

		// Second full run: the undefined-tenant population is now just the 2
		// leak-trap rows — one page, patched 0, isDone true immediately.
		const second = await runBackfillToCompletion(t, {
			dryRun: false,
			batchSize: TEST_BATCH_SIZE,
		});
		expect(second.patched).toBe(0);
		expect(second.total).toBe(2);
		expect(second.isDone).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// perScope observability: production only ever reads the per-PAGE log line
// (a page's own return value is never observable beyond the first call —
// every later self-scheduled continuation's return is opaque to the caller).
// The FINAL page's log line must therefore carry the CUMULATIVE split across
// every page, not just what that one page resolved.
// ─────────────────────────────────────────────────────────────────────────────

describe("perScope observability: the final log line carries the cumulative split", () => {
	test("multi-page run logs the FULL cumulative perScope on its last (isDone=true) line", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["victor"],
		});

		// 7 resolvable rows across a batch size of 3 forces 3 pages (3 + 3 + 1)
		// — the cumulative perScope only reaches its final value {acme-client:7}
		// on the LAST page's own log line; any single page only ever resolves
		// at most 3 of them.
		await seedManyUndefinedTenantReceipts(
			t,
			{ from: "victor", recipient: "victor" },
			7,
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runBackfillToCompletion(t, { dryRun: true, batchSize: 3 });

		// Read the recorded calls BEFORE `mockRestore()` — restoring a spy also
		// clears `.mock.calls`, so the read must happen first.
		const lines = logSpy.mock.calls.map((call) => String(call[0]));
		logSpy.mockRestore();

		const doneLines = lines.filter((line) => line.includes("isDone=true"));
		expect(doneLines.length).toBe(1); // exactly one page (the last) is done

		// GREEN: the final line carries the full 7-row cumulative split, never
		// just the last page's own (at most 1-row) resolution. This assertion
		// goes RED if `perScope=${JSON.stringify(perScope)}` is removed from
		// the log line (verified manually alongside this PR — reported below).
		expect(doneLines[0]).toContain(
			`perScope=${JSON.stringify({ "acme-client": 7 })}`,
		);
	});
});
