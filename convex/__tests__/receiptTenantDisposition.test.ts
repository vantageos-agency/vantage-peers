/// <reference types="vite/client" />
//
// task k17235zncknhn971xcfkp9pjb18emm6z follow-up — the master-carve-out
// write fix (sendMessageCore, convex/messages.ts) closes the FUTURE hole.
// This file answers the DISPOSITION question for what already landed: the
// 2 prod receipts tenanted "project/example-client" were found in a 16k-row SAMPLE
// of ~54k receipts. A full, exact count and an orphan-tenant sweep need a
// full scan, not a sample — that is what convex/receiptTenantAudit.ts's
// `listReceiptsWithTenant` and `listOrphanTenants` provide. READ-ONLY: no
// assertion here depends on a patch/insert/delete these functions perform,
// because they perform none.

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

async function seedReceipt(
	t: ReturnType<typeof createT>,
	opts: {
		from: string;
		recipient: string;
		recipientInstanceId?: string;
		tenantId?: string;
	},
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
			...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
		});
	});
}

describe("receiptTenantAudit — listReceiptsWithTenant", () => {
	test("counts and samples every receipt for one exact tenantId, ignoring other tenants and untenanted rows", async () => {
		const t = createT();
		await seedOrgMapping(t, { clerkOrgSlug: "acme", allowedOrchestrators: ["victor"] });

		await seedReceipt(t, { from: "system", recipient: "victor", tenantId: "acme" });
		await seedReceipt(t, { from: "system", recipient: "noe", tenantId: "acme" });
		await seedReceipt(t, { from: "system", recipient: "marie", tenantId: "other-org" });
		await seedReceipt(t, { from: "system", recipient: "pi" }); // untenanted

		const result = await t.action(internal.receiptTenantAudit.listReceiptsWithTenant, {
			tenantId: "acme",
		});

		expect(result.tenantId).toBe("acme");
		expect(result.total).toBe(2);
		expect(result.samples.length).toBe(2);
		expect(result.recipients).toEqual([
			{ recipient: "noe", count: 1 },
			{ recipient: "victor", count: 1 },
		]);
	});

	test("orphan tenant \"project/example-client\" — production incident shape, full count over a sample larger than the known 2 rows", async () => {
		const t = createT();

		await seedReceipt(t, { from: "system", recipient: "phi", tenantId: "project/example-client" });
		await seedReceipt(t, { from: "system", recipient: "phi-vps", recipientInstanceId: "phi-vps", tenantId: "project/example-client" });
		await seedReceipt(t, { from: "system", recipient: "sigma", tenantId: "acme" });

		const result = await t.action(internal.receiptTenantAudit.listReceiptsWithTenant, {
			tenantId: "project/example-client",
		});

		expect(result.total).toBe(2);
		expect(result.samples.length).toBe(2);
		expect(result.recipients).toEqual([
			{ recipient: "phi", count: 1 },
			{ recipient: "phi-vps", count: 1 },
		]);
	});

	test("samples cap at 20 even when total exceeds 20, but the recipient tally stays exact", async () => {
		const t = createT();
		for (let i = 0; i < 25; i++) {
			await seedReceipt(t, { from: "system", recipient: `r${i % 3}`, tenantId: "bigco" });
		}

		const result = await t.action(internal.receiptTenantAudit.listReceiptsWithTenant, {
			tenantId: "bigco",
		});

		expect(result.total).toBe(25);
		expect(result.samples.length).toBe(20);
		const recipientTotal = result.recipients.reduce((a, r) => a + r.count, 0);
		expect(recipientTotal).toBe(25);
	});

	test("multi-page case: total and recipient tally are exact across a forced small page size, samples still cap at 20", async () => {
		const t = createT();
		for (let i = 0; i < 47; i++) {
			await seedReceipt(t, { from: "system", recipient: `r${i % 5}`, tenantId: "multipage" });
		}

		const result = await t.action(internal.receiptTenantAudit.listReceiptsWithTenant, {
			tenantId: "multipage",
			batchSize: 7,
		});

		expect(result.total).toBe(47);
		expect(result.samples.length).toBe(20);
		const recipientTotal = result.recipients.reduce((a, r) => a + r.count, 0);
		expect(recipientTotal).toBe(47);
	});

	test("sanity: a small row count under a small batchSize stays well under the page cap", async () => {
		const t = createT();
		await seedReceipt(t, { from: "system", recipient: "victor", tenantId: "capped" });
		await seedReceipt(t, { from: "system", recipient: "noe", tenantId: "capped" });

		await expect(
			t.action(internal.receiptTenantAudit.listReceiptsWithTenant, {
				tenantId: "capped",
				batchSize: 1,
			}),
		).resolves.toMatchObject({ total: 2 });
	});

	test("page cap: exceeding the named page cap throws rather than truncating silently", async () => {
		const t = createT();
		// 3 rows / batchSize 1 = 3 pages, which exceeds a pageCap of 2.
		await seedReceipt(t, { from: "system", recipient: "victor", tenantId: "capped" });
		await seedReceipt(t, { from: "system", recipient: "noe", tenantId: "capped" });
		await seedReceipt(t, { from: "system", recipient: "pi", tenantId: "capped" });

		await expect(
			t.action(internal.receiptTenantAudit.listReceiptsWithTenant, {
				tenantId: "capped",
				batchSize: 1,
				pageCap: 2,
			}),
		).rejects.toThrow(/exceeded 2 pages without isDone/);
	});

	test("ASCII cap: a recipient name with non-ASCII characters is returned, not thrown", async () => {
		const t = createT();
		await seedReceipt(t, { from: "system", recipient: "Hélène-test", tenantId: "intl" });

		const result = await t.action(internal.receiptTenantAudit.listReceiptsWithTenant, {
			tenantId: "intl",
		});

		expect(result.total).toBe(1);
		expect(result.recipients).toEqual([{ recipient: "Hélène-test", count: 1 }]);
	});
});

