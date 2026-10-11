/// <reference types="vite/client" />
// allow-missing-refs: new file this agent creates
//
// M2 part 3 (lane L-f): the five scope helpers decide "fleet" on the STANDING
// that @vantageos/cloud-identity produced for the caller (a `fleet` principal
// resolved from stored rows), never on the `scope.isMaster` flag and never on a
// label. A row that says master but carries no package-produced fleet standing
// is not the fleet in ANY of the five helpers.

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import {
	filterByOrgScope,
	hasFleetStanding,
	isNamespaceAllowedForScope,
	isRowVisibleToScope,
	type OrgScope,
	requireResolvedCaller,
	requireScope,
	type Standing,
	withOrgScope,
} from "../lib/auth";
import schema from "../schema";

const OPERATOR_ORG = testClerkOrgId("operator-org");
const ORG_A = testClerkOrgId("org-a");
const ORG_B = testClerkOrgId("org-b");

const FLEET_STANDING: Standing = {
	grant: "fleet",
	principal: { principalId: "svc-1", orgId: OPERATOR_ORG, kind: "fleet" },
};

function scope(over: Partial<OrgScope>): OrgScope {
	return {
		userId: "u",
		orgSlug: null,
		allowedOrchestrators: [],
		allowedAgentIds: [],
		fleetWide: false,
		scopes: [],
		isMaster: false,
		...over,
	};
}

// The row SAYS master (isMaster, masterSource), the package produced no fleet
// standing: absent, or a standing whose principal is not of kind "fleet".
const rowSaysMasterNoStanding = scope({
	isMaster: true,
	masterSource: "service-account",
	fleetWide: true,
});
const rowSaysMasterPersonStanding = scope({
	isMaster: true,
	masterSource: "service-account",
	fleetWide: true,
	standing: {
		grant: "fleet",
		principal: { principalId: "p1", orgId: OPERATOR_ORG, kind: "person" },
	},
});
const rowSaysMasterAgentStanding = scope({
	isMaster: true,
	masterSource: "service-account",
	fleetWide: true,
	standing: {
		grant: "fleet",
		principal: { principalId: "a1", orgId: OPERATOR_ORG, kind: "agent" },
	},
});
const trueFleet = scope({
	isMaster: true,
	masterSource: "service-account",
	fleetWide: true,
	standing: FLEET_STANDING,
});
const memberA = scope({
	orgSlug: "org-a",
	orgClerkId: ORG_A,
	allowedOrchestrators: ["eta"],
	scopes: ["view-own-tasks"],
});

const notFleet: Array<[string, OrgScope]> = [
	["row says master, no standing", rowSaysMasterNoStanding],
	["row says master, standing is a person", rowSaysMasterPersonStanding],
	["row says master, standing is an agent", rowSaysMasterAgentStanding],
];

const otherOrgRow = { orgId: "org-b", clerkOrgId: ORG_B, assignedTo: "eta" };
const ownRow = { orgId: "org-a", clerkOrgId: ORG_A, assignedTo: "eta" };

function throws(fn: () => void): string {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(ConvexError);
		return JSON.stringify((e as ConvexError<string>).data);
	}
	return "";
}

describe("hasFleetStanding reads the package-produced principal", () => {
	test("a fleet principal is the fleet", () => {
		expect(hasFleetStanding(trueFleet)).toBe(true);
	});
	test.each(notFleet)("%s is not the fleet", (_n, s) => {
		expect(hasFleetStanding(s)).toBe(false);
	});
	test("a member is not the fleet", () => {
		expect(hasFleetStanding(memberA)).toBe(false);
	});
});

describe.each(notFleet)("%s", (_n, s) => {
	test("filterByOrgScope: not treated as fleet (returns nothing)", () => {
		expect(filterByOrgScope([otherOrgRow, ownRow], s)).toEqual([]);
	});
	test("isRowVisibleToScope: not treated as fleet", () => {
		expect(isRowVisibleToScope(s, otherOrgRow)).toBe(false);
	});
	test("requireScope: not treated as fleet (missing scope raises)", () => {
		expect(throws(() => requireScope(s, "view-own-tasks"))).toContain(
			"RBAC_DENIED",
		);
	});
	test("requireResolvedCaller: not treated as fleet (masterOnly raises)", () => {
		expect(
			throws(() =>
				requireResolvedCaller(s, "issues:getStats", { masterOnly: true }),
			),
		).toContain("not-fleet-master");
	});
	test("isNamespaceAllowedForScope: not treated as fleet", () => {
		expect(isNamespaceAllowedForScope(s, "team/org-b")).toBe(false);
	});
});

