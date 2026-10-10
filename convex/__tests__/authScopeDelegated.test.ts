/// <reference types="vite/client" />
/**
 * M2 — the scope hub (convex/lib/auth.ts) decides WHICH organisation and WHO
 * administers it by the verified `org_id` claim, through @vantageos/cloud-identity,
 * never by the org slug a token happens to carry.
 *
 * Each describe block pins a property in both directions:
 *   SCOPE      own rows visible / another org's rows invisible
 *   ADMIN      an org admin is admin of ITS org by ID; a member, an admin of
 *              another org and a claim-less caller are refused
 *   SLUG REUSE a NEW Clerk org that takes a freed slug (different org_id) is not
 *              admin of the old org's rows, not the operator, not an agent admin
 *   RENAME     the same org (same org_id) under a new slug stays admin
 *   CLAIM-LESS a caller whose token carries no verified org ID is refused (never
 *              master); a slug alone is not a claim
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { requireOrgAdminById } from "../lib/agentIdentity";
import {
	filterByOrgScope,
	isRowVisibleToScope,
	requireOrgAdmin,
	requireOperatorAdminToCreateOrg,
	resolveOperatorAdmin,
	withOrgScope,
} from "../lib/auth";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const NOW = 1_700_000_000_000;

async function seedOrg(
	t: T,
	slug: string,
	opts: { orgKind?: "operator" | "client"; isActive?: boolean; orgId?: string } = {},
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: opts.orgId ?? testClerkOrgId(slug),
			allowedOrchestrators: ["seat"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: opts.isActive ?? true,
			createdAt: NOW,
			...(opts.orgKind ? { orgKind: opts.orgKind } : {}),
		});
	});
}

/** A verified Clerk session: the slug, the permanent ID and the role claim. */
const session = (
	subject: string,
	slugClaim: string,
	orgId: string | undefined,
	role = "org:admin",
): Identity =>
	({
		subject,
		org_slug: slugClaim,
		...(orgId !== undefined ? { org_id: orgId } : {}),
		org_role: role,
	}) as Identity;

describe("SCOPE: rows belong to an organisation by its permanent ID", () => {
	test("own rows visible, another org's rows invisible", async () => {
		const t = createT();
		await seedOrg(t, "scope-a");
		await seedOrg(t, "scope-b");
		const member = t.withIdentity(
			session("u-a", "scope-a", testClerkOrgId("scope-a"), "org:member"),
		);
		await member.run(async (ctx) => {
			const scope = await withOrgScope(ctx);
			const own = {
				orgId: "scope-a",
				clerkOrgId: testClerkOrgId("scope-a"),
				pilot: "seat",
			};
			const other = {
				orgId: "scope-b",
				clerkOrgId: testClerkOrgId("scope-b"),
				pilot: "seat",
			};
			expect(isRowVisibleToScope(scope, own)).toBe(true);
			expect(isRowVisibleToScope(scope, other)).toBe(false);
			expect(filterByOrgScope([own, other], scope)).toEqual([own]);
		});
	});

	test("a row stamped with the caller's slug but ANOTHER org's ID is invisible", async () => {
		const t = createT();
		await seedOrg(t, "scope-c");
		const member = t.withIdentity(
			session("u-c", "scope-c", testClerkOrgId("scope-c"), "org:member"),
		);
		await member.run(async (ctx) => {
			const scope = await withOrgScope(ctx);
			const stale = {
				orgId: "scope-c",
				clerkOrgId: "org_someOtherOrganisation",
				pilot: "seat",
			};
			expect(isRowVisibleToScope(scope, stale)).toBe(false);
		});
	});
});

