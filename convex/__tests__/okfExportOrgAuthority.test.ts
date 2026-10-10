/// <reference types="vite/client" />
//
// Who may export an OKF bundle: the contract the by-ID conversion of
// okfBundleNode:exportOkfBundle (backend standard R-53) must keep. The
// other-org, same-org and service-account poles are pinned in
// okfMasterNamespaceExport.test.ts; this file adds the pole that file lacks,
// an INACTIVE org naming its own namespace, and repeats the four as one set.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import schema from "../schema";

// biome-ignore lint/suspicious/noExplicitAny: string ref, codegen-lag workaround
const EXPORT_REF = "okfBundleNode:exportOkfBundle" as any;

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

async function seedOrg(t: T, slug: string, isActive = true) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive,
			createdAt: Date.now(),
		});
	});
}

function asOrg(t: T, slug: string) {
	return t.withIdentity({
		subject: `user-${slug}`,
		tokenIdentifier: `test|user-${slug}`,
		organizationSlug: slug,
		org_id: testClerkOrgId(slug),
	} as Parameters<typeof t.withIdentity>[0]);
}

function asService(t: T) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

const args = (slug: string) => ({
	namespace: `team/${slug}`,
	format: "tarball" as const,
});

describe("exportOkfBundle — who may export", () => {
	test("REFUSED — another org's namespace", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		await seedOrg(t, "org-B");
		await expect(
			asOrg(t, "org-A").action(EXPORT_REF, args("org-B")),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("PRESENT — the same org exports its own namespace", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const r = await asOrg(t, "org-A").action(EXPORT_REF, args("org-A"));
		expect(r).toMatchObject({ fileCount: expect.any(Number) });
	});

	test("REFUSED — an inactive org naming its own namespace", async () => {
		const t = createT();
		await seedOrg(t, "org-off", false);
		await expect(
			asOrg(t, "org-off").action(EXPORT_REF, args("org-off")),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("PRESENT — the fleet service account exports any org's namespace", async () => {
		const t = createT();
		await seedOrg(t, "org-A");
		const r = await asService(t).action(EXPORT_REF, args("org-A"));
		expect(r).toMatchObject({ fileCount: expect.any(Number) });
	});
});
