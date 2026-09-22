/// <reference types="vite/client" />
/**
 * orgMembership — task k17a7t4a9d4hx11sgj2tcdf7kx8et4cp.
 *
 * Operator use case: one administrator holds TWO organisations, for two
 * unrelated startups, with real users behind them. Before this change,
 * VantagePeers had no record of who administers which org — only Clerk
 * did — and there was no way to ANSWER "which orgs does this person
 * administer" from VantagePeers itself.
 *
 * THE PROPERTY (both directions, both poles):
 *   - Provisioning writes a membership row for the org-admin caller,
 *     idempotently (replay leaves exactly one row).
 *   - "who administers org X" — master/service-account may ask about ANY
 *     org; an org-scoped caller may ask ONLY about its OWN org (refused,
 *     not an empty list, for any other org); anonymous is refused before
 *     any row is read.
 *   - "which orgs does the caller belong to" — an administrator holding
 *     TWO orgs reads BOTH, under its own verified identity, keyed on its
 *     own subject — never a caller-supplied clerkUserId argument.
 *
 * AUDIT RECORD ONLY: nothing here is consulted by any authorization
 * decision — see convex/schema.ts's orgMembership table comment and
 * convex/orgMembership.ts's module comment.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { MEMBERSHIP_QUERY_LIMIT } from "../orgMembership";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	clerkOrgSlug: string,
	allowedOrchestrators: string[] = ["existing-seat"],
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators,
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const orgAdminIdentity = (subject: string, org: string) => ({
	subject,
	organizationSlug: org,
	orgRole: "org:admin",
});

describe("orgMembership — provisioning writes an idempotent audit row", () => {
	test("provisioning an org twice leaves exactly ONE membership row, not two", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-membership-a", ["seat-a"]);

		const tAdmin = t.withIdentity(
			orgAdminIdentity("admin-both", "org-membership-a") as Parameters<
				typeof t.withIdentity
			>[0],
		);

		await tAdmin.mutation(api.oauth.provisionOrganization, {
			clerkOrgSlug: "org-membership-a",
			displayName: "Org A",
			orchestrators: [{ name: "seat-a" }],
		});
		// Replay: same slug, same seat set.
		await tAdmin.mutation(api.oauth.provisionOrganization, {
			clerkOrgSlug: "org-membership-a",
			displayName: "Org A",
			orchestrators: [{ name: "seat-a" }],
		});

		const rows = await t.run(async (ctx) =>
			ctx.db
				.query("orgMembership")
				.withIndex("by_org_user", (q) =>
					q
						.eq("clerkOrgSlug", "org-membership-a")
						.eq("clerkUserId", "admin-both"),
				)
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].role).toBe("admin");
	});

	test("master path (callerToken) records nothing in orgMembership", async () => {
		const previous = process.env.BEARER_SECRET_MASTER;
		process.env.BEARER_SECRET_MASTER = "test-master-secret-membership";
		try {
			const t = createT();
			await t.mutation(api.oauth.provisionOrganization, {
				callerToken: "test-master-secret-membership",
				clerkOrgSlug: "org-membership-master",
				displayName: "Master Path Org",
				orchestrators: [{ name: "master-seat" }],
			});

			const rows = await t.run(async (ctx) =>
				ctx.db
					.query("orgMembership")
					.withIndex("by_org", (q) =>
						q.eq("clerkOrgSlug", "org-membership-master"),
					)
					.collect(),
			);
			expect(rows).toHaveLength(0);
		} finally {
			if (previous === undefined) {
				delete process.env.BEARER_SECRET_MASTER;
			} else {
				process.env.BEARER_SECRET_MASTER = previous;
			}
		}
	});
});

describe("orgMembership.getMembership — direction 1: who administers org X", () => {
	test("POLE ALLOW: org-scoped caller reads its OWN org's membership", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-membership-b", ["seat-b"]);
		const tAdmin = t.withIdentity(
			orgAdminIdentity("admin-b", "org-membership-b") as Parameters<
				typeof t.withIdentity
			>[0],
		);
		await tAdmin.mutation(api.oauth.provisionOrganization, {
			clerkOrgSlug: "org-membership-b",
			displayName: "Org B",
			orchestrators: [{ name: "seat-b" }],
		});

		const rows = await tAdmin.query(api.orgMembership.getMembership, {
			clerkOrgSlug: "org-membership-b",
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			clerkOrgSlug: "org-membership-b",
			clerkUserId: "admin-b",
			role: "admin",
		});
	});

	test("POLE DENY: org-scoped caller reading a DIFFERENT org's membership is refused, not an empty list", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-membership-c1", ["seat-c1"]);
		await seedOrgMapping(t, "org-membership-c2", ["seat-c2"]);

		const tAdminC1 = t.withIdentity(
			orgAdminIdentity("admin-c1", "org-membership-c1") as Parameters<
				typeof t.withIdentity
			>[0],
		);
		await tAdminC1.mutation(api.oauth.provisionOrganization, {
			clerkOrgSlug: "org-membership-c1",
			displayName: "Org C1",
			orchestrators: [{ name: "seat-c1" }],
		});

		await expect(
			tAdminC1.query(api.orgMembership.getMembership, {
				clerkOrgSlug: "org-membership-c2",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("POLE ALLOW: master reads any org's membership", async () => {
		const previous = process.env.BEARER_SECRET_MASTER;
		process.env.BEARER_SECRET_MASTER = "test-master-secret-membership-2";
		try {
			const t = createT();
			await seedOrgMapping(t, "org-membership-d", ["seat-d"]);
			const tAdmin = t.withIdentity(
				orgAdminIdentity("admin-d", "org-membership-d") as Parameters<
					typeof t.withIdentity
				>[0],
			);
			await tAdmin.mutation(api.oauth.provisionOrganization, {
				clerkOrgSlug: "org-membership-d",
				displayName: "Org D",
				orchestrators: [{ name: "seat-d" }],
			});

			// Master identity per withOrgScope's service-account carve-out —
			// use allowNoIdentityMaster's internal path via no-identity call
			// is not exposed on a query, so exercise via a Clerk service
			// account identity resolved as master through
			// CLERK_SERVICE_ACCOUNT_USER_ID.
			const previousServiceAccount = process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
			process.env.CLERK_SERVICE_ACCOUNT_USER_ID = "service-account-membership";
			try {
				const tMaster = t.withIdentity({
					subject: "service-account-membership",
				} as Parameters<typeof t.withIdentity>[0]);
				const rows = await tMaster.query(api.orgMembership.getMembership, {
					clerkOrgSlug: "org-membership-d",
				});
				expect(rows).toHaveLength(1);
				expect(rows[0].clerkUserId).toBe("admin-d");
			} finally {
				if (previousServiceAccount === undefined) {
					delete process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
				} else {
					process.env.CLERK_SERVICE_ACCOUNT_USER_ID = previousServiceAccount;
				}
			}
		} finally {
			if (previous === undefined) {
				delete process.env.BEARER_SECRET_MASTER;
			} else {
				process.env.BEARER_SECRET_MASTER = previous;
			}
		}
	});

	test("POLE DENY: anonymous caller is refused with RBAC_DENIED before any row is read", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-membership-e", ["seat-e"]);

		await expect(
			t.query(api.orgMembership.getMembership, {
				clerkOrgSlug: "org-membership-e",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("orgMembership.getMembership — direction 2: which orgs does the caller belong to", () => {
	test("an administrator holding TWO organisations reads BOTH, under its own scoped identity", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-membership-f1", ["seat-f1"]);
		await seedOrgMapping(t, "org-membership-f2", ["seat-f2"]);
		await seedOrgMapping(t, "org-membership-f3", ["seat-f3"]);

		// Same human subject provisions two DIFFERENT orgs (simulating an
		// administrator who holds two organisations — two Clerk sessions,
		// each with its own active org, same underlying subject).
		const tAdminOrg1 = t.withIdentity(
			orgAdminIdentity("admin-two-orgs", "org-membership-f1") as Parameters<
				typeof t.withIdentity
			>[0],
		);
		await tAdminOrg1.mutation(api.oauth.provisionOrganization, {
			clerkOrgSlug: "org-membership-f1",
			displayName: "Org F1",
			orchestrators: [{ name: "seat-f1" }],
		});

		const tAdminOrg2 = t.withIdentity(
			orgAdminIdentity("admin-two-orgs", "org-membership-f2") as Parameters<
				typeof t.withIdentity
			>[0],
		);
		await tAdminOrg2.mutation(api.oauth.provisionOrganization, {
			clerkOrgSlug: "org-membership-f2",
			displayName: "Org F2",
			orchestrators: [{ name: "seat-f2" }],
		});

		// A THIRD org, provisioned by a DIFFERENT admin — admin-two-orgs
		// never administers this one.
		const tAdminOrg3 = t.withIdentity(
			orgAdminIdentity("admin-other", "org-membership-f3") as Parameters<
				typeof t.withIdentity
			>[0],
		);
		await tAdminOrg3.mutation(api.oauth.provisionOrganization, {
			clerkOrgSlug: "org-membership-f3",
			displayName: "Org F3",
			orchestrators: [{ name: "seat-f3" }],
		});

		// Self lookup — no clerkOrgSlug argument, derived from the caller's
		// own verified subject. Called under a session attached to org-f1
		// (any of the caller's own orgs satisfies withOrgScope's org-attached
		// requirement); the result is keyed on subject, not on this session's
		// active org, so both f1 and f2 come back — and f3 does NOT.
		const rows = await tAdminOrg1.query(api.orgMembership.getMembership, {});
		const slugs = rows.map((r: { clerkOrgSlug: string }) => r.clerkOrgSlug).sort();
		expect(slugs).toEqual(["org-membership-f1", "org-membership-f2"]);
		expect(slugs).not.toContain("org-membership-f3");
	});

	test("anonymous caller is refused with RBAC_DENIED on the self-lookup direction too", async () => {
		const t = createT();
		await expect(
			t.query(api.orgMembership.getMembership, {}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("orgMembership.getMembership — MEMBERSHIP_QUERY_INCOMPLETE bound", () => {
	// Seeds exactly MEMBERSHIP_QUERY_LIMIT rows for a SINGLE org (direct
	// db.insert, not MEMBERSHIP_QUERY_LIMIT provisioning calls — provisioning
	// is not the property under test here, the read-side bound is) and
	// proves the refusal actually fires rather than resolving a silently
	// truncated array. MEMBERSHIP_QUERY_LIMIT is imported from the source
	// module rather than hard-coded here, so this test tracks the real
	// bound if it is ever tuned.
	test("hitting MEMBERSHIP_QUERY_LIMIT rows for one org throws MEMBERSHIP_QUERY_INCOMPLETE, not a truncated list", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-membership-bound", ["seat-bound"]);

		await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < MEMBERSHIP_QUERY_LIMIT; i++) {
				await ctx.db.insert("orgMembership", {
					clerkOrgSlug: "org-membership-bound",
					clerkUserId: `admin-bound-${i}`,
					role: "admin",
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		const tAdminBound = t.withIdentity(
			orgAdminIdentity(
				"admin-bound-0",
				"org-membership-bound",
			) as Parameters<typeof t.withIdentity>[0],
		);

		await expect(
			tAdminBound.query(api.orgMembership.getMembership, {
				clerkOrgSlug: "org-membership-bound",
			}),
		).rejects.toThrow(/MEMBERSHIP_QUERY_INCOMPLETE/);
	});
});