describe("ADMIN: requireOrgAdmin decides by the verified org_id", () => {
	test("ALLOW: the verified admin of the target org", async () => {
		const t = createT();
		await seedOrg(t, "adm-a");
		await t
			.withIdentity(session("admin-a", "adm-a", testClerkOrgId("adm-a")))
			.run(async (ctx) => {
				await expect(requireOrgAdmin(ctx, "adm-a")).resolves.toBeUndefined();
			});
	});

	test("DENY: a plain member of the target org", async () => {
		const t = createT();
		await seedOrg(t, "adm-b");
		await t
			.withIdentity(
				session("member-b", "adm-b", testClerkOrgId("adm-b"), "org:member"),
			)
			.run(async (ctx) => {
				await expect(requireOrgAdmin(ctx, "adm-b")).rejects.toThrow(
					/RBAC_DENIED/,
				);
			});
	});

	test("DENY: an admin of ANOTHER org", async () => {
		const t = createT();
		await seedOrg(t, "adm-c1");
		await seedOrg(t, "adm-c2");
		await t
			.withIdentity(session("admin-c1", "adm-c1", testClerkOrgId("adm-c1")))
			.run(async (ctx) => {
				await expect(requireOrgAdmin(ctx, "adm-c2")).rejects.toThrow(
					/RBAC_DENIED/,
				);
			});
	});

	test("DENY: an admin of an INACTIVE org", async () => {
		const t = createT();
		await seedOrg(t, "adm-d", { isActive: false });
		await t
			.withIdentity(session("admin-d", "adm-d", testClerkOrgId("adm-d")))
			.run(async (ctx) => {
				await expect(requireOrgAdmin(ctx, "adm-d")).rejects.toThrow(
					/RBAC_DENIED/,
				);
			});
	});
});

describe("SLUG REUSE: a new org that takes a freed slug is not admin of the old org", () => {
	test("requireOrgAdmin refuses a new org_id carrying the old org's slug", async () => {
		const t = createT();
		await seedOrg(t, "freed-slug"); // the OLD org: id derived from the slug
		await t
			.withIdentity(session("attacker", "freed-slug", "org_NewOrgTookTheSlug"))
			.run(async (ctx) => {
				await expect(requireOrgAdmin(ctx, "freed-slug")).rejects.toThrow(
					/RBAC_DENIED/,
				);
			});
	});

	test("requireOrgAdmin refuses even when the new org is itself mapped (different ID, same slug claim)", async () => {
		const t = createT();
		await seedOrg(t, "freed-old");
		await seedOrg(t, "freed-new");
		await t
			.withIdentity(
				session("attacker2", "freed-old", testClerkOrgId("freed-new")),
			)
			.run(async (ctx) => {
				await expect(requireOrgAdmin(ctx, "freed-old")).rejects.toThrow(
					/RBAC_DENIED/,
				);
			});
	});

	test("resolveOperatorAdmin refuses a new org_id carrying the operator's slug", async () => {
		const t = createT();
		await seedOrg(t, "op-slug", { orgKind: "operator" });
		await t
			.withIdentity(session("attacker3", "op-slug", "org_NewOrgTookOpSlug"))
			.run(async (ctx) => {
				const verdict = await resolveOperatorAdmin(ctx);
				expect(verdict.ok).toBe(false);
			});
	});

	test("requireOperatorAdminToCreateOrg refuses the same attacker", async () => {
		const t = createT();
		await seedOrg(t, "op-slug2", { orgKind: "operator" });
		await t
			.withIdentity(session("attacker4", "op-slug2", "org_NewOrgTookOpSlug2"))
			.run(async (ctx) => {
				await expect(
					requireOperatorAdminToCreateOrg(ctx, "brand-new-client"),
				).rejects.toThrow(/RBAC_DENIED/);
			});
	});

	test("requireOrgAdminById (agent doors) refuses a new org_id carrying the old slug", async () => {
		const t = createT();
		await seedOrg(t, "agent-slug");
		const identity = session("attacker5", "agent-slug", "org_NewOrgTookAgentSlug");
		await t.withIdentity(identity).run(async (ctx) => {
			const who = await ctx.auth.getUserIdentity();
			if (who === null) throw new Error("test identity missing");
			await expect(
				requireOrgAdminById(ctx, who, "agent-slug", "test:door"),
			).rejects.toThrow(/RBAC_DENIED/);
		});
	});

	test("withOrgScope never resolves the old org's scope for a new org_id", async () => {
		const t = createT();
		await seedOrg(t, "freed-scope");
		await t
			.withIdentity(
				session("attacker6", "freed-scope", "org_NewOrgTookScopeSlug", "org:member"),
			)
			.run(async (ctx) => {
				await expect(withOrgScope(ctx)).rejects.toThrow(/RBAC_DENIED/);
			});
	});
});

