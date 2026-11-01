/// <reference types="vite/client" />
//
// tenantOrgId coverage + backfill for messages and messageReceipts (task
// k1783fk8r6p795x9fxrzyt9evd8hcxm7, PR 2a), run BEFORE the messages-family reads switch
// to tenantOrgId (PR 2b). Pinned: count on a mix (counts only); dry run writes nothing;
// fill from ONE ACTIVE mapping carrying an ID; absent / inactive / ambiguous / id-less
// mapping listed by _id and unwritten; mappingNewerThanRow in both directions; idempotent;
// never overwrite; a row with no tenantId counted noSlug and untouched.
// Hermetic. Fictitious identifiers only.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const NOW = 1_700_000_000_000;
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const count = internal.migrations.tenantOrgIdCoverage.count;
const backfill = internal.migrations.tenantOrgIdCoverage.backfill;

async function seedMappings(t: T) {
	await t.run(async (ctx) => {
		const mapping = (
			slug: string,
			extra: { clerkOrgId?: string; isActive?: boolean },
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive: extra.isActive ?? true,
				createdAt: NOW,
				...(extra.clerkOrgId !== undefined
					? { clerkOrgId: extra.clerkOrgId }
					: {}),
			});
		await mapping("acme-hr", { clerkOrgId: "org_ACME1" });
		await mapping("dormant", { clerkOrgId: "org_DORM1", isActive: false });
		await mapping("no-id-yet", {});
		await mapping("twice", { clerkOrgId: "org_TWICE1" });
		await mapping("twice", { clerkOrgId: "org_TWICE2" });
	});
}

const message = (tenantId: string | undefined, tenantOrgId?: string) => ({
	from: "seat-x",
	channel: "seat-y",
	content: "hello",
	createdAt: NOW,
	...(tenantId !== undefined ? { tenantId } : {}),
	...(tenantOrgId !== undefined ? { tenantOrgId } : {}),
});

const receipt = (
	messageId: Id<"messages">,
	tenantId: string | undefined,
	tenantOrgId?: string,
) => ({
	messageId,
	recipient: "seat-y",
	...(tenantId !== undefined ? { tenantId } : {}),
	...(tenantOrgId !== undefined ? { tenantOrgId } : {}),
});

type Ids = {
	okMsg: Id<"messages">;
	keptMsg: Id<"messages">;
	absentMsg: Id<"messages">;
	inactiveMsg: Id<"messages">;
	ambiguousMsg: Id<"messages">;
	noIdMsg: Id<"messages">;
	fleetMsg: Id<"messages">;
	okRcpt: Id<"messageReceipts">;
	keptRcpt: Id<"messageReceipts">;
	ghostRcpt: Id<"messageReceipts">;
	fleetRcpt: Id<"messageReceipts">;
};

// Messages: 1 resolvable, 1 already filled (ID DISAGREES with slug), 4 unresolvable,
// 1 without tenant. Receipts: 1 resolvable, 1 kept, 1 absent slug, 1 without tenant.
async function seedRows(t: T): Promise<Ids> {
	return await t.run(async (ctx) => {
		const ins = (tenant: string | undefined, id?: string) =>
			ctx.db.insert("messages", message(tenant, id));
		const okMsg = await ins("acme-hr");
		const keptMsg = await ins("acme-hr", "org_OTHER9");
		const absentMsg = await ins("ghost-org");
		const inactiveMsg = await ins("dormant");
		const ambiguousMsg = await ins("twice");
		const noIdMsg = await ins("no-id-yet");
		const fleetMsg = await ins(undefined);
		return {
			okMsg,
			keptMsg,
			absentMsg,
			inactiveMsg,
			ambiguousMsg,
			noIdMsg,
			fleetMsg,
			okRcpt: await ctx.db.insert("messageReceipts", receipt(okMsg, "acme-hr")),
			keptRcpt: await ctx.db.insert(
				"messageReceipts",
				receipt(okMsg, "acme-hr", "org_OTHER9"),
			),
			ghostRcpt: await ctx.db.insert(
				"messageReceipts",
				receipt(absentMsg, "ghost-org"),
			),
			fleetRcpt: await ctx.db.insert(
				"messageReceipts",
				receipt(fleetMsg, undefined),
			),
		};
	});
}

async function walk<R extends { done: boolean; cursor: string | null }>(
	step: (cursor: string | null) => Promise<R>,
): Promise<R[]> {
	const pages: R[] = [];
	let cursor: string | null = null;
	for (let i = 0; i < 50; i++) {
		const page = await step(cursor);
		pages.push(page);
		if (page.done) return pages;
		cursor = page.cursor;
	}
	throw new Error("walk did not finish");
}

const sum = <R,>(pages: R[], pick: (p: R) => number) =>
	pages.reduce((n, p) => n + pick(p), 0);

