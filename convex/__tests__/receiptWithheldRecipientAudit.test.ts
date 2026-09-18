/// <reference types="vite/client" />
//
// READ-ONLY production instrument: counts the population a scoped client
// reader would STOP SEEING once reads derive the tenant from the verified
// identity (PR #1257). `npx convex data` caps at 8192 rows with no cursor,
// and `receiptTenantAudit.countReceiptTenantPresence` only counts tenant
// PRESENCE (with/without a tenantId at all) — neither instrument answers
// "of the untenanted rows, how many are addressed to a name that sits in a
// real client org's roster, and would therefore go dark under a scoped
// `eq("tenantId", orgSlug)` read?". This file pins that count.
//
// Mirrors receiptTenantBackfill's `loadRealClientOrgs` join EXACTLY (never
// re-implemented): master sentinel (`allowedOrchestrators === ["*"]`) and
// `orgKind === "operator"` rows are excluded from the roster, same as the
// backfill.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);

const createT = () => convexTest(schema, modules);

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	opts: {
		clerkOrgSlug: string;
		allowedOrchestrators: string[];
		isActive?: boolean;
		orgKind?: "operator" | "client";
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
			...(opts.orgKind !== undefined ? { orgKind: opts.orgKind } : {}),
		});
	});
}

async function seedUntenantedReceipt(
	t: ReturnType<typeof createT>,
	opts: { from: string; recipient: string; recipientInstanceId?: string },
): Promise<Id<"messageReceipts">> {
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
			...(opts.recipientInstanceId !== undefined
				? { recipientInstanceId: opts.recipientInstanceId }
				: {}),
			// tenantId intentionally omitted — the pre-fix undefined population.
		});
	});
}

async function seedTenantedReceipt(
	t: ReturnType<typeof createT>,
	opts: { from: string; recipient: string; tenantId: string },
): Promise<Id<"messageReceipts">> {
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

describe("receiptTenantAudit.countWithheldRecipientReceipts — positive control", () => {
	test("recipient in a real client org's roster is withheld; a fleet name and an already-tenanted row are not", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["client-agent"],
		});

		const withheldId = await seedUntenantedReceipt(t, {
			from: "pi",
			recipient: "client-agent",
		});
		await seedUntenantedReceipt(t, { from: "pi", recipient: "pi" });
		await seedTenantedReceipt(t, {
			from: "pi",
			recipient: "client-agent",
			tenantId: "acme-client",
		});

		const r = await t.action(
			internal.receiptTenantAudit.countWithheldRecipientReceipts,
			{},
		);

		expect(r.scanned).toBe(2); // only the two untenanted rows are scanned
		expect(r.withheld).toBe(1);
		expect(r.perOrg).toEqual({ "acme-client": 1 });
		expect(r.ambiguous).toBe(0);
		expect(r.positiveControlSampleReceiptId).toBe(withheldId);
		expect(r.clientRosterSize).toBe(1);
	});

	test("recipientInstanceId matching a roster entry counts as withheld", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["client-agent-vps"],
		});

		const withheldId = await seedUntenantedReceipt(t, {
			from: "pi",
			recipient: "client-agent",
			recipientInstanceId: "client-agent-vps",
		});

		const r = await t.action(
			internal.receiptTenantAudit.countWithheldRecipientReceipts,
			{},
		);

		expect(r.withheld).toBe(1);
		expect(r.perOrg).toEqual({ "acme-client": 1 });
		expect(r.positiveControlSampleReceiptId).toBe(withheldId);
	});

	test("an operator-kind org's roster does NOT count (reuse of loadRealClientOrgs proven)", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "our-own-org",
			allowedOrchestrators: ["op-role"],
			orgKind: "operator",
		});

		await seedUntenantedReceipt(t, { from: "pi", recipient: "op-role" });

		const r = await t.action(
			internal.receiptTenantAudit.countWithheldRecipientReceipts,
			{},
		);

		expect(r.withheld).toBe(0);
		expect(r.perOrg).toEqual({});
		expect(r.positiveControlSampleReceiptId).toBeNull();
		expect(r.clientRosterSize).toBe(0);
	});

	test("the master sentinel roster (['*']) does NOT count", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "master",
			allowedOrchestrators: ["*"],
		});

		await seedUntenantedReceipt(t, { from: "pi", recipient: "*" });

		const r = await t.action(
			internal.receiptTenantAudit.countWithheldRecipientReceipts,
			{},
		);

		expect(r.withheld).toBe(0);
		expect(r.clientRosterSize).toBe(0);
	});

	test("a name present in TWO client rosters goes to ambiguous, never double-counted in perOrg", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["shared-name", "victor"],
		});
		await seedOrgMapping(t, {
			clerkOrgSlug: "globex-client",
			allowedOrchestrators: ["shared-name"],
		});

		const ambiguousId = await seedUntenantedReceipt(t, {
			from: "pi",
			recipient: "shared-name",
		});

		const r = await t.action(
			internal.receiptTenantAudit.countWithheldRecipientReceipts,
			{},
		);

		expect(r.withheld).toBe(1);
		expect(r.ambiguous).toBe(1);
		expect(r.perOrg).toEqual({});
		expect(r.positiveControlSampleReceiptId).toBe(ambiguousId);
		expect(r.clientRosterSize).toBe(2); // shared-name, victor -- distinct names across both rosters
	});

	test("empty roster: zero withheld is visible as 'no roster to check against', clientRosterSize 0", async () => {
		const t = createT();
		await seedUntenantedReceipt(t, { from: "pi", recipient: "anybody" });

		const r = await t.action(
			internal.receiptTenantAudit.countWithheldRecipientReceipts,
			{},
		);

		expect(r.scanned).toBe(1);
		expect(r.withheld).toBe(0);
		expect(r.clientRosterSize).toBe(0);
	});
});

