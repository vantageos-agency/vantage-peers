/// <reference types="vite/client" />
/**
 * Task k179y0wpsd6fv7055f4p2w6b358hdrxe — OKF export/import (actions, "use
 * node") under the acting org. Their namespace gate reads the scope from
 * `resolveOrgScopeForAction`, which the action now hands its `__actingOrg`.
 * Poles: acting for A, B's team namespace is REFUSED RBAC_DENIED; the fleet
 * without the argument is not refused on that namespace (unchanged); a member
 * of B naming org A is still refused on A's namespace.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
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

// biome-ignore lint/suspicious/noExplicitAny: string function reference (cf. okfTenantNamespaceFromMapping.test.ts)
const EXPORT_REF = "okfBundleNode:exportOkfBundle" as any;
// biome-ignore lint/suspicious/noExplicitAny: string function reference
const IMPORT_REF = "okfBundleNode:importOkfBundle" as any;

const A = "okf-org-a";
const B = "okf-org-b";
const nsOf = (org: string) => `team/${testClerkOrgId(org)}`;

async function seed(t: T) {
	await t.run(async (ctx) => {
		for (const org of [A, B]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: 1,
			});
		}
	});
}

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		organizationSlug: org,
		org_id: testClerkOrgId(org),
	} as Parameters<T["withIdentity"]>[0]);

async function refusalCode(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "SERVED";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		return /RBAC_DENIED/.test(text) ? "RBAC_DENIED" : `OTHER(${text.slice(0, 80)})`;
	}
}

const DOORS = [
	["exportOkfBundle", (ns: string) => [EXPORT_REF, { namespace: ns, format: "tarball" }]],
	["importOkfBundle", (ns: string) => [IMPORT_REF, { targetNamespace: ns, mode: "dry-run" }]],
] as const;

for (const [name, argsOf] of DOORS) {
	describe(`okfBundleNode:${name} under the acting org`, () => {
		test("acting for A: B's team namespace is refused RBAC_DENIED", async () => {
			const t = createT();
			await seed(t);
			const [ref, args] = argsOf(nsOf(B));
			expect(
				await refusalCode(
					asService(t).action(ref, { ...args, __actingOrg: testClerkOrgId(A) }),
				),
			).toBe("RBAC_DENIED");
		});

		test("the fleet without the argument is not refused RBAC_DENIED on B's namespace (unchanged)", async () => {
			const t = createT();
			await seed(t);
			const [ref, args] = argsOf(nsOf(B));
			expect(await refusalCode(asService(t).action(ref, args))).not.toBe("RBAC_DENIED");
		});

		test("a member of B naming org A is refused on A's namespace", async () => {
			const t = createT();
			await seed(t);
			const [ref, args] = argsOf(nsOf(A));
			expect(
				await refusalCode(
					asMember(t, B).action(ref, { ...args, __actingOrg: testClerkOrgId(A) }),
				),
			).toBe("RBAC_DENIED");
		});
	});
}
