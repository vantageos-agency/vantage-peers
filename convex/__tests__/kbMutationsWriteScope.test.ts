/// <reference types="vite/client" />
/**
 * kbMutations.generateUploadUrl — write-scope enforcement.
 *
 * DEFECT (pre-fix, on main): the ONLY check this mutation ran was
 * `assertOrgArgs`, which validates the CLIENT-SUPPLIED `args.orgId` string
 * is non-empty and namespace-consistent — never that it belongs to the
 * caller. A direct call to this public Convex deployment (bypassing the MCP
 * kb-ingest tool layer entirely — "a guard in the MCP server is NOT a
 * defence", per the brief) could mint an upload URL asserting ANY orgId.
 *
 * Fix: derive the caller's own org via `withOrgScope`
 * (convex/lib/auth.ts) and REFUSE an anonymous caller outright, and refuse
 * any org-scoped caller whose OWN resolved org does not match the `orgId`
 * argument it is asserting (narrowing check — never trust the argument
 * alone). Defect class: .claude/rules/authority-attached-to-anonymous-object.md /
 * .claude/rules/http-boundary-derives-from-principal.md.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asOrgB(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-b",
		organizationId: "org-b",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedOrgMapping(t: ReturnType<typeof createT>, slug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			allowedOrchestrators: [`seat-${slug}`],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

describe("kbMutations.generateUploadUrl — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await expect(
			t.mutation(api.kbMutations.generateUploadUrl, {
				orgId: "org-a",
				namespace: "team/org-a/doc-1",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("a caller asserting a DIFFERENT org than its own verified org is refused (cross-tenant)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");
		const tA = asOrgA(t);

		// Named attack: org-a's own verified identity, asserting org-b's orgId.
		await expect(
			tA.mutation(api.kbMutations.generateUploadUrl, {
				orgId: "org-b",
				namespace: "team/org-b/doc-1",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("a caller asserting its OWN verified org succeeds", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const tA = asOrgA(t);

		const url = await tA.mutation(api.kbMutations.generateUploadUrl, {
			orgId: "org-a",
			namespace: "team/org-a/doc-1",
		});
		expect(typeof url).toBe("string");
		expect(url.length).toBeGreaterThan(0);
	});

	test("the master/service-account identity may mint an upload URL for any orgId (legacy/internal)", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const url = await tMaster.mutation(api.kbMutations.generateUploadUrl, {
			orgId: "any-org",
			namespace: "team/any-org/doc-1",
		});
		expect(typeof url).toBe("string");
		expect(url.length).toBeGreaterThan(0);
	});
});
