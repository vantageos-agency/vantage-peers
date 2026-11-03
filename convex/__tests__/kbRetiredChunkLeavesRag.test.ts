/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud KB: a chunk the memories table has RETIRED (soft-deleted
// document, or superseded by a re-ingest) must also leave the RAG search index.
//
// Measured on prod (2026-11-03, probe-tenant-a seat): hybrid_search on the exact
// document namespace `team/<org ID>/324c1715-...` returns the document, while
// hybrid_search AND text_search on the root `team/<org ID>` return []. The root
// fan-out (convex/kbMutations.ts listDocNamespacesUnderRoot) enumerates the
// namespaces from the memories rows with isLatest=true; the exact search asks
// the RAG index, whose entry still carries the filter isLatest="true" because
// kbMutations.markDocSoftDeleted / supersedePriorChunks flip only the memories
// row and never re-index the RAG entry (the memories path, convex/memories.ts,
// does: ragSync.markRagEntrySuperseded). Two stores, two answers.
//
// The RAG backend is a fake that behaves like the real one on the property that
// matters: it answers from the entries indexed under the EXACT namespace and
// honours the isLatest filter value stored on the entry. The scheduled
// ragSync.markRagEntrySuperseded job (a "use node" action, not loadable in
// convex-test) is applied to the fake by reading the _scheduled_functions table,
// exactly as the real action re-adds the entry under the same key with
// isLatest="false".
//
// POLES
//   PRESENT   a live document ingested as insertChunk writes it (stamped row) is
//             found by the root and by the exact namespace.
//   RETIRED   after a soft-delete, neither the root nor the exact namespace
//             returns the document (RED before the fix: the exact namespace did).
//   SUPERSEDED after a re-ingest of the same docId, the exact namespace returns
//             only the new chunk (RED before the fix: old and new).
//   NEGATIVE  another document of the same org is untouched by the retirement.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { __setQueryEmbedderForTests, __setRagSearcherForTests } from "../search";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const X = "org-x";
const X_ID = testClerkOrgId(X);

const asMember = (t: T, slug: string) =>
	t.withIdentity({
		subject: `user-${slug}`,
		organizationId: slug,
		organizationSlug: slug,
		org_id: testClerkOrgId(slug),
	} as Identity);

async function seedOrg(t: T, slug: string): Promise<void> {
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

// RAG fake: entries per exact namespace, each with its isLatest filter value.
type Entry = { key: string; text: string; isLatest: "true" | "false" };
const indexed = new Map<string, Entry[]>();

/** What kb:storeDocumentChunked does for one chunk: insertChunk, then addRagEntry. */
async function ingestChunk(
	t: T,
	namespace: string,
	text: string,
): Promise<Id<"memories">> {
	const id = await t.mutation(internal.kbMutations.insertChunk, {
		namespace,
		content: text,
		filename: "doc.md",
		mimeType: "text/markdown",
		chunkIndex: 0,
		storageId: "kg-storage",
		docId: namespace.split("/").pop() ?? "",
	});
	const list = indexed.get(namespace) ?? [];
	list.push({ key: id as string, text, isLatest: "true" });
	indexed.set(namespace, list);
	return id;
}

/** Applies every scheduled ragSync.markRagEntrySuperseded to the fake index. */
async function applyScheduledRagSupersedes(t: T): Promise<number> {
	const jobs = await t.run(async (ctx) =>
		ctx.db.system.query("_scheduled_functions").collect(),
	);
	let applied = 0;
	for (const job of jobs) {
		if (!String(job.name).includes("markRagEntrySuperseded")) continue;
		const a = job.args[0] as { memoryId: string; namespace: string };
		for (const e of indexed.get(a.namespace) ?? []) {
			if (e.key === a.memoryId) e.isLatest = "false";
		}
		applied++;
	}
	return applied;
}

beforeEach(() => {
	indexed.clear();
	__setQueryEmbedderForTests(async () => [0.1, 0.2, 0.3]);
	__setRagSearcherForTests((async (
		_ctx: unknown,
		args: {
			namespace: string;
			filters?: Array<{ name: string; value: string }>;
		},
	) => {
		const wantLatest = args.filters?.find((f) => f.name === "isLatest")?.value;
		const rows = (indexed.get(args.namespace) ?? []).filter(
			(e) => wantLatest === undefined || e.isLatest === wantLatest,
		);
		return {
			results: rows.map((r, i) => ({
				entryId: `${args.namespace}#${r.key}`,
				score: 0.9 - i * 0.01,
				content: [{ text: r.text }],
			})),
			entries: rows.map((r) => ({
				entryId: `${args.namespace}#${r.key}`,
				key: r.key,
				filterValues: [
					{ name: "namespace", value: args.namespace },
					{ name: "type", value: "reference" },
				],
			})),
		};
	}) as unknown as Parameters<typeof __setRagSearcherForTests>[0]);
});
afterEach(() => {
	__setRagSearcherForTests(null);
	__setQueryEmbedderForTests(null);
});

const search = async (t: T, namespace: string) =>
	(await asMember(t, X).action(api.search.textSearch, {
		query: "anything",
		namespace,
	})) as Array<{ memoryId: string }>;

describe("a retired KB chunk leaves the RAG index, so the root and the exact namespace agree", () => {
	test("PRESENT: a live document is found by the root and by its exact namespace", async () => {
		const t = createT();
		await seedOrg(t, X);
		const id = await ingestChunk(t, `team/${X_ID}/doc-a`, "alpha");
		expect((await search(t, `team/${X_ID}`)).map((r) => r.memoryId)).toEqual([
			id,
		]);
		expect(
			(await search(t, `team/${X_ID}/doc-a`)).map((r) => r.memoryId),
		).toEqual([id]);
	});

	test("RETIRED: a soft-deleted document is returned by neither the root nor the exact namespace", async () => {
		const t = createT();
		await seedOrg(t, X);
		await ingestChunk(t, `team/${X_ID}/doc-a`, "alpha");
		const keep = await ingestChunk(t, `team/${X_ID}/doc-b`, "bravo");

		await t.mutation(internal.kbMutations.markDocSoftDeleted, {
			namespace: `team/${X_ID}/doc-a`,
		});
		expect(await applyScheduledRagSupersedes(t)).toBe(1);

		expect(await search(t, `team/${X_ID}/doc-a`)).toEqual([]);
		expect((await search(t, `team/${X_ID}`)).map((r) => r.memoryId)).toEqual([
			keep,
		]);
		// NEGATIVE: the other document of the org is untouched.
		expect(
			(await search(t, `team/${X_ID}/doc-b`)).map((r) => r.memoryId),
		).toEqual([keep]);
	});

	test("SUPERSEDED: a re-ingest of the same docId leaves only the new chunk searchable", async () => {
		const t = createT();
		await seedOrg(t, X);
		const old = await ingestChunk(t, `team/${X_ID}/doc-a`, "old text");
		await t.mutation(internal.kbMutations.supersedePriorChunks, {
			chunkIds: [old],
		});
		const fresh = await ingestChunk(t, `team/${X_ID}/doc-a`, "new text");
		expect(await applyScheduledRagSupersedes(t)).toBe(1);

		expect(
			(await search(t, `team/${X_ID}/doc-a`)).map((r) => r.memoryId),
		).toEqual([fresh]);
		expect((await search(t, `team/${X_ID}`)).map((r) => r.memoryId)).toEqual([
			fresh,
		]);
	});
});
