/// <reference types="vite/client" />
//
// migrations/namespace_by_org_id, the upload tables: kbUploads.orgId and
// uploadTickets.orgId hold the org that owns an upload; rows written before the
// org-ID keying hold the slug. Pinned: inventory reports the pre-state first, the
// default dry run writes nothing, a real run rewrites mapped slugs to the Clerk org
// ID, an unmapped slug is refused and listed (never guessed), a second run writes
// nothing, readBack ends clean, and a migrated upload is then ingestible by its
// org through the ID-keyed doors. Hermetic. Fictitious identifiers only.

import type { FunctionReturnType } from "convex/server";
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
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const run = internal.migrations.namespace_by_org_id.run;
const inventory = internal.migrations.namespace_by_org_id.inventory;
const readBack = internal.migrations.namespace_by_org_id.readBack;
type RunResult = FunctionReturnType<typeof run>;

const NOW = 1_700_000_000_000;
const ACME = { slug: "acme-hr", id: "org_ACME1" };
const BETA = { slug: "beta-co", id: "org_BETA1" };

async function seedMappings(t: T): Promise<void> {
	await t.run(async (ctx) => {
		for (const o of [ACME, BETA]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: o.slug,
				clerkOrgId: o.id,
				allowedOrchestrators: ["seat-x"],
				scopes: ["view-own-tasks"],
				displayName: o.slug,
				isActive: true,
				createdAt: NOW,
			});
		}
	});
}

async function seedUploads(t: T) {
	return await t.run(async (ctx) => {
		const blob = async () => ctx.storage.store(new Blob(["x"]));
		const bind = async (orgId: string) =>
			ctx.db.insert("kbUploads", {
				storageId: await blob(),
				orgId,
				createdAt: NOW,
			});
		const ticket = (orgId: string, n: string) =>
			ctx.db.insert("uploadTickets", {
				ticketHash: `hash-${n}`,
				orgId,
				contentSha256: "0".repeat(64),
				createdAt: NOW,
				expiresAt: NOW + 900_000,
			});
		return {
			acmeUpload: await bind(ACME.slug),
			byIdUpload: await bind(ACME.id),
			ghostUpload: await bind("ghost-org"),
			acmeTicket: await ticket(ACME.slug, "1"),
			betaTicket: await ticket(BETA.slug, "2"),
			ghostTicket: await ticket("ghost-org", "3"),
		};
	});
}

const orgOf = (t: T, table: "kbUploads" | "uploadTickets", id: string) =>
	t.run(async (ctx) => {
		const doc = (await ctx.db.get(table, id as never)) as unknown as {
			orgId: string;
		};
		return doc.orgId;
	});

async function walk(
	t: T,
	table: "kbUploads" | "uploadTickets",
	dryRun: boolean,
) {
	const total = {
		alreadyById: 0,
		toRewrite: 0,
		rewritten: 0,
		unmappedRows: [] as RunResult["unmappedRows"],
	};
	let cursor: string | null = null;
	for (let guard = 0; guard < 100; guard++) {
		const r: RunResult = await t.mutation(run, {
			table,
			dryRun,
			cursor,
			pageSize: 2,
		});
		total.alreadyById += r.alreadyById;
		total.toRewrite += r.toRewrite;
		total.rewritten += r.rewritten;
		total.unmappedRows.push(...r.unmappedRows);
		if (r.isDone) return total;
		cursor = r.nextCursor;
	}
	throw new Error("walk did not terminate");
}

describe("namespace_by_org_id - kbUploads and uploadTickets", () => {
	test("inventory reports the pre-state per table and writes nothing", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedUploads(t);
		const inv = await t.query(inventory, { table: "kbUploads" });
		const forms = Object.fromEntries(inv.bySegment.map((s) => [s.segment, s.form]));
		expect(forms).toEqual({
			[ACME.slug]: "slug",
			[ACME.id]: "id",
			"ghost-org": "unmapped",
		});
		expect(inv.unmappedRows.map((u) => u.segment)).toEqual(["ghost-org"]);
		expect(await orgOf(t, "kbUploads", ids.acmeUpload)).toBe(ACME.slug);
	});

	test("DRY RUN (the default) counts and writes nothing", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedUploads(t);
		const r = await t.mutation(run, { table: "uploadTickets" });
		expect(r.dryRun).toBe(true);
		expect(r.toRewrite).toBe(2);
		expect(r.rewritten).toBe(0);
		expect(await orgOf(t, "uploadTickets", ids.acmeTicket)).toBe(ACME.slug);
	});

	test("REAL RUN rewrites mapped slugs to the ID; an unmapped slug is refused and listed", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedUploads(t);

		const kb = await walk(t, "kbUploads", false);
		expect(kb).toMatchObject({ rewritten: 1, alreadyById: 1 });
		expect(kb.unmappedRows.map((u) => u.segment)).toEqual(["ghost-org"]);
		expect(await orgOf(t, "kbUploads", ids.acmeUpload)).toBe(ACME.id);
		expect(await orgOf(t, "kbUploads", ids.byIdUpload)).toBe(ACME.id);
		expect(await orgOf(t, "kbUploads", ids.ghostUpload)).toBe("ghost-org");

		const tk = await walk(t, "uploadTickets", false);
		expect(tk.rewritten).toBe(2);
		expect(tk.unmappedRows.map((u) => u.segment)).toEqual(["ghost-org"]);
		expect(await orgOf(t, "uploadTickets", ids.acmeTicket)).toBe(ACME.id);
		expect(await orgOf(t, "uploadTickets", ids.betaTicket)).toBe(BETA.id);
		expect(await orgOf(t, "uploadTickets", ids.ghostTicket)).toBe("ghost-org");
	});

	test("IDEMPOTENT and READ-BACK: a second run writes nothing; readBack is clean once the refused row is gone", async () => {
		const t = createT();
		await seedMappings(t);
		const ids = await seedUploads(t);
		await walk(t, "kbUploads", false);
		const again = await walk(t, "kbUploads", false);
		expect(again.rewritten).toBe(0);

		const before = await t.query(readBack, { table: "kbUploads" });
		expect(before.clean).toBe(false);
		expect(before.unmapped).toBe(1);

		await t.run(async (ctx) => ctx.db.delete("kbUploads", ids.ghostUpload));
		const after = await t.query(readBack, { table: "kbUploads" });
		expect(after).toMatchObject({ clean: true, remainingOnSlug: 0, unmapped: 0 });
	});

	test("a migrated slug-keyed upload is then ingestible by its org through the ID-keyed door", async () => {
		const t = createT();
		await seedMappings(t);
		const storageId: Id<"_storage"> = await t.run(async (ctx) => {
			const sid = await ctx.storage.store(new Blob(["x"]));
			await ctx.db.insert("kbUploads", {
				storageId: sid,
				orgId: ACME.slug,
				createdAt: NOW,
			});
			return sid;
		});
		await expect(
			t.mutation(internal.kbMutations.bindOrAssertStorageOwnership, {
				storageId,
				orgId: ACME.id,
			}),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
		await walk(t, "kbUploads", false);
		await t.mutation(internal.kbMutations.bindOrAssertStorageOwnership, {
			storageId,
			orgId: ACME.id,
		});
		await expect(
			t.mutation(internal.kbMutations.bindOrAssertStorageOwnership, {
				storageId,
				orgId: BETA.id,
			}),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
	});
});
