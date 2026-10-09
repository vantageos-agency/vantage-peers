/// <reference types="vite/client" />
/**
 * R4 RED reproduction — kb doors (storeDocumentChunked first-claim binding, softDeleteDocument RAG
 * supersede). Identity: ordinary org members (org-a / org-b), NOT the service account.
 * Retrieval through @convex-dev/rag cannot be driven in convex-test (no embeddings), so the
 * soft-delete property is measured the way the repo already measures indexing
 * (convex/__tests__/kb.document-indexing.test.ts): the _scheduled_functions system table.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
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

const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `user-${org}`,
		tokenIdentifier: `test|user-${org}`,
		organizationId: org,
		orgRole: "org:member",
	} as Parameters<typeof t.withIdentity>[0]);

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		for (const org of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

const storeBlob = (t: T, text: string) =>
	t.run((ctx) => ctx.storage.store(new Blob([new TextEncoder().encode(text)], { type: "text/plain" })));

const scheduledNames = async (t: T) =>
	(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).map((f) =>
		JSON.stringify(f.name),
	);

describe("kb:storeDocumentChunked — storage ownership", () => {
	test("kb:storeDocumentChunked — org-b cannot ingest an UNBOUND blob that org-a uploaded through the plain upload URL (no first-claim)", async () => {
		const t = createT();
		await seedOrgs(t);
		// A blob uploaded via the plain generateUploadUrl is NOT bound in kbUploads (that mutation never binds).
		const storageId = await storeBlob(t, "org-a private bytes");
		let err = "NO-ERROR";
		try {
			await asMember(t, "org-b").action(api.kb.storeDocumentChunked, {
				storageId,
				orgId: "org-b",
				namespace: "team/org-b",
				mimeType: "text/plain",
				filename: "x",
			});
		} catch (e) {
			err = String(e);
		}
		const bound = await t.run((ctx) => ctx.db.query("kbUploads").collect());
		const chunks = await t.run((ctx) => ctx.db.query("memories").collect());
		await t.finishAllScheduledFunctions(vi.runAllTimers).catch(() => undefined);
		expect({ err, boundOrgs: bound.map((b) => b.orgId), chunkCount: chunks.length }).toEqual({
			err: expect.stringMatching(/AUTH_STORAGE_UNBOUND|AUTH_STORAGE_NOT_OWNED|AUTH_/),
			boundOrgs: [],
			chunkCount: 0,
		});
	});

	test("kb:storeDocumentChunked — positive control: a blob already bound to org-a is refused to org-b with AUTH_STORAGE_NOT_OWNED", async () => {
		const t = createT();
		await seedOrgs(t);
		const storageId = await storeBlob(t, "bound to a");
		await t.run((ctx) => ctx.db.insert("kbUploads", { storageId, orgId: "org-a", createdAt: 1 }));
		await expect(
			asMember(t, "org-b").action(api.kb.storeDocumentChunked, {
				storageId,
				orgId: "org-b",
				namespace: "team/org-b",
				mimeType: "text/plain",
				filename: "x",
			}),
		).rejects.toThrow(/AUTH_STORAGE_NOT_OWNED/);
	});

	test("kb:storeDocumentChunked — positive control: a blob bound to org-b is ingested by org-b", async () => {
		const t = createT();
		await seedOrgs(t);
		const storageId = await storeBlob(t, "bound to b with enough text to chunk");
		await t.run((ctx) => ctx.db.insert("kbUploads", { storageId, orgId: "org-b", createdAt: 1 }));
		const r = await asMember(t, "org-b").action(api.kb.storeDocumentChunked, {
			storageId,
			orgId: "org-b",
			namespace: "team/org-b",
			mimeType: "text/plain",
			filename: "x",
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers).catch(() => undefined);
		expect(r.chunkCount).toBeGreaterThan(0);
	});
});

describe("kb:softDeleteDocument — RAG entry supersede", () => {
	async function ingest(t: T) {
		const storageId = await storeBlob(t, "secret passage about the deleted document");
		await t.run((ctx) => ctx.db.insert("kbUploads", { storageId, orgId: "org-a", createdAt: 1 }));
		const r = await asMember(t, "org-a").action(api.kb.storeDocumentChunked, {
			storageId,
			orgId: "org-a",
			namespace: "team/org-a",
			mimeType: "text/plain",
			filename: "d1",
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers).catch(() => undefined);
		return r;
	}

	test("kb:softDeleteDocument — deleting a document schedules ragSync.markRagEntrySuperseded for its chunk (so recall stops serving it)", async () => {
		const t = createT();
		await seedOrgs(t);
		const { docId, chunkCount } = await ingest(t);
		const before = (await scheduledNames(t)).filter((n) => n.includes("markRagEntrySuperseded")).length;
		const del = await asMember(t, "org-a").action(api.kb.softDeleteDocument, {
			docId,
			orgId: "org-a",
			namespace: "team/org-a",
		});
		expect(del.markedCount).toBe(chunkCount);
		const after = (await scheduledNames(t)).filter((n) => n.includes("markRagEntrySuperseded")).length;
		expect(after - before).toBe(chunkCount);
	});

	test("kb:softDeleteDocument — positive control: memories:softDeleteMemory DOES schedule markRagEntrySuperseded (the contract the doc delete must match)", async () => {
		const t = createT();
		await seedOrgs(t);
		const id = await t.run((ctx) =>
			ctx.db.insert("memories", {
				namespace: "team/org-a",
				type: "user",
				content: "c",
				createdBy: "x",
				relations: [],
				isLatest: true,
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		await asMember(t, "org-a").mutation(api.memories.softDeleteMemory, { memoryId: id });
		const n = (await scheduledNames(t)).filter((x) => x.includes("markRagEntrySuperseded")).length;
		expect(n).toBe(1);
	});
});
