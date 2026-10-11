/// <reference types="vite/client" />
/**
 * kb:storeDocumentChunked and kb:softDeleteDocument — caller resolution, pinned.
 *
 * backend-doctor CR-1 classified both actions FAIL-OPEN ("resolves the principal
 * and BINDS NOTHING"). The caller WAS checked (assertScopeAuthorizesOrg on a scope
 * resolved through internal.lib.auth.resolveOrgScopeForAction); these poles prove
 * that, and pin the refusal CODE: an anonymous / no-organisation caller is refused
 * by RAISING `RBAC_DENIED` carrying the door's name (never a typed empty, never a
 * bare string with a different code).
 *
 * Three poles per door: REFUSED (anonymous, signed-in-no-org, org A against org B),
 * PRESENT (own-org member and the fleet master are served), and the writes that a
 * refusal must NOT have made (no chunk row, no storage binding, no soft-delete).
 */

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import schema from "../schema";

// biome-ignore lint/suspicious/noExplicitAny: action refs by string, codegen-independent
const STORE = "kb:storeDocumentChunked" as any;
// biome-ignore lint/suspicious/noExplicitAny: action refs by string, codegen-independent
const SOFT_DELETE = "kb:softDeleteDocument" as any;

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

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function seedOrg(t: T, slug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrg(t: T, slug: string) {
	return t.withIdentity({
		subject: `user-${slug}`,
		tokenIdentifier: `test|user-${slug}`,
		organizationId: slug,
		org_id: testClerkOrgId(slug),
	} as Parameters<typeof t.withIdentity>[0]);
}

function asNoOrg(t: T) {
	return t.withIdentity({
		subject: "user-no-org",
		tokenIdentifier: "test|user-no-org",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: T) {
	// CLERK_SERVICE_ACCOUNT_USER_ID in vitest.config.ts
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function storeBlob(t: T, text: string) {
	return await t.run(async (ctx) =>
		ctx.storage.store(new Blob([text], { type: "text/plain" })),
	);
}

async function seedChunk(t: T, orgId: string, docId: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("memories", {
			content: "chunk",
			type: "reference",
			namespace: `team/${orgId}/${docId}`,
			createdBy: "system",
			relations: [],
			isLatest: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function latestCount(t: T, orgId: string, docId: string) {
	return await t.run(
		async (ctx) =>
			(
				await ctx.db
					.query("memories")
					.withIndex("by_namespace", (q) =>
						q.eq("namespace", `team/${orgId}/${docId}`).eq("isLatest", true),
					)
					.collect()
			).length,
	);
}

async function allMemoryCount(t: T) {
	return await t.run(
		async (ctx) => (await ctx.db.query("memories").collect()).length,
	);
}

async function bindingCount(t: T) {
	return await t.run(
		async (ctx) => (await ctx.db.query("kbUploads").collect()).length,
	);
}

const storeArgs = (storageId: unknown, orgId: string, docId?: string) => ({
	storageId,
	mimeType: "text/plain",
	filename: "a.txt",
	orgId,
	namespace: `team/${orgId}`,
	...(docId ? { docId } : {}),
});

describe("kb:storeDocumentChunked — caller resolution", () => {
	test("REFUSED: anonymous caller is refused with RBAC_DENIED naming the door, and nothing is written", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const storageId = await storeBlob(t, "secret");
		await expect(
			t.action(STORE, storeArgs(storageId, "org-a", "d1")),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*kb:storeDocumentChunked/);
		expect(await allMemoryCount(t)).toBe(0);
		expect(await bindingCount(t)).toBe(0);
	});

	test("REFUSED: signed-in caller with no organisation is refused with RBAC_DENIED, nothing written", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const storageId = await storeBlob(t, "secret");
		await expect(
			asNoOrg(t).action(STORE, storeArgs(storageId, "org-a", "d1")),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*kb:storeDocumentChunked/);
		expect(await allMemoryCount(t)).toBe(0);
		expect(await bindingCount(t)).toBe(0);
	});

	test("REFUSED: org-a caller cannot write into org-b's namespace (AUTH_NAMESPACE_DENIED), no row, no binding", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const storageId = await storeBlob(t, "poison");
		await expect(
			asOrg(t, "org-a").action(STORE, storeArgs(storageId, "org-b", "d1")),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
		expect(await latestCount(t, "org-b", "d1")).toBe(0);
		expect(await allMemoryCount(t)).toBe(0);
		expect(await bindingCount(t)).toBe(0);
	});

	test("PRESENT: a member of org-a is served in its own namespace", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const storageId = await storeBlob(t, "hello\n\nworld");
		const r = await asOrg(t, "org-a").action(
			STORE,
			storeArgs(storageId, "org-a", "d1"),
		);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(r.docId).toBe("d1");
		expect(r.chunkCount).toBeGreaterThan(0);
		expect(await latestCount(t, "org-a", "d1")).toBe(r.chunkCount);
	});

	test("PRESENT: the fleet master may still ingest for any org (unchanged)", async () => {
		const t = createT();
		const storageId = await storeBlob(t, "hello");
		const r = await asMaster(t).action(
			STORE,
			storeArgs(storageId, "org-z", "d9"),
		);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(r.chunkCount).toBeGreaterThan(0);
		expect(await latestCount(t, "org-z", "d9")).toBe(r.chunkCount);
	});
});

describe("kb:softDeleteDocument — caller resolution", () => {
	test("REFUSED: anonymous caller is refused with RBAC_DENIED naming the door; chunks stay live", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedChunk(t, "org-a", "d1");
		await expect(
			t.action(SOFT_DELETE, {
				docId: "d1",
				orgId: "org-a",
				namespace: "team/org-a",
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*kb:softDeleteDocument/);
		expect(await latestCount(t, "org-a", "d1")).toBe(1);
	});

	test("REFUSED: signed-in caller with no organisation is refused with RBAC_DENIED; chunks stay live", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedChunk(t, "org-a", "d1");
		await expect(
			asNoOrg(t).action(SOFT_DELETE, {
				docId: "d1",
				orgId: "org-a",
				namespace: "team/org-a",
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*kb:softDeleteDocument/);
		expect(await latestCount(t, "org-a", "d1")).toBe(1);
	});

	test("REFUSED: org-a caller cannot delete org-b's document (AUTH_NAMESPACE_DENIED); chunks stay live", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedChunk(t, "org-b", "d1");
		await expect(
			asOrg(t, "org-a").action(SOFT_DELETE, {
				docId: "d1",
				orgId: "org-b",
				namespace: "team/org-b",
			}),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
		expect(await latestCount(t, "org-b", "d1")).toBe(1);
	});

	test("PRESENT: a member of org-a soft-deletes its own document; org-b's same docId is untouched", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await seedChunk(t, "org-a", "d1");
		await seedChunk(t, "org-b", "d1");
		const r = await asOrg(t, "org-a").action(SOFT_DELETE, {
			docId: "d1",
			orgId: "org-a",
			namespace: "team/org-a",
		});
		expect(r).toEqual({ docId: "d1", markedCount: 1 });
		expect(await latestCount(t, "org-a", "d1")).toBe(0);
		expect(await latestCount(t, "org-b", "d1")).toBe(1);
	});

	test("PRESENT: the fleet master may still soft-delete for any org (unchanged)", async () => {
		const t = createT();
		await seedChunk(t, "org-z", "d9");
		const r = await asMaster(t).action(SOFT_DELETE, {
			docId: "d9",
			orgId: "org-z",
			namespace: "team/org-z",
		});
		expect(r.markedCount).toBe(1);
	});
});
