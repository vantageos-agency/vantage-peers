/// <reference types="vite/client" />
//
// validate_okf_bundle reads a caller-supplied storageId from the shared
// `_storage`. It once admitted ANY identified caller to ANY blob (a
// cross-tenant peek at entry paths, counts and validation messages). The read
// is now ASSERT-ONLY against the ownership binding the upload/store path
// writes (kbMutations:bindOrAssertStorageOwnership, table kbUploads, bound by
// kb:storeDocumentChunked and the export path): validate never binds, so the
// first org to validate a leaked storageId does NOT become its owner, and the
// tool stays read-only (readOnlyHint=true agrees with a handler that reaches
// no mutation — mcp-server/test/tool-annotations-agree-with-handlers.test.ts).
//
// Poles, under scoped identities of active orgs:
//   REFUSED  unbound storageId -> AUTH_STORAGE_UNBOUND, no binding row created
//   REFUSED  storageId bound to another org -> AUTH_STORAGE_NOT_OWNED, both directions
//   PRESENT  the owner validates after its store binding; the binding is untouched
//   REFUSED  a signed-in caller with no organisation -> RBAC_DENIED
//
// Backend standard R-8 (scope check on a data op). Argus REVISE on #1465.

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { packTarball } from "../okfBundleNode";
import schema from "../schema";

// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround (see okfBundleValidate.test.ts)
const VALIDATE_ACTION_REF = "okfBundleNode:validateOkfBundle" as any;

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

async function seedOrgMapping(t: T, clerkOrgSlug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrg(t: T, orgId: string) {
	return t.withIdentity({
		subject: `user-${orgId}`,
		tokenIdentifier: `test|user-${orgId}`,
		organizationId: orgId,
	} as Parameters<typeof t.withIdentity>[0]);
}

async function storeBundle(t: T): Promise<Id<"_storage">> {
	const buf = await packTarball([
		{
			path: "index.md",
			content: '---\nokf_version: "0.1"\ntype: index\n---\n# Bundle\n',
		},
	]);
	return await t.run(async (ctx) =>
		ctx.storage.store(new Blob([new Uint8Array(buf)])),
	);
}

/** The store path's own binding door (kb:storeDocumentChunked calls it). */
async function bindOnStore(t: T, storageId: Id<"_storage">, orgId: string) {
	await t.mutation(internal.kbMutations.bindOrAssertStorageOwnership, {
		storageId,
		orgId,
	});
}

async function bindingsOf(t: T, storageId: Id<"_storage">) {
	return await t.run(async (ctx) =>
		ctx.db
			.query("kbUploads")
			.withIndex("by_storageId", (q) => q.eq("storageId", storageId))
			.collect(),
	);
}

describe("validate_okf_bundle — storage ownership is asserted, never claimed", () => {
	test("REFUSED — an unbound storageId is refused and validate creates no binding", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		const storageId = await storeBundle(t);

		await expect(
			asOrg(t, "org-A").action(VALIDATE_ACTION_REF, { storageId }),
		).rejects.toThrow(/AUTH_STORAGE_UNBOUND/);
		expect(await bindingsOf(t, storageId)).toEqual([]);
	});

	test("REFUSED — org-B cannot validate a blob bound to org-A", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		await seedOrgMapping(t, "org-B");
		const storageId = await storeBundle(t);
		await bindOnStore(t, storageId, "org-A");

		await expect(
			asOrg(t, "org-B").action(VALIDATE_ACTION_REF, { storageId }),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
		const rows = await bindingsOf(t, storageId);
		expect(rows.map((r) => r.orgId)).toEqual(["org-A"]);
	});

	test("REFUSED — the other direction: org-A cannot validate a blob bound to org-B", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		await seedOrgMapping(t, "org-B");
		const storageId = await storeBundle(t);
		await bindOnStore(t, storageId, "org-B");

		await expect(
			asOrg(t, "org-A").action(VALIDATE_ACTION_REF, { storageId }),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
	});

	test("PRESENT — the owner validates after its store binding, and the binding is untouched", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		const storageId = await storeBundle(t);
		await bindOnStore(t, storageId, "org-A");
		const before = await bindingsOf(t, storageId);

		const result = await asOrg(t, "org-A").action(VALIDATE_ACTION_REF, {
			storageId,
		});
		expect(result.schemaVersion).toBe("0.1");
		expect(await bindingsOf(t, storageId)).toEqual(before);
	});

	test("REFUSED — a signed-in caller with no organisation is refused RBAC_DENIED", async () => {
		const t = createT();
		const storageId = await storeBundle(t);
		await bindOnStore(t, storageId, "org-A");

		await expect(
			asOrg(t, "org-unmapped").action(VALIDATE_ACTION_REF, { storageId }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// A refusal must be distinguishable from a crash: Convex prod redacts a plain
	// Error's message to "[Request ID] Server Error", so the code has to travel in
	// ConvexError.data (rule: refusal-is-distinguishable-from-absence, rule 2).
	async function refusalOf(p: Promise<unknown>): Promise<unknown> {
		try {
			await p;
		} catch (e) {
			expect(e).toBeInstanceOf(ConvexError);
			return (e as ConvexError<string>).data;
		}
		throw new Error("expected a refusal, call succeeded");
	}

	test("REFUSED — unbound refusal carries RBAC_DENIED and the door in errorData", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		const storageId = await storeBundle(t);

		const data = await refusalOf(
			asOrg(t, "org-A").action(VALIDATE_ACTION_REF, { storageId }),
		);
		expect(String(data)).toContain("RBAC_DENIED");
		expect(String(data)).toContain("okfBundleNode:validateOkfBundle");
		expect(String(data)).toContain("storage-unbound");
		expect(String(data)).toContain("AUTH_STORAGE_UNBOUND");
	});

	test("REFUSED — not-owned refusal carries RBAC_DENIED and the door in errorData", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		await seedOrgMapping(t, "org-B");
		const storageId = await storeBundle(t);
		await bindOnStore(t, storageId, "org-A");

		const data = await refusalOf(
			asOrg(t, "org-B").action(VALIDATE_ACTION_REF, { storageId }),
		);
		expect(String(data)).toContain("RBAC_DENIED");
		expect(String(data)).toContain("okfBundleNode:validateOkfBundle");
		expect(String(data)).toContain("storage-not-owned");
		expect(String(data)).toContain("AUTH_STORAGE_NOT_OWNED");
	});
});
