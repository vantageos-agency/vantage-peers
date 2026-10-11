import { describe, expect, test } from "vitest";
import {
	filterByOrgScope,
	isRowVisibleToScope,
	type OrgScope,
} from "../lib/auth";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

// Module M2 part 3: the row-scope helpers decide a row's tenant by the permanent
// org ID the row is stamped with, never by a label or a name. Four poles per
// helper: own-org row visible, other-org row invisible, a same-NAME agent of
// another org not admitted, an unstamped row refused to an org-scoped caller.

const ORG_A = testClerkOrgId("org-a");
const ORG_B = testClerkOrgId("org-b");

function member(
	slug: string,
	clerkOrgId: string | undefined,
	roster: string[],
): OrgScope {
	return {
		userId: "user-member",
		orgSlug: slug,
		...(clerkOrgId !== undefined ? { orgClerkId: clerkOrgId } : {}),
		allowedOrchestrators: roster,
		allowedAgentIds: [],
		fleetWide: false,
		scopes: ["view-own-tasks"],
		isMaster: false,
	};
}

const scopeA = member("org-a", ORG_A, ["eta"]);

const ownRow = { orgId: "org-a", clerkOrgId: ORG_A, assignedTo: "eta" };
const otherOrgRow = { orgId: "org-b", clerkOrgId: ORG_B, assignedTo: "eta" };
// Same label as the caller's org, a DIFFERENT permanent ID: a new org that took
// a freed slug. The label never matches.
const sameLabelOtherIdRow = {
	orgId: "org-a",
	clerkOrgId: ORG_B,
	assignedTo: "eta",
};
// Same ID, renamed label: still the caller's org.
const renamedOwnRow = {
	orgId: "org-a-old-name",
	clerkOrgId: ORG_A,
	assignedTo: "eta",
};
const unstampedRow = { assignedTo: "eta" };
const labelOnlyRow = { orgId: "org-a", assignedTo: "eta" };

describe("filterByOrgScope — rows belong to an org by its ID", () => {
	test("own-org row is visible, also after the org's label was renamed", () => {
		expect(filterByOrgScope([ownRow, renamedOwnRow], scopeA)).toHaveLength(2);
	});
	test("other-org row is invisible", () => {
		expect(filterByOrgScope([otherOrgRow], scopeA)).toEqual([]);
	});
	test("a same-NAME agent of another org is not admitted, whatever the roster says", () => {
		// "eta" is on org A's roster and is the assignee of both rows; only the row
		// stamped with org A's ID is admitted.
		const kept = filterByOrgScope([otherOrgRow, sameLabelOtherIdRow], scopeA);
		expect(kept).toEqual([]);
	});
	test("an unstamped row is refused to an org-scoped caller", () => {
		expect(filterByOrgScope([unstampedRow, labelOnlyRow], scopeA)).toEqual([]);
	});
	test("a scope whose org ID is unknown admits nothing (a label is not an identity)", () => {
		const noId = member("org-a", undefined, ["eta"]);
		expect(filterByOrgScope([ownRow, labelOnlyRow], noId)).toEqual([]);
	});
});

describe("isRowVisibleToScope — a row fetched by handle belongs to an org by its ID", () => {
	test("own-org row is visible, also after the org's label was renamed", () => {
		expect(isRowVisibleToScope(scopeA, ownRow)).toBe(true);
		expect(isRowVisibleToScope(scopeA, renamedOwnRow)).toBe(true);
	});
	test("other-org row is invisible", () => {
		expect(isRowVisibleToScope(scopeA, otherOrgRow)).toBe(false);
	});
	test("a same-NAME agent of another org is not admitted", () => {
		expect(isRowVisibleToScope(scopeA, sameLabelOtherIdRow)).toBe(false);
	});
	test("an unstamped row is refused to an org-scoped caller", () => {
		expect(isRowVisibleToScope(scopeA, unstampedRow)).toBe(false);
		expect(isRowVisibleToScope(scopeA, labelOnlyRow)).toBe(false);
	});
});
