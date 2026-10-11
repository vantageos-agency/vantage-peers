/// <reference types="vite/client" />
/**
 * orgMembership:getMembership — two poles, by organisation ID.
 *
 * Property: "who belongs to org X" is answered for the organisation X NAMES BY ID.
 * The argument is a slug (a label); the caller's own org and the stored rows are
 * compared by the permanent Clerk org ID, so a renamed org keeps its members and a
 * new org that takes a freed slug reads none of the old org's rows.
 *
 *   SERVED   a member of org A reading org A; the fleet service account reading any org
 *   REFUSED  a member of org A reading org B; anonymous; a new org on a freed slug
 *   ABSENT   an org with no membership rows is an empty SUCCESS, not a refusal
 */
import { convexTest } from "../../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../../tests/fixtures/testClerkOrgId";
import { api } from "../../_generated/api";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const NOW = 1_700_000_000_000;
const SERVICE_ACCOUNT = "test-service-account-user-id";

async function seedOrg(t: T, slug: string, orgId = testClerkOrgId(slug)) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: orgId,
			allowedOrchestrators: ["seat"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: NOW,
		});
	});
}

/** A membership row as it is stored: stamped with a label AND the permanent ID. */
async function seedMember(
	t: T,
	stampedSlug: string,
	orgId: string | undefined,
	userId: string,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("orgMembership", {
			clerkOrgSlug: stampedSlug,
			...(orgId !== undefined ? { clerkOrgId: orgId } : {}),
			clerkUserId: userId,
			role: "admin",
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
}

const member = (subject: string, slugClaim: string, orgId: string): Identity =>
	({
		subject,
		org_slug: slugClaim,
		org_id: orgId,
		org_role: "org:member",
	}) as Identity;

describe("getMembership — SERVED", () => {
	test("a member of org A reads org A's members", async () => {
		const t = createT();
		await seedOrg(t, "mem-a");
		await seedMember(t, "mem-a", testClerkOrgId("mem-a"), "u-admin-a");
		const rows = await t
			.withIdentity(member("u-a", "mem-a", testClerkOrgId("mem-a")))
			.query(api.orgMembership.getMembership, { clerkOrgSlug: "mem-a" });
		expect(rows.map((r) => r.clerkUserId)).toEqual(["u-admin-a"]);
	});

	test("a member of a renamed org still reads its members (stale label on the rows)", async () => {
		const t = createT();
		await seedOrg(t, "mem-renamed-now", "org_MemRenamed");
		await seedMember(t, "mem-renamed-before", "org_MemRenamed", "u-admin-r");
		const rows = await t
			.withIdentity(member("u-r", "mem-renamed-before", "org_MemRenamed"))
			.query(api.orgMembership.getMembership, {
				clerkOrgSlug: "mem-renamed-now",
			});
		expect(rows.map((r) => r.clerkUserId)).toEqual(["u-admin-r"]);
	});

	test("the fleet service account reads any org's members, by that org's ID", async () => {
		const t = createT();
		await seedOrg(t, "mem-svc", "org_MemSvc");
		await seedMember(t, "mem-svc-old-label", "org_MemSvc", "u-admin-svc");
		const tSvc = t.withIdentity({ subject: SERVICE_ACCOUNT } as Identity);
		const rows = await tSvc.query(api.orgMembership.getMembership, {
			clerkOrgSlug: "mem-svc",
		});
		expect(rows.map((r) => r.clerkUserId)).toEqual(["u-admin-svc"]);
	});

	test("the caller's own memberships are read by its verified subject", async () => {
		const t = createT();
		await seedOrg(t, "mem-self");
		await seedMember(t, "mem-self", testClerkOrgId("mem-self"), "u-self");
		const rows = await t
			.withIdentity(member("u-self", "mem-self", testClerkOrgId("mem-self")))
			.query(api.orgMembership.getMembership, {});
		expect(rows.map((r) => r.clerkOrgSlug)).toEqual(["mem-self"]);
	});
});

describe("getMembership — REFUSED", () => {
	test("a member of org A cannot list org B's members", async () => {
		const t = createT();
		await seedOrg(t, "mem-x");
		await seedOrg(t, "mem-y");
		await seedMember(t, "mem-y", testClerkOrgId("mem-y"), "u-admin-y");
		await expect(
			t
				.withIdentity(member("u-x", "mem-x", testClerkOrgId("mem-x")))
				.query(api.orgMembership.getMembership, { clerkOrgSlug: "mem-y" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("a NEW org that took a freed slug reads none of the old org's members", async () => {
		const t = createT();
		// Org OLD was renamed to "mem-old-now"; its member rows still carry the stale
		// label "mem-freed". Org NEW (another ID) now holds the slug "mem-freed".
		await seedOrg(t, "mem-old-now", "org_MemOld");
		await seedMember(t, "mem-freed", "org_MemOld", "u-admin-old");
		await seedOrg(t, "mem-freed", "org_MemNew");
		const rows = await t
			.withIdentity(member("u-new", "mem-freed", "org_MemNew"))
			.query(api.orgMembership.getMembership, { clerkOrgSlug: "mem-freed" });
		expect(rows).toEqual([]);
	});

	test("a session on a freed slug but an unmapped org ID is refused outright", async () => {
		const t = createT();
		await seedOrg(t, "mem-freed2", "org_MemOld2");
		await seedMember(t, "mem-freed2", "org_MemOld2", "u-admin-old2");
		await expect(
			t
				.withIdentity(member("u-attacker", "mem-freed2", "org_NotMapped"))
				.query(api.orgMembership.getMembership, { clerkOrgSlug: "mem-freed2" }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("anonymous is refused before any row is read, on both directions", async () => {
		const t = createT();
		await seedOrg(t, "mem-anon");
		await expect(
			t.query(api.orgMembership.getMembership, { clerkOrgSlug: "mem-anon" }),
		).rejects.toThrow(/RBAC_DENIED/);
		await expect(
			t.query(api.orgMembership.getMembership, {}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("a legacy row stamped with a label only (no org ID) is not served to a member", async () => {
		const t = createT();
		await seedOrg(t, "mem-legacy");
		await seedMember(t, "mem-legacy", undefined, "u-legacy");
		const rows = await t
			.withIdentity(member("u-m", "mem-legacy", testClerkOrgId("mem-legacy")))
			.query(api.orgMembership.getMembership, { clerkOrgSlug: "mem-legacy" });
		expect(rows).toEqual([]);
	});
});

describe("getMembership — ABSENT", () => {
	test("an org with no membership rows is an empty success for its own member", async () => {
		const t = createT();
		await seedOrg(t, "mem-empty");
		const rows = await t
			.withIdentity(member("u-e", "mem-empty", testClerkOrgId("mem-empty")))
			.query(api.orgMembership.getMembership, { clerkOrgSlug: "mem-empty" });
		expect(rows).toEqual([]);
	});

	test("the service account asking about an unmapped slug gets an empty success", async () => {
		const t = createT();
		const rows = await t
			.withIdentity({ subject: SERVICE_ACCOUNT } as Identity)
			.query(api.orgMembership.getMembership, { clerkOrgSlug: "mem-nothing" });
		expect(rows).toEqual([]);
	});
});