describe("tenantOrgIdCoverage:count", () => {
	test("(a) counts rows with and without tenantOrgId over several pages, counts only", async () => {
		const t = createT();
		await seedRows(t);
		const msgs = await walk((cursor) =>
			t.query(count, { table: "messages", cursor, pageSize: 3 }),
		);
		expect(msgs.length).toBeGreaterThan(1);
		expect(sum(msgs, (p) => p.withId)).toBe(1);
		expect(sum(msgs, (p) => p.withoutId)).toBe(6);
		const rcpts = await walk((cursor) =>
			t.query(count, { table: "messageReceipts", cursor, pageSize: 2 }),
		);
		expect(sum(rcpts, (p) => p.withId)).toBe(1);
		expect(sum(rcpts, (p) => p.withoutId)).toBe(3);
		expect(Object.keys(msgs[0]).sort()).toEqual(
			["cursor", "done", "examined", "table", "withId", "withoutId"].sort(),
		);
	});

	test("an empty table is a real zero, done in one page", async () => {
		const t = createT();
		const [page] = await walk((cursor) =>
			t.query(count, { table: "messageReceipts", cursor }),
		);
		expect(page).toMatchObject({ withId: 0, withoutId: 0, done: true });
	});

	test("rejects an out-of-range pageSize", async () => {
		const t = createT();
		await expect(
			t.query(count, { table: "messages", pageSize: 201 }),
		).rejects.toThrow(/out of expected range/);
	});
});

describe("tenantOrgIdCoverage:backfill", () => {
	test("(b) dry run (the default) writes nothing and reports the would-fill count", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedRows(t);
		const pages = await walk((cursor) =>
			t.mutation(backfill, { table: "messages", cursor }),
		);
		expect(pages.every((p) => p.dryRun)).toBe(true);
		expect(sum(pages, (p) => p.toFill)).toBe(1);
		expect(sum(pages, (p) => p.filled)).toBe(0);
		const row = await t.run((ctx) => ctx.db.get(ids.okMsg));
		expect(row?.tenantOrgId).toBeUndefined();
	});

	test("(c) fills the resolvable message; lists the four unresolvable by _id, unwritten; noSlug untouched", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedRows(t);
		const pages = await walk((cursor) =>
			t.mutation(backfill, {
				table: "messages",
				dryRun: false,
				cursor,
				pageSize: 2,
			}),
		);
		expect(sum(pages, (p) => p.filled)).toBe(1);
		expect(sum(pages, (p) => p.unresolved)).toBe(4);
		expect(sum(pages, (p) => p.noSlug)).toBe(1);
		expect(sum(pages, (p) => p.alreadyFilled)).toBe(1);
		const listed = pages.flatMap((p) => p.unresolvedIds);
		expect([...listed].sort()).toEqual(
			[ids.absentMsg, ids.inactiveMsg, ids.ambiguousMsg, ids.noIdMsg].sort(),
		);
		expect({
			absentSlug: sum(pages, (p) => p.unresolvedByReason.absentSlug),
			inactiveMapping: sum(pages, (p) => p.unresolvedByReason.inactiveMapping),
			ambiguousSlug: sum(pages, (p) => p.unresolvedByReason.ambiguousSlug),
			mappingHasNoClerkId: sum(
				pages,
				(p) => p.unresolvedByReason.mappingHasNoClerkId,
			),
		}).toEqual({
			absentSlug: 1,
			inactiveMapping: 1,
			ambiguousSlug: 1,
			mappingHasNoClerkId: 1,
		});
		await t.run(async (ctx) => {
			expect((await ctx.db.get(ids.okMsg))?.tenantOrgId).toBe("org_ACME1");
			expect((await ctx.db.get(ids.fleetMsg))?.tenantOrgId).toBeUndefined();
			for (const id of listed) {
				const row = await ctx.db.get(id as Id<"messages">);
				expect(row?.tenantOrgId).toBeUndefined();
			}
		});
	});

	test("receipts resolve from their own tenantId; a receipt without tenant is never invented an org", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedRows(t);
		const pages = await walk((cursor) =>
			t.mutation(backfill, {
				table: "messageReceipts",
				dryRun: false,
				cursor,
			}),
		);
		expect(sum(pages, (p) => p.filled)).toBe(1);
		expect(sum(pages, (p) => p.noSlug)).toBe(1);
		expect(pages.flatMap((p) => p.unresolvedIds)).toEqual([ids.ghostRcpt]);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(ids.okRcpt))?.tenantOrgId).toBe("org_ACME1");
			expect((await ctx.db.get(ids.fleetRcpt))?.tenantOrgId).toBeUndefined();
		});
	});

	test("the unresolved id list is capped, the count is not", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 0; i < 6; i++) {
				await ctx.db.insert("messages", message("ghost-org"));
			}
		});
		const [page] = await walk((cursor) =>
			t.mutation(backfill, { table: "messages", cursor, unresolvedIdCap: 2 }),
		);
		expect(page.unresolved).toBe(6);
		expect(page.unresolvedIds).toHaveLength(2);
	});

	test("(d) a second real run fills 0 and leaves the same rows unresolved", async () => {
		const t = createT();
		await seedMappings(t);
		await seedRows(t);
		const run = () =>
			walk((cursor) =>
				t.mutation(backfill, { table: "messages", dryRun: false, cursor }),
			);
		const first = await run();
		const second = await run();
		expect(sum(first, (p) => p.filled)).toBe(1);
		expect(sum(second, (p) => p.filled)).toBe(0);
		expect(sum(second, (p) => p.toFill)).toBe(0);
		expect(sum(second, (p) => p.unresolved)).toBe(4);
	});

	test("(e) never overwrites an existing tenantOrgId, even one that disagrees with the slug", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedRows(t);
		for (const table of ["messages", "messageReceipts"] as const) {
			await walk((cursor) =>
				t.mutation(backfill, { table, dryRun: false, cursor }),
			);
		}
		await t.run(async (ctx) => {
			expect((await ctx.db.get(ids.keptMsg))?.tenantOrgId).toBe("org_OTHER9");
			expect((await ctx.db.get(ids.keptRcpt))?.tenantOrgId).toBe("org_OTHER9");
		});
	});

	test("rejects an out-of-range pageSize and unresolvedIdCap", async () => {
		const t = createT();
		await expect(
			t.mutation(backfill, { table: "messages", pageSize: 0 }),
		).rejects.toThrow(/out of expected range/);
		await expect(
			t.mutation(backfill, { table: "messages", unresolvedIdCap: 501 }),
		).rejects.toThrow(/out of expected range/);
	});
});

