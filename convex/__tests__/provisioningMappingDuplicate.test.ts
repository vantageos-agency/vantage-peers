/// <reference types="vite/client" />
//
// Two client_org_mapping rows sharing one label make the organisation
// undecidable. Every provisioning instrument must RAISE, not read the first row
// and not read the label as unmapped (which would create a third row).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")),
);

const createT = () => convexTest(schema, modules);

async function seedDuplicate(t: ReturnType<typeof createT>, slug: string) {
	await t.run(async (ctx) => {
		for (let i = 0; i < 2; i++) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: ["pi"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

describe("provisioning label shared by two mapping rows", () => {
	test("setOrgKind raises", async () => {
		const t = createT();
		await seedDuplicate(t, "twin-org");
		await expect(
			t.mutation(internal.clientOrgMapping.setOrgKind, {
				clerkOrgSlug: "twin-org",
				orgKind: "client",
			}),
		).rejects.toThrow(/ORG_MAPPING_(AMBIGUOUS|UNREADABLE)/);
	});

	test("seedClientOrgMapping raises and creates no third row", async () => {
		const t = createT();
		await seedDuplicate(t, "twin-org");
		await expect(
			t.mutation(internal.tenantOrgSeed.seedClientOrgMapping, {
				clerkOrgSlug: "twin-org",
				displayName: "Twin",
				allowedOrchestrators: ["pi"],
				scopes: ["view-own-tasks"],
			}),
		).rejects.toThrow(/ORG_MAPPING_(AMBIGUOUS|UNREADABLE)/);
		const rows = await t.run(async (ctx) =>
			ctx.db.query("client_org_mapping").collect(),
		);
		expect(rows).toHaveLength(2);
	});
});
