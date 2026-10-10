/// <reference types="vite/client" />
//
// import_okf_bundle reads a caller-supplied storageId from the shared
// `_storage`. A storageId is a handle into storage every org shares, so
// passing the namespace gate is not authority to read another organisation's
// blob: importing it copies that organisation's bundle into the caller's own
// namespace (a cross-tenant read that also writes).
//
// The read is ASSERT-ONLY against the ownership binding the upload/store/export
// paths write (kbMutations:getStorageOwner, table kbUploads), exactly like
// validate_okf_bundle (okfValidateStorageOwnership.test.ts): import never binds,
// so the first org to import a leaked storageId does NOT become its owner.
// The producer paths bind: exportOkfBundle binds the id it creates to the
// exporter's verified org before it returns the URL.
//
// Poles, under scoped identities of active orgs:
//   REFUSED  org-B imports a blob bound to org-A (the cross-tenant read), no row
//   REFUSED  the other direction
//   REFUSED  an unbound storageId is refused and import creates no binding
//   PRESENT  the owner imports its own bound blob, twice, binding untouched
//   PRESENT  an org's own export is bound to it, imports back, and org-B is refused
//   REFUSED  a signed-in caller with no organisation -> RBAC_DENIED
//
// Backend standard R-8 (scope check on a data op).

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { packTarball } from "../okfBundleNode";
import { serializeMemory } from "../okfSerializer";
import schema from "../schema";

// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround (see okfBundleImport.test.ts)
const IMPORT_ACTION_REF = "okfBundleNode:importOkfBundle" as any;
// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround (see okfBundleImport.test.ts)
const EXPORT_ACTION_REF = "okfBundleNode:exportOkfBundle" as any;

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
			clerkOrgId: testClerkOrgId(clerkOrgSlug),
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
		org_id: testClerkOrgId(orgId),
	} as Parameters<typeof t.withIdentity>[0]);
}

async function storeBundle(t: T): Promise<Id<"_storage">> {
	const mem = serializeMemory({
		_id: "k179mem001" as never,
		_creationTime: 1_700_000_000_000,
		type: "reference",
		namespace: "team/org-A",
		content: "Org A private memory body.",
		createdBy: "sigma",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
	});
	const buf = await packTarball([
		{
			path: "index.md",
			content: '---\nokf_version: "0.1"\ntype: index\n---\n# Bundle\n',
		},
		{ path: mem.filePath, content: mem.content },
	]);
	return await t.run(async (ctx) =>
		ctx.storage.store(new Blob([new Uint8Array(buf)])),
	);
}

/** The store path's own binding door (kb:storeDocumentChunked / the export). */
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

async function memoryRowCount(t: T): Promise<number> {
	return await t.run(
		async (ctx) => (await ctx.db.query("memories").collect()).length,
	);
}

const importArgs = (storageId: Id<"_storage">, org: string) => ({
	storageId,
	targetNamespace: `team/${org}`,
	mode: "merge" as const,
	idempotencyKey: `own-${org}-${storageId}`,
});