// A slug is a label that can change hands. The backfill reads the CURRENT mapping, so a
// row stamped with a slug by its former holder must not take the new holder's ID.
describe("age check: a mapping newer than the row never resolves it", () => {
	const mappingRow = (slug: string, clerkOrgId: string) => ({
		clerkOrgSlug: slug,
		clerkOrgId,
		allowedOrchestrators: [],
		scopes: [],
		displayName: slug,
		isActive: true,
		createdAt: NOW,
	});

	test("(1) slug changed hands: rows created BEFORE the mapping are unwritten and listed", async () => {
		const t = createT();
		const ids = await t.run(async (ctx) => {
			const messageId = await ctx.db.insert("messages", message("reused-slug"));
			const receiptId = await ctx.db.insert(
				"messageReceipts",
				receipt(messageId, "reused-slug"),
			);
			await ctx.db.insert(
				"client_org_mapping",
				mappingRow("reused-slug", "org_NEWHOLDER1"),
			);
			return { messageId, receiptId };
		});
		const msgs = await walk((cursor) =>
			t.mutation(backfill, { table: "messages", dryRun: false, cursor }),
		);
		const rcpts = await walk((cursor) =>
			t.mutation(backfill, { table: "messageReceipts", dryRun: false, cursor }),
		);
		for (const pages of [msgs, rcpts]) {
			expect(sum(pages, (p) => p.filled)).toBe(0);
			expect(sum(pages, (p) => p.unresolved)).toBe(1);
			expect(sum(pages, (p) => p.unresolvedByReason.mappingNewerThanRow)).toBe(
				1,
			);
		}
		expect(msgs.flatMap((p) => p.unresolvedIds)).toEqual([ids.messageId]);
		expect(rcpts.flatMap((p) => p.unresolvedIds)).toEqual([ids.receiptId]);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(ids.messageId))?.tenantOrgId).toBeUndefined();
			expect((await ctx.db.get(ids.receiptId))?.tenantOrgId).toBeUndefined();
		});
	});

	test("(2) slug unchanged: rows created AFTER the mapping are written", async () => {
		const t = createT();
		const ids = await t.run(async (ctx) => {
			await ctx.db.insert(
				"client_org_mapping",
				mappingRow("steady-slug", "org_STEADY1"),
			);
			const messageId = await ctx.db.insert("messages", message("steady-slug"));
			const receiptId = await ctx.db.insert(
				"messageReceipts",
				receipt(messageId, "steady-slug"),
			);
			return { messageId, receiptId };
		});
		const msgs = await walk((cursor) =>
			t.mutation(backfill, { table: "messages", dryRun: false, cursor }),
		);
		const rcpts = await walk((cursor) =>
			t.mutation(backfill, { table: "messageReceipts", dryRun: false, cursor }),
		);
		expect(sum(msgs, (p) => p.filled)).toBe(1);
		expect(sum(rcpts, (p) => p.filled)).toBe(1);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(ids.messageId))?.tenantOrgId).toBe(
				"org_STEADY1",
			);
			expect((await ctx.db.get(ids.receiptId))?.tenantOrgId).toBe(
				"org_STEADY1",
			);
		});
	});

	test("a dry run counts the changed-hands row as unresolved, not toFill", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			await ctx.db.insert("messages", message("reused-slug"));
			await ctx.db.insert(
				"client_org_mapping",
				mappingRow("reused-slug", "org_NEWHOLDER1"),
			);
		});
		const [page] = await walk((cursor) =>
			t.mutation(backfill, { table: "messages", cursor }),
		);
		expect(page.toFill).toBe(0);
		expect(page.unresolved).toBe(1);
	});
});
