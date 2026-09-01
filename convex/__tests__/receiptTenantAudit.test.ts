/// <reference types="vite/client" />
//
// Mechanism proof for the #1257 read-half gate audit query
// (convex/receiptTenantAudit.ts, task k171x0td6c1fyecsansna1gbr98dhwnk).
//
// The query counts messageReceipts rows whose tenantId is undefined — the
// pre-T1 population the scoped read can no longer see. Eta + Pi made the
// POSITIVE CONTROL binding: a withoutTenant=0 must be distinguishable from a
// query that could not see the table. These tests pin exactly that: the count
// is exact, and the positive control (withTenant + a real sample id) proves the
// scan returns populated rows, so a zero is "no such rows", never "saw nothing".

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

function createT(): ReturnType<typeof convexTest> {
	return convexTest(schema, modules) as unknown as ReturnType<
		typeof convexTest
	>;
}

async function seedMessage(t: ReturnType<typeof convexTest>): Promise<string> {
	return (await t.run(async (ctx) =>
		ctx.db.insert("messages", {
			from: "sigma",
			channel: "pi",
			content: "seed",
			createdAt: Date.now(),
		}),
	)) as unknown as string;
}

describe("receiptTenantAudit.countReceiptTenantPresence — mechanism + positive control", () => {
	test("mixed population: exact counts and a real positive-control sample", async () => {
		const t = createT();
		const messageId = (await seedMessage(t)) as Id<"messages">;
		await t.run(async (ctx) => {
			// 3 stamped (post-fix), 2 undefined-tenant (pre-fix)
			for (const tenantId of ["acme", "acme", "globex"]) {
				await ctx.db.insert("messageReceipts", {
					messageId,
					recipient: "sigma",
					tenantId,
				});
			}
			for (let i = 0; i < 2; i++) {
				await ctx.db.insert("messageReceipts", {
					messageId,
					recipient: "sigma",
					// tenantId omitted → undefined, the pre-T1 shape
				});
			}
		});

		const r = await t.query(
			internal.receiptTenantAudit.countReceiptTenantPresence,
			{},
		);
		expect(r.total).toBe(5);
		expect(r.withTenant).toBe(3);
		expect(r.withoutTenant).toBe(2);
		// positive control: the scan returned a populated row, proving a
		// withoutTenant of 0 elsewhere would mean "no such rows", not "saw nothing".
		expect(r.positiveControlSampleReceiptId).not.toBeNull();
	});

	test("all-stamped population: withoutTenant is a TRUE zero, positive control present", async () => {
		const t = createT();
		const messageId = (await seedMessage(t)) as Id<"messages">;
		await t.run(async (ctx) => {
			for (const tenantId of ["acme", "acme"]) {
				await ctx.db.insert("messageReceipts", {
					messageId,
					recipient: "sigma",
					tenantId,
				});
			}
		});

		const r = await t.query(
			internal.receiptTenantAudit.countReceiptTenantPresence,
			{},
		);
		expect(r.total).toBe(2);
		expect(r.withTenant).toBe(2);
		expect(r.withoutTenant).toBe(0);
		// the zero is trustworthy ONLY because the positive control is non-null
		expect(r.positiveControlSampleReceiptId).not.toBeNull();
	});

	test("empty table: total 0 and a NULL positive control — the un-trustworthy zero, made explicit", async () => {
		const t = createT();
		const r = await t.query(
			internal.receiptTenantAudit.countReceiptTenantPresence,
			{},
		);
		expect(r.total).toBe(0);
		expect(r.withoutTenant).toBe(0);
		// no sample → the caller MUST NOT read this withoutTenant=0 as "no pre-T1
		// rows"; it is "the scan saw nothing", the exact case the positive control
		// exists to separate.
		expect(r.positiveControlSampleReceiptId).toBeNull();
	});
});
