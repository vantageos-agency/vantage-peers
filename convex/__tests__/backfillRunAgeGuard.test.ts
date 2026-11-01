/// <reference types="vite/client" />
//
// Task k17b1whfjp65w379sgvpg5gypn8hdsm0 [ROOT-FIX]. `backfill_org_clerk_id:run` fills a
// permanent org ID from a slug through the CURRENT client_org_mapping. A slug is a label
// that can change hands: a mapping created AFTER the row is not the org that stamped it,
// and writing its ID onto the row hands the former holder's data to the new holder.
// The sibling coverage modules already carry the AGE CHECK; this pins `run` to it, in
// both directions, and sweeps the source so a future unguarded writer fails.
// Hermetic: no deployment is touched. Fictitious identifiers only.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const run = internal.migrations.backfill_org_clerk_id.run;
const NOW = 1_700_000_000_000;

const mapping = (slug: string, clerkOrgId: string, isActive = true) => ({
	clerkOrgSlug: slug,
	clerkOrgId,
	allowedOrchestrators: [],
	scopes: [],
	displayName: slug,
	isActive,
	createdAt: NOW,
});
const mission = (orgId: string, name: string) => ({
	name,
	project: "p",
	status: "execute" as const,
	priority: "medium" as const,
	pilot: "x",
	agents: [],
	createdBy: "seat-x",
	orgId,
	createdAt: NOW,
	updatedAt: NOW,
});

describe("backfill_org_clerk_id:run age check", () => {
	test("(1) slug changed hands: a row created BEFORE the mapping is unwritten and listed", async () => {
		const t = convexTest(schema, modules);
		const rowId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("missions", mission("reused", "old"));
			await ctx.db.insert(
				"client_org_mapping",
				mapping("reused", "org_NEWHOLDER1"),
			);
			return id;
		});
		const r = await t.mutation(run, { table: "missions", dryRun: false });
		expect(r.filled).toBe(0);
		expect(r.toFill).toBe(0);
		expect(r.undecidableRows).toEqual([
			{ id: rowId, slug: "reused", reason: "mappingNewerThanRow" },
		]);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(rowId))?.clerkOrgId).toBeUndefined();
		});
	});

	test("(2) slug unchanged: a row created AFTER the mapping is written", async () => {
		const t = convexTest(schema, modules);
		const rowId = await t.run(async (ctx) => {
			await ctx.db.insert(
				"client_org_mapping",
				mapping("steady", "org_STEADY1"),
			);
			return await ctx.db.insert("missions", mission("steady", "new"));
		});
		const r = await t.mutation(run, { table: "missions", dryRun: false });
		expect(r.filled).toBe(1);
		expect(r.undecidableRows).toEqual([]);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(rowId))?.clerkOrgId).toBe("org_STEADY1");
		});
	});

	test("(3) an INACTIVE mapping never resolves a row (same requirement as the coverage modules)", async () => {
		const t = convexTest(schema, modules);
		const rowId = await t.run(async (ctx) => {
			await ctx.db.insert(
				"client_org_mapping",
				mapping("dormant", "org_DORM1", false),
			);
			return await ctx.db.insert("missions", mission("dormant", "d"));
		});
		const r = await t.mutation(run, { table: "missions", dryRun: false });
		expect(r.filled).toBe(0);
		expect(r.undecidableRows).toEqual([
			{ id: rowId, slug: "dormant", reason: "inactiveMapping" },
		]);
	});
});

// A future writer that resolves a slug without the age check fails here. The only caller
// of the raw `resolveSlug(` outside tests is the guarded helper; every writer goes
// through `resolveSlugForRow(`.
describe("sweep: every non-test resolveSlug( caller that writes is guarded", () => {
	const SRC = "convex/migrations/backfill_org_clerk_id.ts";
	const hits = execFileSync(
		"git",
		["grep", "-n", "resolveSlug(", "--", "convex", ":!convex/__tests__"],
		{ encoding: "utf8" },
	)
		.split("\n")
		.filter(Boolean)
		.filter((l) => !l.includes("function resolveSlug("));

	test("raw resolveSlug( is called only inside resolveSlugForRow", () => {
		const text = readFileSync(SRC, "utf8");
		const start = text.indexOf("function resolveSlugForRow(");
		expect(start).toBeGreaterThan(-1);
		const body = text.slice(start, text.indexOf("\n}\n", start));
		expect(body).toContain("_creationTime");
		expect(body).toContain("isActive");
		expect(body).toContain("resolveSlug(");
		for (const h of hits) {
			const [file] = h.split(":");
			const call = h.split(":").slice(2).join(":");
			expect(file, `unguarded raw caller: ${h}`).toBe(SRC);
			expect(body, `unguarded raw caller: ${h}`).toContain(call.trim());
		}
	});

	test("every writer module calls resolveSlugForRow(", () => {
		for (const f of [
			SRC,
			"convex/migrations/clerkOrgIdCoverage.ts",
			"convex/migrations/tenantOrgIdCoverage.ts",
		]) {
			const text = readFileSync(f, "utf8");
			const calls = text
				.split("\n")
				.filter(
					(l) => l.includes("resolveSlugForRow(") && !l.includes("function "),
				);
			expect(calls.length, f).toBeGreaterThan(0);
		}
	});
});
