/// <reference types="vite/client" />
/**
 * Module M10a: rows written before memories carried their org's permanent ID
 * are stamped by migrations/backfill_memories_org_clerk_id (never guessed), and
 * the internal writers that file rows under a team namespace stamp them.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);

const row = (namespace: string, clerkOrgId?: string) => ({
	namespace,
	type: "project" as const,
	content: namespace,
	createdBy: "x",
	relations: [],
	isLatest: true,
	createdAt: 1,
	updatedAt: 1,
	...(clerkOrgId === undefined ? {} : { clerkOrgId }),
});

async function seed() {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		const mapping = (slug: string, withId: boolean) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				...(withId ? { clerkOrgId: testClerkOrgId(slug) } : {}),
				allowedOrchestrators: [],
				scopes: [],
				displayName: slug,
				isActive: true,
				createdAt: 1,
			});
		await mapping("acme", true);
		await mapping("no-id-yet", false);
		await ctx.db.insert("memories", row("team/acme"));
		await ctx.db.insert("memories", row("team/acme/notes"));
		await ctx.db.insert("memories", row("team/acme", testClerkOrgId("acme")));
		await ctx.db.insert("memories", row("team/ghost"));
		await ctx.db.insert("memories", row("team/no-id-yet"));
		await ctx.db.insert("memories", row("global"));
	});
	return t;
}

describe("backfill_memories_org_clerk_id", () => {
	test("a dry run (the default) writes nothing and reports what it would stamp and what it cannot decide", async () => {
		const t = await seed();
		const res = await t.mutation(
			internal.migrations.backfill_memories_org_clerk_id.run,
			{},
		);
		expect(res).toMatchObject({
			dryRun: true,
			alreadyFilled: 1,
			fleetRow: 1,
			toFill: 2,
			filled: 0,
			isDone: true,
		});
		expect(res.undecidable.map((u) => `${u.label}:${u.reason}`).sort()).toEqual([
			"ghost:not-mapped",
			"no-id-yet:id-not-filled",
		]);
		const unstamped = await t.run(async (ctx) =>
			(await ctx.db.query("memories").collect()).filter(
				(m) => m.clerkOrgId === undefined,
			),
		);
		expect(unstamped).toHaveLength(5);
	});

	test("a real run stamps only the decidable team rows, and a second run is a no-op", async () => {
		const t = await seed();
		const res = await t.mutation(
			internal.migrations.backfill_memories_org_clerk_id.run,
			{ dryRun: false },
		);
		expect(res.filled).toBe(2);
		const rows = await t.run((ctx) => ctx.db.query("memories").collect());
		const stamp = (ns: string) =>
			rows.filter((m) => m.namespace === ns).map((m) => m.clerkOrgId);
		expect(stamp("team/acme")).toEqual([
			testClerkOrgId("acme"),
			testClerkOrgId("acme"),
		]);
		expect(stamp("team/acme/notes")).toEqual([testClerkOrgId("acme")]);
		expect(stamp("team/ghost")).toEqual([undefined]);
		expect(stamp("team/no-id-yet")).toEqual([undefined]);
		expect(stamp("global")).toEqual([undefined]);
		const again = await t.mutation(
			internal.migrations.backfill_memories_org_clerk_id.run,
			{ dryRun: false },
		);
		expect(again.filled).toBe(0);
	});

	test("a pageSize outside 1-500 is refused", async () => {
		const t = await seed();
		await expect(
			t.mutation(internal.migrations.backfill_memories_org_clerk_id.run, {
				pageSize: 0,
			}),
		).rejects.toThrow(/out of expected range/);
	});
});

describe("internal writers stamp a team row", () => {
	test("kbMutations.insertChunk stamps the org of the team namespace, none for a fleet namespace", async () => {
		const t = await seed();
		const team = await t.mutation(internal.kbMutations.insertChunk, {
			namespace: "team/acme/doc-1",
			content: "chunk",
			filename: "f.txt",
			mimeType: "text/plain",
			chunkIndex: 0,
			storageId: "s",
			docId: "d",
		});
		const fleet = await t.mutation(internal.kbMutations.insertChunk, {
			namespace: "global",
			content: "chunk",
			filename: "f.txt",
			mimeType: "text/plain",
			chunkIndex: 0,
			storageId: "s",
			docId: "d",
		});
		expect((await t.run((ctx) => ctx.db.get(team)))?.clerkOrgId).toBe(
			testClerkOrgId("acme"),
		);
		expect((await t.run((ctx) => ctx.db.get(fleet)))?.clerkOrgId).toBeUndefined();
	});
});
