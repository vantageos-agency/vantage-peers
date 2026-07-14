/// <reference types="vite/client" />
/**
 * tenantOrgSeed + tenantSlug — derived tenant address tests.
 *
 * Covers:
 *   - RED: deriving a slug with no client_org_mapping row must fail closed.
 *   - GREEN: seeding creates one row; the slug derives stably from its `_id`.
 *   - IDEMPOTENCE (most important): replaying the seed creates no second row
 *     and never changes the existing `_id`.
 *   - FAIL-CLOSED: no document -> tenantSlug throws, never a default string.
 *
 * Fixture org identities are entirely fictitious ("acme-fictional",
 * "widgetco-fictional") — no real client name appears anywhere in this file.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { tenantSlug } from "../lib/tenantSlug";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

const FICTIONAL_ORG = {
	clerkOrgSlug: "acme-fictional",
	displayName: "Acme Fictional Corp",
	allowedOrchestrators: ["victor"],
	scopes: ["view-own-tasks", "view-own-missions"],
};

describe("tenantSlug — fail-closed derivation (RED before seed)", () => {
	test("throws when no client_org_mapping document exists for the org", async () => {
		const t = createT();

		const doc = await t.run(async (ctx) => {
			return await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) =>
					q.eq("clerkOrgSlug", FICTIONAL_ORG.clerkOrgSlug),
				)
				.first();
		});

		// RED: this is the state of the world today — no seed table entries,
		// so there is no `_id` to derive from.
		expect(doc).toBeNull();
		expect(() => tenantSlug(doc)).toThrowError(
			/cannot derive slug — no client_org_mapping document/,
		);
	});

	test("throws on undefined input, never returns a default slug", () => {
		expect(() => tenantSlug(undefined)).toThrowError(
			/cannot derive slug/,
		);
	});
});

describe("seedClientOrgMapping — GREEN: creates the row, slug derives", () => {
	test("seed creates exactly one document and the slug derives from its generated _id", async () => {
		const t = createT();

		const insertedId = await t.mutation(
			internal.tenantOrgSeed.seedClientOrgMapping,
			FICTIONAL_ORG,
		);

		const doc = await t.run(async (ctx) => {
			return await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) =>
					q.eq("clerkOrgSlug", FICTIONAL_ORG.clerkOrgSlug),
				)
				.collect();
		});

		expect(doc).toHaveLength(1);
		expect(doc[0]._id).toBe(insertedId);

		const slug = tenantSlug(doc[0]);
		// THE SLUG MUST BE A LEGAL ADDRESS, not merely a slice of an id.
		//
		// The first version of this assertion was `expect(slug).toBe("tenant-" + id.slice(0,12))`
		// — and it PASSED while producing `tenant-10000;client`, because the harness's id
		// alphabet contains `;`. The test did not merely miss the defect: it CERTIFIED it,
		// pinning a malformed namespace segment as the expected answer. An assertion that
		// restates the implementation cannot catch the implementation being wrong.
		//
		// So assert the PROPERTY the caller depends on — this string will become
		// `project/<slug>`, an address where client data is written and read.
		expect(slug).toMatch(/^tenant-[a-z0-9]{12}$/);

		// And assert it is DERIVED, not invented: same document, same slug, every time.
		const derivedAgain = tenantSlug(doc[0]);
		expect(derivedAgain).toBe(slug);
	});
});

describe("seedClientOrgMapping — IDEMPOTENCE (the decisive test)", () => {
	test("replaying the seed does not create a second row and does not change the _id", async () => {
		const t = createT();

		const firstId = await t.mutation(
			internal.tenantOrgSeed.seedClientOrgMapping,
			FICTIONAL_ORG,
		);
		const firstSlug = tenantSlug({ _id: firstId });

		// Replay the exact same seed call.
		const secondId = await t.mutation(
			internal.tenantOrgSeed.seedClientOrgMapping,
			FICTIONAL_ORG,
		);
		const secondSlug = tenantSlug({ _id: secondId });

		// Decisive assertions: same _id, same slug, exactly one row.
		expect(secondId).toBe(firstId);
		expect(secondSlug).toBe(firstSlug);

		const allRows = await t.run(async (ctx) => {
			return await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) =>
					q.eq("clerkOrgSlug", FICTIONAL_ORG.clerkOrgSlug),
				)
				.collect();
		});
		expect(allRows).toHaveLength(1);
	});

	test("seeding two distinct fictional orgs produces two distinct addresses, each idempotent", async () => {
		const t = createT();
		const orgB = {
			clerkOrgSlug: "widgetco-fictional",
			displayName: "WidgetCo Fictional",
			allowedOrchestrators: ["phi"],
			scopes: ["view-own-tasks"],
		};

		const idA1 = await t.mutation(
			internal.tenantOrgSeed.seedClientOrgMapping,
			FICTIONAL_ORG,
		);
		const idB1 = await t.mutation(
			internal.tenantOrgSeed.seedClientOrgMapping,
			orgB,
		);
		const idA2 = await t.mutation(
			internal.tenantOrgSeed.seedClientOrgMapping,
			FICTIONAL_ORG,
		);
		const idB2 = await t.mutation(
			internal.tenantOrgSeed.seedClientOrgMapping,
			orgB,
		);

		expect(idA1).toBe(idA2);
		expect(idB1).toBe(idB2);
		expect(idA1).not.toBe(idB1);
		expect(tenantSlug({ _id: idA1 })).not.toBe(tenantSlug({ _id: idB1 }));

		const total = await t.run(async (ctx) => {
			return await ctx.db.query("client_org_mapping").collect();
		});
		expect(total).toHaveLength(2);
	});
});
