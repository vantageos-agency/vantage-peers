/// <reference types="vite/client" />
/**
 * A non-master OAuth caller reaches Convex as the fleet service account (master
 * + fleetWide), so a door gated only on "fleet read" served it the whole fleet.
 * Two doors leaked that way (task k17e1twdq22k9311yygkfgx9d58hcsws):
 *   - mandates:validateSpending   a mandate's budget / spend to any holder of its id
 *   - githubOwnerBinding:listBindings / listUnprovenMappings   every org's rows
 * Both now take the transport-verified `verifiedOrg` (convex/lib/verifiedOrg.ts)
 * and narrow to it. Mandates carry no org column: they are the operator
 * organisation's (parties are operator-org agents), so a verified CLIENT org is
 * refused. Without `verifiedOrg` the master path is byte-unchanged.
 *
 * Poles: LEAK (foreign org refused / foreign rows absent), PRESENT (own served),
 * FLEET (no verifiedOrg -> unchanged), TRUST (a member cannot name an org).
 */
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Ident = Parameters<T["withIdentity"]>[0];

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Ident);
const asMemberA = (t: T) =>
	t.withIdentity({
		subject: "member-of-org-a",
		organizationSlug: "org-a",
		org_id: testClerkOrgId("org-a"),
		orgRole: "org:member",
	} as Ident);

async function seed(t: T) {
	await t.run(async (ctx) => {
		for (const [slug, kind] of [
			["org-op", "operator"],
			["org-a", "client"],
			["org-b", "client"],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				orgKind: kind,
				createdAt: 1,
			});
		}
		for (const [slug, inst] of [
			["org-a", 11],
			["org-b", 22],
		] as const) {
			await ctx.db.insert("githubOwnerBindings", {
				owner: slug,
				orgId: slug,
				installationId: inst,
				accountType: "Organization",
				githubUserLogin: `gh-${slug}`,
				boundBy: `admin-${slug}`,
				boundAt: 1,
				active: true,
			});
			// A mapping with an org but no matching proof: "unproven".
			await ctx.db.insert("githubRepoMapping", {
				repo: `stranger-${slug}/repo`,
				orchestrator: "sigma",
				project: `p-${slug}`,
				active: true,
				orgId: slug,
			});
		}
	});
	return await t.run(async (ctx) =>
		ctx.db.insert("mandates", {
			requestedBy: "pi",
			fulfilledBy: "sigma",
			service: "spend",
			budget: 1000,
			status: "requested",
			tokensCost: 100,
			createdAt: 1,
			updatedAt: 1,
		}),
	);
}

async function failure(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const err = e as { data?: unknown; message?: string };
		return typeof err.data === "string" ? err.data : String(err.message ?? e);
	}
	return "";
}

describe("mandates:validateSpending narrows a fleet identity to the verified org", () => {
	test("LEAK: a client org's verifiedOrg is refused RBAC_DENIED, never a zero", async () => {
		const t = createT();
		const id = await seed(t);
		const msg = await failure(
			asService(t).query(api.mandates.validateSpending, {
				mandateId: id,
				proposedAmount: 5,
				verifiedOrg: { orgSlug: "org-a" },
			}),
		);
		expect(msg).toContain("RBAC_DENIED");
		expect(msg).toContain("not-fleet-master");
		expect(msg).toContain("mandates:validateSpending");
		expect(msg).not.toContain("remainingBudget");
	});
	test("LEAK: the refusal does not depend on the mandate existing (no oracle)", async () => {
		const t = createT();
		const id = await seed(t);
		await t.run(async (ctx) => ctx.db.delete(id));
		const msg = await failure(
			asService(t).query(api.mandates.validateSpending, {
				mandateId: id,
				proposedAmount: 5,
				verifiedOrg: { orgSlug: "org-b" },
			}),
		);
		expect(msg).toContain("RBAC_DENIED");
	});
	test("PRESENT: the operator org's own verifiedOrg is served", async () => {
		const t = createT();
		const id = await seed(t);
		const r = await asService(t).query(api.mandates.validateSpending, {
			mandateId: id,
			proposedAmount: 5,
			verifiedOrg: { orgSlug: "org-op" },
		});
		expect(r.withinLimits).toBe(true);
		expect(r.currentSpend).toBe(100);
	});
	test("FLEET: no verifiedOrg, the master path is unchanged", async () => {
		const t = createT();
		const id = await seed(t);
		const r = await asService(t).query(api.mandates.validateSpending, {
			mandateId: id,
			proposedAmount: 5,
		});
		expect(r.remainingBudget).toBe(895);
	});
	test("TRUST: a member cannot name an org by argument", async () => {
		const t = createT();
		const id = await seed(t);
		const msg = await failure(
			asMemberA(t).query(api.mandates.validateSpending, {
				mandateId: id,
				proposedAmount: 5,
				verifiedOrg: { orgSlug: "org-op" },
			}),
		);
		expect(msg).toContain("RBAC_DENIED");
	});
});

describe("githubOwnerBinding doors narrow a fleet identity to the verified org", () => {
	test("listBindings: verifiedOrg A sees only org-a rows; B only org-b; master sees both", async () => {
		const t = createT();
		await seed(t);
		const a = await asService(t).query(api.githubOwnerBinding.listBindings, {
			verifiedOrg: { orgSlug: "org-a" },
		});
		expect(a.items.map((r) => r.orgId)).toEqual(["org-a"]);
		const b = await asService(t).query(api.githubOwnerBinding.listBindings, {
			verifiedOrg: { orgSlug: "org-b" },
		});
		expect(b.items.map((r) => r.orgId)).toEqual(["org-b"]);
		const all = await asService(t).query(api.githubOwnerBinding.listBindings, {});
		expect(all.items.map((r) => r.orgId).sort()).toEqual(["org-a", "org-b"]);
	});
	test("listBindings: an unmapped verifiedOrg is refused, not served the table", async () => {
		const t = createT();
		await seed(t);
		const msg = await failure(
			asService(t).query(api.githubOwnerBinding.listBindings, {
				verifiedOrg: { orgSlug: "nope" },
			}),
		);
		expect(msg).toContain("RBAC_DENIED");
	});
	test("listUnprovenMappings: verifiedOrg A sees only org-a mappings; master sees both", async () => {
		const t = createT();
		await seed(t);
		const a = await asService(t).query(api.githubOwnerBinding.listUnprovenMappings, {
			verifiedOrg: { orgSlug: "org-a" },
		});
		expect(a.items.map((r) => r.orgId)).toEqual(["org-a"]);
		const all = await asService(t).query(api.githubOwnerBinding.listUnprovenMappings, {});
		expect(all.items.map((r) => r.orgId).sort()).toEqual(["org-a", "org-b"]);
	});
	test("listUnprovenMappings: a member cannot name an org by argument", async () => {
		const t = createT();
		await seed(t);
		const msg = await failure(
			asMemberA(t).query(api.githubOwnerBinding.listUnprovenMappings, {
				verifiedOrg: { orgSlug: "org-a" },
			}),
		);
		expect(msg).toContain("RBAC_DENIED");
	});
});