describe("import_okf_bundle — storage ownership is asserted, never claimed", () => {
	test("REFUSED — org-B cannot import a blob bound to org-A, and writes no row", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		await seedOrgMapping(t, "org-B");
		const storageId = await storeBundle(t);
		await bindOnStore(t, storageId, "org-A");

		await expect(
			asOrg(t, "org-B").action(
				IMPORT_ACTION_REF,
				importArgs(storageId, "org-B"),
			),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
		expect(await memoryRowCount(t)).toBe(0);
		expect((await bindingsOf(t, storageId)).map((r) => r.orgId)).toEqual([
			"org-A",
		]);
	});

	test("REFUSED — the other direction: org-A cannot import a blob bound to org-B", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		await seedOrgMapping(t, "org-B");
		const storageId = await storeBundle(t);
		await bindOnStore(t, storageId, "org-B");

		await expect(
			asOrg(t, "org-A").action(
				IMPORT_ACTION_REF,
				importArgs(storageId, "org-A"),
			),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
		expect(await memoryRowCount(t)).toBe(0);
	});

	test("REFUSED — an unbound storageId is refused and import creates no binding", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		const storageId = await storeBundle(t);

		await expect(
			asOrg(t, "org-A").action(
				IMPORT_ACTION_REF,
				importArgs(storageId, "org-A"),
			),
		).rejects.toThrow(/AUTH_STORAGE_UNBOUND/);
		expect(await bindingsOf(t, storageId)).toEqual([]);
		expect(await memoryRowCount(t)).toBe(0);
	});

	test("PRESENT — the owner imports its bound blob, twice, and the binding is untouched", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		const storageId = await storeBundle(t);
		await bindOnStore(t, storageId, "org-A");
		const before = await bindingsOf(t, storageId);

		const first = await asOrg(t, "org-A").action(
			IMPORT_ACTION_REF,
			importArgs(storageId, "org-A"),
		);
		expect(first.imported.memories).toBe(1);
		const again = await asOrg(t, "org-A").action(IMPORT_ACTION_REF, {
			...importArgs(storageId, "org-A"),
			idempotencyKey: "own-org-A-second",
		});
		expect(again.skipped).toBe(1);
		expect(await bindingsOf(t, storageId)).toEqual(before);
	});

	test("PRESENT — an org's own export is bound to it at creation, imports back, and another org is refused", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		await seedOrgMapping(t, "org-B");
		const exported = await asOrg(t, "org-A").action(EXPORT_ACTION_REF, {
			namespace: "team/org-A",
			format: "tarball",
		});
		const storageId = exported.storageId as Id<"_storage">;

		expect((await bindingsOf(t, storageId)).map((r) => r.orgId)).toEqual([
			"org-A",
		]);
		const back = await asOrg(t, "org-A").action(
			IMPORT_ACTION_REF,
			importArgs(storageId, "org-A"),
		);
		expect(back.imported).toBeDefined();
		await expect(
			asOrg(t, "org-B").action(
				IMPORT_ACTION_REF,
				importArgs(storageId, "org-B"),
			),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
	});

	test("REFUSED — a signed-in caller with no organisation is refused RBAC_DENIED and binds nothing", async () => {
		const t = createT();
		const storageId = await storeBundle(t);
		await bindOnStore(t, storageId, "org-A");

		await expect(
			asOrg(t, "org-unmapped").action(
				IMPORT_ACTION_REF,
				importArgs(storageId, "org-unmapped"),
			),
		).rejects.toThrow(/RBAC_DENIED/);
		expect((await bindingsOf(t, storageId)).map((r) => r.orgId)).toEqual([
			"org-A",
		]);
		expect(await memoryRowCount(t)).toBe(0);
	});

	// A refusal must be distinguishable from a crash: Convex prod redacts a plain
	// Error's message to "[Request ID] Server Error", so the code has to travel in
	// ConvexError.data (rule: refusal-is-distinguishable-from-absence, rule 2).
	async function refusalOf(p: Promise<unknown>): Promise<string> {
		try {
			await p;
		} catch (e) {
			expect(e).toBeInstanceOf(ConvexError);
			return String((e as ConvexError<string>).data);
		}
		throw new Error("expected a refusal, call succeeded");
	}

	test("REFUSED — unbound refusal carries RBAC_DENIED and the door in errorData", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		const storageId = await storeBundle(t);

		const data = await refusalOf(
			asOrg(t, "org-A").action(
				IMPORT_ACTION_REF,
				importArgs(storageId, "org-A"),
			),
		);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("okfBundleNode:importOkfBundle");
		expect(data).toContain("storage-unbound");
		expect(data).toContain("AUTH_STORAGE_UNBOUND");
	});

	test("REFUSED — not-owned refusal carries RBAC_DENIED and the door in errorData", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-A");
		await seedOrgMapping(t, "org-B");
		const storageId = await storeBundle(t);
		await bindOnStore(t, storageId, "org-A");

		const data = await refusalOf(
			asOrg(t, "org-B").action(
				IMPORT_ACTION_REF,
				importArgs(storageId, "org-B"),
			),
		);
		expect(data).toContain("RBAC_DENIED");
		expect(data).toContain("okfBundleNode:importOkfBundle");
		expect(data).toContain("storage-not-owned");
		expect(data).toContain("AUTH_STORAGE_NOT_OWNED");
	});
});
