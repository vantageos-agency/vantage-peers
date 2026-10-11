// The index bounds a read applies inside its query (tenantNamespaceBounds) and the
// predicate other readers apply (isNamespaceAllowedForScope) are ONE rule said two
// ways. Pinned in both directions, for the same scope: a namespace is inside the
// bounds exactly when the predicate admits it. Org-ID keyed, so a renamed org keeps
// its namespace and a slug reused by another org reaches nothing. #1511 (M17) carries
// the first version of the bounds keyed by slug; whichever lands second must agree.

import { describe, expect, test } from "vitest";
import { isNamespaceAllowedForScope, tenantNamespaceBounds } from "../lib/auth";

const inBounds = (
	b: { exact: string; from: string; to: string },
	ns: string,
): boolean => ns === b.exact || (ns >= b.from && ns < b.to);

const member = (orgSlug: string, orgClerkId?: string) => ({
	isMaster: false,
	orgSlug,
	...(orgClerkId !== undefined ? { orgClerkId } : {}),
});

const NAMESPACES = [
	"team/org_A",
	"team/org_A/docs/d1",
	"team/org_A/",
	"team/org_AB",
	"team/org_AB/docs",
	"team/org_A0",
	"team/org_B",
	"team/org_B/docs",
	"team/acme-hr",
	"team/acme-hr/docs",
	"team/",
	"team",
	"teams/org_A",
	"global",
];

describe("tenantNamespaceBounds === isNamespaceAllowedForScope", () => {
	test("the same scope: inside the bounds exactly when the predicate admits", () => {
		const scope = member("acme-hr", "org_A");
		const bounds = tenantNamespaceBounds(scope.orgClerkId);
		expect(bounds).toEqual({
			exact: "team/org_A",
			from: "team/org_A/",
			to: "team/org_A0",
		});
		for (const ns of NAMESPACES) {
			expect([ns, inBounds(bounds as never, ns)]).toEqual([
				ns,
				isNamespaceAllowedForScope(scope, ns),
			]);
		}
		// exact, child, sibling prefix and foreign cases all present
		expect(NAMESPACES.filter((ns) => inBounds(bounds as never, ns))).toEqual([
			"team/org_A",
			"team/org_A/docs/d1",
			"team/org_A/",
		]);
	});

	test("a RENAMED org: the slug changed, the ID did not, so bounds and predicate still name the same rows", () => {
		const before = member("acme-hr", "org_A");
		const after = member("acme-hr-renamed", "org_A");
		expect(tenantNamespaceBounds(after.orgClerkId)).toEqual(
			tenantNamespaceBounds(before.orgClerkId),
		);
		const b = tenantNamespaceBounds(after.orgClerkId) as never;
		for (const ns of NAMESPACES) {
			expect(inBounds(b, ns)).toBe(isNamespaceAllowedForScope(after, ns));
		}
		expect(inBounds(b, "team/org_A/docs/d1")).toBe(true);
		expect(inBounds(b, "team/acme-hr-renamed/docs")).toBe(false);
	});

	test("a REUSED slug: a new org holding the old slug has a different ID and reaches none of the old org's rows", () => {
		const newOrg = member("acme-hr", "org_NEW");
		const b = tenantNamespaceBounds(newOrg.orgClerkId) as never;
		for (const ns of NAMESPACES) {
			expect(inBounds(b, ns)).toBe(isNamespaceAllowedForScope(newOrg, ns));
		}
		expect(inBounds(b, "team/org_A")).toBe(false);
		expect(inBounds(b, "team/org_A/docs/d1")).toBe(false);
		expect(inBounds(b, "team/acme-hr/docs")).toBe(false);
		expect(inBounds(b, "team/org_NEW/docs")).toBe(true);
	});

	test("no org ID filled in: no bounds, and the predicate admits nothing either", () => {
		const scope = member("acme-hr");
		expect(tenantNamespaceBounds(scope.orgClerkId)).toBeNull();
		for (const ns of NAMESPACES) {
			expect(isNamespaceAllowedForScope(scope, ns)).toBe(false);
		}
	});
});
