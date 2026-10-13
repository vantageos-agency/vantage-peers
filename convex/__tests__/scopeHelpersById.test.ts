/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import type { Id } from "../_generated/dataModel";
import { scopedRowFilter } from "../lib/actingPrincipal";
import type { OrgScope } from "../lib/auth";
import schema from "../schema";

// Module M2 part 3: the row filter of a roster-scoped read decides a row's
// tenant by the permanent org ID the row is stamped with, never by a label or a
// name, and the roster by the agent ID the row carries. The decisions are
// @vantageos/cloud-identity's (`filterTargetsInPersonScope`); these poles pin
// that this backend hands it IDs only. Five poles: own-org row visible (also
// after a rename), other-org row invisible, a same-LABEL org with another ID not
// admitted, an unstamped row refused to an org-scoped caller, an unknown org ID
// admits nothing.

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);

const ORG_A = testClerkOrgId("org-a");
const ORG_B = testClerkOrgId("org-b");

async function world() {
	const t = createT();
	const ids = await t.run(async (ctx) => {
		const out: Record<string, Id<"agents">> = {};
		for (const [slug, name] of [
			["org-a", "eta"],
			["org-b", "eta"],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [name],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: 1,
			});
			out[slug] = await ctx.db.insert("agents", {
				orgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				name,
				normalizedName: name,
				isActive: true,
				createdAt: 1,
			});
		}
		return out;
	});
	return { t, etaA: ids["org-a"], etaB: ids["org-b"] };
}

function member(
	clerkOrgId: string | undefined,
	roster: readonly string[],
): OrgScope {
	return {
		userId: "user-member",
		orgSlug: "org-a",
		...(clerkOrgId !== undefined ? { orgClerkId: clerkOrgId } : {}),
		allowedOrchestrators: [],
		allowedAgentIds: [...roster],
		fleetWide: false,
		scopes: ["view-own-tasks"],
		isMaster: false,
	};
}

describe("scopedRowFilter — rows belong to an org by its ID", () => {
	test("PRESENT: an own-org row naming a rostered agent is visible, also after the org's label was renamed", async () => {
		const { t, etaA } = await world();
		const scopeA = member(ORG_A, [etaA]);
		const own = { orgId: "org-a", clerkOrgId: ORG_A, assignedToId: etaA };
		const renamed = { orgId: "org-a-old-name", clerkOrgId: ORG_A, assignedToId: etaA };
		const kept = await t.run(async (ctx) =>
			(await scopedRowFilter(ctx, scopeA, "test"))([own, renamed]),
		);
		expect(kept).toHaveLength(2);
	});

	test("REFUSED: an other-org row is invisible", async () => {
		const { t, etaA, etaB } = await world();
		const scopeA = member(ORG_A, [etaA]);
		const kept = await t.run(async (ctx) =>
			(await scopedRowFilter(ctx, scopeA, "test"))([
				{ orgId: "org-b", clerkOrgId: ORG_B, assignedToId: etaB },
			]),
		);
		expect(kept).toEqual([]);
	});

	test("CROSS-ORG: a row with the caller's LABEL but another org's ID, and a same-NAME agent of another org, are not admitted", async () => {
		const { t, etaA, etaB } = await world();
		const scopeA = member(ORG_A, [etaA]);
		const kept = await t.run(async (ctx) =>
			(await scopedRowFilter(ctx, scopeA, "test"))([
				{ orgId: "org-a", clerkOrgId: ORG_B, assignedToId: etaA },
				{ orgId: "org-b", clerkOrgId: ORG_B, assignedToId: etaB },
			]),
		);
		expect(kept).toEqual([]);
	});

	test("REFUSED: an unstamped row, and a row stamped with a label only, are refused to an org-scoped caller", async () => {
		const { t, etaA } = await world();
		const scopeA = member(ORG_A, [etaA]);
		const kept = await t.run(async (ctx) =>
			(await scopedRowFilter(ctx, scopeA, "test"))([
				{ assignedToId: etaA },
				{ orgId: "org-a", assignedToId: etaA },
			]),
		);
		expect(kept).toEqual([]);
	});

	test("REFUSED: a row naming an agent off the stored roster, or naming none, is dropped", async () => {
		const { t, etaA } = await world();
		const scopeA = member(ORG_A, []);
		const onlyA = member(ORG_A, [etaA]);
		const kept = await t.run(async (ctx) =>
			(await scopedRowFilter(ctx, onlyA, "test"))([
				{ orgId: "org-a", clerkOrgId: ORG_A },
				{ orgId: "org-a", clerkOrgId: ORG_A, assignedToId: "someone-else" },
			]),
		);
		expect(kept).toEqual([]);
		// An organisation that stores no roster is the package's refusal, not an empty success.
		await expect(
			t.run(async (ctx) =>
				(await scopedRowFilter(ctx, scopeA, "test"))([
					{ orgId: "org-a", clerkOrgId: ORG_A, assignedToId: etaA },
				]),
			),
		).rejects.toThrow(/person-scope-empty/);
	});

	test("REFUSED: a scope whose org ID is unknown admits nothing (a label is not an identity)", async () => {
		const { t, etaA } = await world();
		const noId = member(undefined, [etaA]);
		await expect(
			t.run(async (ctx) =>
				(await scopedRowFilter(ctx, noId, "test"))([
					{ orgId: "org-a", assignedToId: etaA },
				]),
			),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("ABSENT: no rows is an empty success for a served member", async () => {
		const { t, etaA } = await world();
		const scopeA = member(ORG_A, [etaA]);
		const kept = await t.run(async (ctx) =>
			(await scopedRowFilter(ctx, scopeA, "test"))([]),
		);
		expect(kept).toEqual([]);
	});

	test("the fleet sees every row", async () => {
		const { t } = await world();
		const fleet: OrgScope = {
			userId: "svc",
			orgSlug: null,
			allowedOrchestrators: [],
			allowedAgentIds: [],
			fleetWide: true,
			scopes: [],
			isMaster: true,
			masterSource: "service-account",
		};
		const rows = [{ orgId: "org-b", clerkOrgId: ORG_B }, { assignedToId: "x" }];
		const kept = await t.run(async (ctx) =>
			(await scopedRowFilter(ctx, fleet, "test"))(rows),
		);
		expect(kept).toHaveLength(2);
	});
});
