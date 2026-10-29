/// <reference types="vite/client" />
/**
 * lookupOrgMapping keyed by a slug answers exactly one row or null, like the
 * Clerk-org-ID key: two rows claiming one slug make the org undecidable, so the
 * lookup fails closed instead of serving the first row. Creation refuses a taken
 * slug (`slug-already-mapped`), but nothing else stops two rows existing at read
 * time (direct insert, import, race), so the read refuses too.
 *
 * Door under test: clientOrgMapping:getByClerkSlug (service-account caller),
 * which resolves the org through lookupOrgMapping(ctx, slug).
 * Poles: AMBIGUOUS (two rows) -> null; SINGLE row -> served; ABSENT -> null.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { api } from "../_generated/api";
import { requireOperatorAdminToCreateOrg } from "../lib/auth";
import schema from "../schema";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);


const createT = () => convexTest(schema, modules);
const asServiceAccount = (t: ReturnType<typeof createT>) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function seed(
	t: ReturnType<typeof createT>,
	slug: string,
	clerkOrgId: string,
	scopes: string[],
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId,
			allowedOrchestrators: ["seat"],
			scopes,
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

describe("slug lookup fails closed on two rows", () => {
	test("AMBIGUOUS: two rows with one slug resolve to null, not the first row", async () => {
		const t = createT();
		await seed(t, "dup-org", "org_first", ["view-own-tasks"]);
		await seed(t, "dup-org", "org_second", ["view-own-missions"]);
		const result = await asServiceAccount(t).query(
			api.clientOrgMapping.getByClerkSlug,
			{ orgSlug: "dup-org" },
		);
		expect(result).toBeNull();
	});

	test("SINGLE row: still served (unchanged)", async () => {
		const t = createT();
		await seed(t, "solo-org", "org_solo", ["view-own-tasks"]);
		await seed(t, "other-org", "org_other", ["view-own-missions"]);
		const result = await asServiceAccount(t).query(
			api.clientOrgMapping.getByClerkSlug,
			{ orgSlug: "solo-org" },
		);
		expect(result).toEqual({
			allowedOrchestrators: ["seat"],
			scopes: ["view-own-tasks"],
			isActive: true,
		});
	});

	test("ABSENT: unknown slug is null", async () => {
		const t = createT();
		const result = await asServiceAccount(t).query(
			api.clientOrgMapping.getByClerkSlug,
			{ orgSlug: "nobody" },
		);
		expect(result).toBeNull();
	});
});

// A door that reads null as "no such org -> free to create" must not turn the
// fail-closed null of an ambiguous slug into permission to mint a third row.
describe("operator create-org door on an ambiguous slug", () => {
	const OP = "ambig-operator-org";
	const operatorAdmin = {
		subject: "op-admin",
		org_slug: OP,
		org_id: testClerkOrgId(OP),
		org_role: "org:admin",
	} as Parameters<ReturnType<typeof createT>["withIdentity"]>[0];

	async function seedOperator(t: ReturnType<typeof createT>) {
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: OP,
				clerkOrgId: testClerkOrgId(OP),
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: OP,
				isActive: true,
				createdAt: Date.now(),
				orgKind: "operator",
			});
		});
	}

	test("AMBIGUOUS target slug: creation is refused slug-already-mapped", async () => {
		const t = createT();
		await seedOperator(t);
		await seed(t, "dup-target", "org_a", ["view-own-tasks"]);
		await seed(t, "dup-target", "org_b", ["view-own-tasks"]);
		await t.withIdentity(operatorAdmin).run(async (ctx) => {
			await expect(
				requireOperatorAdminToCreateOrg(ctx, "dup-target"),
			).rejects.toThrow(/slug-already-mapped/);
		});
	});

	test("FREE target slug: creation is still allowed", async () => {
		const t = createT();
		await seedOperator(t);
		await t.withIdentity(operatorAdmin).run(async (ctx) => {
			const r = await requireOperatorAdminToCreateOrg(ctx, "brand-new");
			expect(r.subject).toBe("op-admin");
		});
	});
});
