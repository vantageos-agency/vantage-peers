/// <reference types="vite/client" />
/**
 * Task k179y0wpsd6fv7055f4p2w6b358hdrxe (from Eta's review of #1639) — GitHub
 * owner bindings belong to an organisation by its PERMANENT ID, never by its
 * slug.
 *
 * Slug takeover: org Y held the slug "acme", bound the GitHub owner
 * "acme-gh", then renamed itself "acme-old"; org X now holds "acme". The
 * binding row still says `orgId: "acme"` (a label) and `clerkOrgId: <Y>`.
 * Poles:
 *   - listBindings: X (a Clerk member, and the service account acting for X)
 *     never sees Y's binding; Y, renamed, still sees its own; the fleet sees all.
 *   - listUnprovenMappings (fleet-only): X's repo mapping under "acme" whose
 *     owner is bound to Y is reported `owner-bound-to-another-org`, although the
 *     two slugs are equal.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const X_ID = testClerkOrgId("org-x-taker");
const Y_ID = testClerkOrgId("org-y-former");

async function seed(t: T): Promise<void> {
	await t.run(async (ctx) => {
		for (const [slug, id] of [
			["acme", X_ID],
			["acme-old", Y_ID],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
			});
		}
		await ctx.db.insert("githubOwnerBindings", {
			owner: "acme-gh",
			orgId: "acme",
			clerkOrgId: Y_ID,
			installationId: 7,
			accountType: "Organization",
			githubUserLogin: "y-admin",
			boundBy: "y-admin-subject",
			boundAt: 1,
			active: true,
		});
		await ctx.db.insert("githubRepoMapping", {
			repo: "acme-gh/site",
			orchestrator: "sigma",
			project: "site",
			active: true,
			orgId: "acme",
			clerkOrgId: X_ID,
		});
	});
}

const member = (t: T, slug: string, id: string) =>
	t.withIdentity({
		subject: `member-of-${slug}`,
		organizationSlug: slug,
		org_id: id,
	} as Parameters<T["withIdentity"]>[0]);
const service = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

describe("githubOwnerBinding:listBindings is keyed by the permanent org ID", () => {
	test("the org that took over the slug never sees the former holder's binding", async () => {
		const t = createT();
		await seed(t);
		const asX = await member(t, "acme", X_ID).query(api.githubOwnerBinding.listBindings, {});
		expect(asX.items).toEqual([]);
		const acting = await service(t).query(api.githubOwnerBinding.listBindings, {
			__actingOrg: X_ID,
		} as never);
		expect((acting as { items: unknown[] }).items).toEqual([]);
	});

	test("the former holder, renamed, still sees its own binding; the fleet sees it", async () => {
		const t = createT();
		await seed(t);
		const asY = await member(t, "acme-old", Y_ID).query(api.githubOwnerBinding.listBindings, {});
		expect(asY.items.map((b) => b.owner)).toEqual(["acme-gh"]);
		const fleet = await service(t).query(api.githubOwnerBinding.listBindings, {});
		expect(fleet.items.map((b) => b.owner)).toEqual(["acme-gh"]);
	});
});

describe("githubOwnerBinding:listUnprovenMappings compares the binding and the mapping by ID", () => {
	test("equal slugs, different orgs: the mapping is reported owner-bound-to-another-org", async () => {
		const t = createT();
		await seed(t);
		const out = await service(t).query(api.githubOwnerBinding.listUnprovenMappings, {});
		expect(out.items).toEqual([
			{ repo: "acme-gh/site", orgId: "acme", project: "site", reason: "owner-bound-to-another-org" },
		]);
	});
});