describe("receiptTenantAudit._withheldRecipientPage — multi-page accumulation", () => {
	test("more untenanted rows than one page: totals accumulate correctly across pages", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["client-agent"],
		});

		const TOTAL = 7;
		const PAGE_SIZE = 3; // forces 3 pages for 7 rows (3+3+1)
		for (let i = 0; i < TOTAL; i++) {
			await seedUntenantedReceipt(t, { from: "pi", recipient: "client-agent" });
		}

		let cursor: string | null = null;
		let isDone = false;
		let pages = 0;
		let scanned = 0;
		let withheld = 0;
		const perOrg: Record<string, number> = {};

		while (!isDone) {
			pages++;
			const page: {
				scanned: number;
				withheld: number;
				perOrg: Record<string, number>;
				ambiguous: number;
				sampleReceiptId: Id<"messageReceipts"> | null;
				rosterSize: number;
				isDone: boolean;
				continueCursor: string | null;
			} = await t.query(internal.receiptTenantAudit._withheldRecipientPage, {
				cursor,
				batchSize: PAGE_SIZE,
			});
			scanned += page.scanned;
			withheld += page.withheld;
			for (const [slug, count] of Object.entries(page.perOrg)) {
				perOrg[slug] = (perOrg[slug] ?? 0) + count;
			}
			isDone = page.isDone;
			cursor = page.continueCursor;
		}

		expect(pages).toBe(3);
		expect(scanned).toBe(TOTAL);
		expect(withheld).toBe(TOTAL);
		expect(perOrg).toEqual({ "acme-client": TOTAL });
	});

	test("countWithheldRecipientReceipts ACTION walks multiple pages, not just the query directly", async () => {
		// The test above drives `_withheldRecipientPage` by hand, one page at a
		// time — it proves the QUERY accumulates correctly across pages but
		// never proves the ACTION's own while-loop keeps going past page 1.
		// This test drives the ACTION itself with a forced small `batchSize`
		// so 7 rows require 3 pages (3+3+1) THROUGH the action's loop.
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-client",
			allowedOrchestrators: ["client-agent"],
		});

		const TOTAL = 7;
		for (let i = 0; i < TOTAL; i++) {
			await seedUntenantedReceipt(t, { from: "pi", recipient: "client-agent" });
		}

		const r = await t.action(
			internal.receiptTenantAudit.countWithheldRecipientReceipts,
			{ batchSize: 3 },
		);

		expect(r.scanned).toBe(TOTAL);
		expect(r.withheld).toBe(TOTAL);
		expect(r.perOrg).toEqual({ "acme-client": TOTAL });
	});
});
