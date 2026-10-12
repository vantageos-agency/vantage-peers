/// <reference types="vite/client" />
//
// CR-2 / R-53 lot C: `client_org_mapping` is read through ONE adapter
// (convex/lib/authOrgMapping.ts, `readMappings`) and nowhere else. The two
// internal fill instruments in clientOrgMapping.ts (`listMappingsForClerkIdFill`,
// `setClerkOrgId`) used to open their own `.query("client_org_mapping")`; they now
// read through the adapter.
//
// Two poles:
//   1. SOURCE: clientOrgMapping.ts opens no query on the table; the adapter
//      exports the two reads those instruments need.
//   2. BEHAVIOUR (unchanged by the move): the list includes inactive rows and
//      carries `orgKind` defaulted to "client"; `setClerkOrgId` refuses an id
//      that another row already holds, even when two rows already share it.
// Hermetic: no deployment is touched. Fictitious identifiers only.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync"),
	),
);
const NOW = 1_700_000_000_000;
const here = dirname(fileURLToPath(import.meta.url));
const source = (rel: string) => readFileSync(join(here, rel), "utf8");

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

async function seed(t: T) {
	await t.run(async (ctx) => {
		const row = (slug: string, extra: Record<string, unknown> = {}) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: ["seat-x"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...extra,
			});
		await row("org-a", { clerkOrgId: "org_AAA1" });
		await row("org-inactive", { isActive: false });
		await row("dup-1", { clerkOrgId: "org_DUP1" });
		await row("dup-2", { clerkOrgId: "org_DUP1" });
		await row("fresh");
	});
}

describe("client_org_mapping is read through the adapter only", () => {
	test("source: clientOrgMapping.ts opens no query on the table", () => {
		const src = source("../clientOrgMapping.ts");
		expect(src).not.toMatch(/\.query\(\s*["']client_org_mapping["']\s*\)/);
	});

	test("source: the adapter exports the two reads the fill instruments use", () => {
		const src = source("../lib/authOrgMapping.ts");
		expect(src).toMatch(/export async function orgMappingRowsForClerkOrgId\b/);
		expect(src).toMatch(/export async function listOrgMappings\b/);
	});
});

describe("fill instruments keep their behaviour", () => {
	test("listMappingsForClerkIdFill lists every row, inactive included, orgKind defaulted", async () => {
		const t = createT();
		await seed(t);
		const rows = await t.query(
			internal.clientOrgMapping.listMappingsForClerkIdFill,
			{},
		);
		expect(rows).toHaveLength(5);
		const bySlug = new Map(rows.map((r) => [r.clerkOrgSlug, r]));
		expect(bySlug.get("org-inactive")).toMatchObject({
			isActive: false,
			clerkOrgId: null,
			orgKind: "client",
		});
		expect(bySlug.get("org-a")?.clerkOrgId).toBe("org_AAA1");
	});

	test("setClerkOrgId refuses an id another row holds, also when two rows already share it", async () => {
		const t = createT();
		await seed(t);
		const set = internal.clientOrgMapping.setClerkOrgId;
		await expect(
			t.mutation(set, { clerkOrgSlug: "fresh", clerkOrgId: "org_AAA1" }),
		).rejects.toThrow(/CLERK_ORG_ID_TAKEN/);
		await expect(
			t.mutation(set, { clerkOrgSlug: "fresh", clerkOrgId: "org_DUP1" }),
		).rejects.toThrow(/CLERK_ORG_ID_TAKEN/);
		const ok = await t.mutation(set, {
			clerkOrgSlug: "fresh",
			clerkOrgId: "org_FRESH1",
		});
		expect(ok).toEqual({
			clerkOrgSlug: "fresh",
			previous: null,
			current: "org_FRESH1",
		});
	});
});