describe("RENAME: the same org_id under a new slug stays admin", () => {
	test("requireOrgAdmin by the target's current slug, with a stale slug claim", async () => {
		const t = createT();
		// The mapping was renamed to "renamed-now"; the session still says "renamed-before".
		await seedOrg(t, "renamed-now", { orgId: "org_RenamedOrg" });
		await t
			.withIdentity(session("admin-r", "renamed-before", "org_RenamedOrg"))
			.run(async (ctx) => {
				await expect(requireOrgAdmin(ctx, "renamed-now")).resolves.toBeUndefined();
			});
	});

	test("resolveOperatorAdmin recognises the operator after a rename", async () => {
		const t = createT();
		await seedOrg(t, "operator-now", { orgKind: "operator", orgId: "org_Operator" });
		await t
			.withIdentity(session("op-admin", "operator-before", "org_Operator"))
			.run(async (ctx) => {
				const verdict = await resolveOperatorAdmin(ctx);
				expect(verdict.ok).toBe(true);
				if (verdict.ok) expect(verdict.operatorOrgSlug).toBe("operator-now");
			});
	});
});

describe("CLAIM-LESS: no verified org ID is a refusal, never master", () => {
	test("withOrgScope: an identity with a slug but no org_id is refused", async () => {
		const t = createT();
		await seedOrg(t, "claimless-a");
		await t
			.withIdentity(session("slug-only", "claimless-a", undefined, "org:member"))
			.run(async (ctx) => {
				await expect(withOrgScope(ctx)).rejects.toThrow(/RBAC_DENIED/);
			});
	});

	test("withOrgScope refuseWithoutThrow: a slug alone is still RAISED (a token that names an org it cannot prove is not 'no org')", async () => {
		const t = createT();
		await seedOrg(t, "claimless-b");
		await t
			.withIdentity(session("slug-only-b", "claimless-b", undefined, "org:member"))
			.run(async (ctx) => {
				await expect(
					withOrgScope(ctx, { refuseWithoutThrow: true }),
				).rejects.toThrow(/RBAC_DENIED.*no-verified-organisation/);
			});
	});

	test("withOrgScope refuseWithoutThrow: a signed-in caller with NO org claim gets the typed refusal, never master", async () => {
		const t = createT();
		await t
			.withIdentity({ subject: "no-org-at-all" } as Identity)
			.run(async (ctx) => {
				const scope = await withOrgScope(ctx, { refuseWithoutThrow: true });
				expect(scope.refused).toBe(true);
				expect(scope.isMaster).toBe(false);
				expect(scope.orgSlug).toBeNull();
				await expect(withOrgScope(ctx)).rejects.toThrow(/RBAC_DENIED/);
			});
	});

	test("withOrgScope: no identity at all resolves to the anonymous, non-master scope", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			const scope = await withOrgScope(ctx);
			expect(scope.anonymous).toBe(true);
			expect(scope.isMaster).toBe(false);
			expect(scope.fleetWide).toBe(false);
		});
	});

	test("requireOrgAdmin: a slug alone is not a claim", async () => {
		const t = createT();
		await seedOrg(t, "claimless-c");
		await t
			.withIdentity(session("slug-only-c", "claimless-c", undefined))
			.run(async (ctx) => {
				await expect(requireOrgAdmin(ctx, "claimless-c")).rejects.toThrow(
					/RBAC_DENIED/,
				);
			});
	});

	test("resolveOperatorAdmin: a slug alone is not the operator", async () => {
		const t = createT();
		await seedOrg(t, "claimless-op", { orgKind: "operator" });
		await t
			.withIdentity(session("slug-only-op", "claimless-op", undefined))
			.run(async (ctx) => {
				const verdict = await resolveOperatorAdmin(ctx);
				expect(verdict.ok).toBe(false);
			});
	});

	test("requireOrgAdmin: no identity is refused", async () => {
		const t = createT();
		await seedOrg(t, "claimless-d");
		await t.run(async (ctx) => {
			await expect(requireOrgAdmin(ctx, "claimless-d")).rejects.toThrow(
				/RBAC_DENIED/,
			);
		});
	});
});