describe("receiptTenantAudit — listOrphanTenants", () => {
	test("an orphan tenant (no client_org_mapping row at all) is reported with its count", async () => {
		const t = createT();
		await seedOrgMapping(t, { clerkOrgSlug: "acme", allowedOrchestrators: ["victor"] });

		await seedReceipt(t, { from: "system", recipient: "phi", tenantId: "project/example-client" });
		await seedReceipt(t, { from: "system", recipient: "phi-vps", tenantId: "project/example-client" });
		await seedReceipt(t, { from: "system", recipient: "victor", tenantId: "acme" }); // valid, not orphan
		await seedReceipt(t, { from: "system", recipient: "pi" }); // untenanted, excluded entirely

		const result = await t.action(internal.receiptTenantAudit.listOrphanTenants, {});

		expect(result.orphans).toEqual([{ tenantId: "project/example-client", count: 2 }]);
		expect(result.orphans.find((o) => o.tenantId === "acme")).toBeUndefined();
	});

	test("DECISION pinned: an inactive org's slug is NOT counted as an orphan — its mapping row still exists", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "dormant-co",
			allowedOrchestrators: ["pi"],
			isActive: false,
		});

		await seedReceipt(t, { from: "system", recipient: "pi", tenantId: "dormant-co" });
		await seedReceipt(t, { from: "system", recipient: "phi", tenantId: "truly-unknown" });

		const result = await t.action(internal.receiptTenantAudit.listOrphanTenants, {});

		expect(result.orphans.find((o) => o.tenantId === "dormant-co")).toBeUndefined();
		expect(result.orphans.find((o) => o.tenantId === "truly-unknown")?.count).toBe(1);
	});

	test("multi-page case: orphan totals are exact across a forced small page size", async () => {
		const t = createT();
		await seedOrgMapping(t, { clerkOrgSlug: "acme", allowedOrchestrators: ["victor"] });

		for (let i = 0; i < 30; i++) {
			await seedReceipt(t, { from: "system", recipient: `r${i}`, tenantId: "orphan-many" });
		}
		for (let i = 0; i < 10; i++) {
			await seedReceipt(t, { from: "system", recipient: `victor`, tenantId: "acme" });
		}

		const result = await t.action(internal.receiptTenantAudit.listOrphanTenants, {
			batchSize: 6,
		});

		expect(result.scanned).toBe(40);
		expect(result.orphans).toEqual([{ tenantId: "orphan-many", count: 30 }]);
	});

	test("no orphans when every tenanted receipt matches a known (active or inactive) slug", async () => {
		const t = createT();
		await seedOrgMapping(t, { clerkOrgSlug: "acme", allowedOrchestrators: ["victor"] });
		await seedOrgMapping(t, {
			clerkOrgSlug: "dormant-co",
			allowedOrchestrators: ["pi"],
			isActive: false,
		});

		await seedReceipt(t, { from: "system", recipient: "victor", tenantId: "acme" });
		await seedReceipt(t, { from: "system", recipient: "pi", tenantId: "dormant-co" });

		const result = await t.action(internal.receiptTenantAudit.listOrphanTenants, {});

		expect(result.orphans).toEqual([]);
	});

	test("page cap: exceeding the named page cap throws rather than truncating silently", async () => {
		const t = createT();
		// 3 rows / batchSize 1 = 3 pages, which exceeds a pageCap of 2.
		await seedReceipt(t, { from: "system", recipient: "a", tenantId: "orphan-cap" });
		await seedReceipt(t, { from: "system", recipient: "b", tenantId: "orphan-cap" });
		await seedReceipt(t, { from: "system", recipient: "c", tenantId: "orphan-cap" });

		await expect(
			t.action(internal.receiptTenantAudit.listOrphanTenants, {
				batchSize: 1,
				pageCap: 2,
			}),
		).rejects.toThrow(/exceeded 2 pages without isDone/);
	});

	test("ASCII cap: an orphan tenantId with a non-ASCII character is returned, not thrown", async () => {
		const t = createT();
		await seedReceipt(t, { from: "system", recipient: "a", tenantId: "project/Zoë" });

		const result = await t.action(internal.receiptTenantAudit.listOrphanTenants, {});

		expect(result.orphans).toEqual([{ tenantId: "project/Zoë", count: 1 }]);
	});
});