describe("a true fleet standing is the fleet in each of the five helpers", () => {
	test("filterByOrgScope", () => {
		expect(filterByOrgScope([otherOrgRow, ownRow], trueFleet)).toHaveLength(2);
	});
	test("isRowVisibleToScope", () => {
		expect(isRowVisibleToScope(trueFleet, otherOrgRow)).toBe(true);
	});
	test("requireScope", () => {
		expect(() => requireScope(trueFleet, "anything")).not.toThrow();
	});
	test("requireResolvedCaller", () => {
		expect(() =>
			requireResolvedCaller(trueFleet, "issues:getStats", { masterOnly: true }),
		).not.toThrow();
	});
	test("isNamespaceAllowedForScope", () => {
		expect(isNamespaceAllowedForScope(trueFleet, "team/org-b")).toBe(true);
	});
});

describe("both permission poles under a scoped identity", () => {
	test("filterByOrgScope: own org row admitted, other org row refused", () => {
		expect(filterByOrgScope([ownRow], memberA)).toHaveLength(1);
		expect(filterByOrgScope([otherOrgRow], memberA)).toEqual([]);
	});
	test("isRowVisibleToScope: own admitted, other refused", () => {
		expect(isRowVisibleToScope(memberA, ownRow)).toBe(true);
		expect(isRowVisibleToScope(memberA, otherOrgRow)).toBe(false);
	});
	test("requireScope: granted scope passes, ungranted raises", () => {
		expect(() => requireScope(memberA, "view-own-tasks")).not.toThrow();
		expect(throws(() => requireScope(memberA, "cross-tenant-read"))).toContain(
			"RBAC_DENIED",
		);
	});
	test("requireResolvedCaller: a member of an active org is resolved, but refused a masterOnly door", () => {
		expect(() => requireResolvedCaller(memberA, "x:y")).not.toThrow();
		expect(
			throws(() => requireResolvedCaller(memberA, "x:y", { masterOnly: true })),
		).toContain("not-fleet-master");
	});
	test("isNamespaceAllowedForScope: own namespace admitted, other refused", () => {
		expect(isNamespaceAllowedForScope(memberA, "team/org-a/notes")).toBe(true);
		expect(isNamespaceAllowedForScope(memberA, "team/org-b")).toBe(false);
	});
});

describe("withOrgScope attaches the standing the package produced", () => {
	const modules = Object.fromEntries(
		Object.entries(import.meta.glob("../**/*.ts")).filter(
			([path]) =>
				!path.includes("ragSync") &&
				!path.includes("search") &&
				!path.includes("backfill"),
		),
	);
	const ORG = "standing-org";

	test("the fleet service account carries a fleet principal; a member carries none", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: ORG,
				clerkOrgId: testClerkOrgId(ORG),
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: ORG,
				isActive: true,
				createdAt: Date.now(),
			});
		});
		const sa = await t
			.withIdentity({ subject: process.env.CLERK_SERVICE_ACCOUNT_USER_ID })
			.run((ctx) => withOrgScope(ctx));
		expect(sa.isMaster).toBe(true);
		expect(sa.standing?.principal?.kind).toBe("fleet");
		expect(hasFleetStanding(sa)).toBe(true);

		const member = await t
			.withIdentity({
				subject: "ordinary-member",
				org_slug: ORG,
				org_id: testClerkOrgId(ORG),
				org_role: "org:member",
			})
			.run((ctx) => withOrgScope(ctx));
		expect(member.isMaster).toBe(false);
		expect(member.standing).toBeUndefined();
		expect(hasFleetStanding(member)).toBe(false);
	});
});
