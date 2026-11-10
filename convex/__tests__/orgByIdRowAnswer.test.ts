/// <reference types="vite/client" />
/**
 * The `orgById` row adapter (convex/lib/orgIdLookups.ts) answers the package's
 * OrgMappingRow EXACTLY: every member the installed @vantageos/cloud-identity
 * declares, each read from the stored row. 0.29.0 added
 * `addressableFleetCoordinatorIds`; an adapter that omitted it kept answering
 * the old shape, so the package could never surface the roster and the
 * backend-doctor (R-53 predicate (6), keys derived from the installed package)
 * stopped reading the adapter as package storage (task
 * k1726h1v7hqdbk818bn8s1rgdx8hy0ts).
 */

import { convexTest } from "convex-test";
import { orgMappingRowSchema } from "@vantageos/cloud-identity";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { orgByIdLookups } from "../lib/orgIdLookups";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const ORG = "row-answer-org";

async function seed(withCoordinators: boolean) {
	const t = convexTest(schema, modules);
	return t.run(async (ctx) => {
		const coordinator = await ctx.db.insert("agents", {
			orgSlug: "operator-org",
			clerkOrgId: testClerkOrgId("operator-org"),
			name: "pi",
			normalizedName: "pi",
			isActive: true,
			createdAt: 1,
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: ORG,
			clerkOrgId: testClerkOrgId(ORG),
			allowedOrchestrators: ["eve"],
			scopes: ["view-own-tasks"],
			displayName: ORG,
			isActive: true,
			createdAt: 1,
			...(withCoordinators
				? { addressableFleetCoordinatorIds: [coordinator] }
				: {}),
		});
		const answer = await orgByIdLookups(ctx).orgById(testClerkOrgId(ORG));
		// Keys are read inside `run`: the value crossing out of it drops `undefined`.
		return { answer, coordinator, keys: Object.keys(answer ?? {}) };
	});
}

describe("orgById answers the package's OrgMappingRow exactly", () => {
	test("PRESENT: a row with a coordinator roster answers it by ID", async () => {
		const { answer, coordinator } = await seed(true);
		expect(answer?.addressableFleetCoordinatorIds).toEqual([coordinator]);
		expect(answer?.id).toBe(testClerkOrgId(ORG));
		expect(answer?.label).toBe(ORG);
		expect(answer?.active).toBe(true);
	});

	test("ABSENT: a row with no roster answers none, never a fabricated list", async () => {
		const { answer } = await seed(false);
		expect(answer).not.toBeNull();
		expect(answer?.addressableFleetCoordinatorIds).toBeUndefined();
	});

	test("every member of the installed OrgMappingRow is a key of the answer", async () => {
		const { keys } = await seed(true);
		const members = Object.keys(orgMappingRowSchema.shape).sort();
		expect(keys.sort()).toEqual(members);
	});
});
