/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// A RETIRED entry (soft-deleted or superseded KB chunk or memory) is returned by
// NO RAG-backed search path: recall, textSearch, hybridSearch, on the exact
// namespace and on the org KB root.
//
// WHY IT LEAKED. @convex-dev/rag ORs its filters:
//   node_modules/@convex-dev/rag/dist/component/embeddings/index.js:49
//       q.or(...orFilters.flatMap(... q.eq(filterField, filter)))
//   node_modules/@convex-dev/rag/dist/component/search.js:129
//       "OR across filter conditions: run one text search per filter and dedupe"
//   node_modules/@convex-dev/rag/dist/client/index.d.ts:421
//       "Filters to apply to the search. These are OR'd together."
// convex/search.ts buildFilters passes [isLatest=true, namespace=ns]; every entry
// of the namespace has namespace=ns, so every entry matched whatever its isLatest.
// The fake below ORs exactly like that (an entry matches when ANY filter pair
// equals one of its stored filter values) and applies the component's `limit`
// BEFORE the caller sees the rows, as the component does.
//
// The ragSync.markRagEntrySuperseded action ("use node", not loadable in
// convex-test) is applied by reading the _scheduled_functions table and setting
// the entry's isLatest="false", which is what the real action re-adds under the
// same key.
//
// POLES
//   PRESENT    a live KB chunk / memory is found by every path.
//   RETIRED    retired three ways: soft-deleted KB doc (re-indexed), superseded
//              memory (re-indexed), and LEGACY (row retired, RAG entry still
//              "true": retired before the re-index existed) -> no path returns it.
//   NEGATIVE   a live neighbour is still returned; another type is not widened in.
//   LIMIT      retired entries ranked first do not shorten the page.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

type Entry = {
	key: string;
	text: string;
	type: string;
	isLatest: "true" | "false";
};
const indexed = new Map<string, Entry[]>();

function indexEntry(namespace: string, e: Entry): void {
	const list = indexed.get(namespace) ?? [];
	list.push(e);
	indexed.set(namespace, list);
}

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
	indexEntry(namespace, {
		key: id as string,
		text,
		type: "reference",
		isLatest: "true",
	});
	return id;
}

/** A plain memory (type project) filed in a team namespace, with its RAG entry. */
async function ingestMemory(
	t: T,
	namespace: string,
	text: string,
): Promise<Id<"memories">> {
	const id = await t.run(async (ctx) =>
		ctx.db.insert("memories", {
			namespace,
			type: "project",
			content: text,
			createdBy: "kb",
			relations: [],
			isLatest: true,
			clerkOrgId: X_ID,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
	indexEntry(namespace, {
		key: id as string,
		text,
		type: "project",
		isLatest: "true",
	});
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

/** Retired BEFORE the re-index existed: the row is retired, the RAG entry still says "true". */
async function retireRowOnly(t: T, id: Id<"memories">): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.patch(id, { isLatest: false });
	});
}

beforeEach(() => {
	// Scheduled jobs are only ever READ here (the ragSync action is not loadable);
	// fake timers keep them from firing against a missing module.
	vi.useFakeTimers();
	indexed.clear();
	__setQueryEmbedderForTests(async () => [0.1, 0.2, 0.3]);
	__setRagSearcherForTests((async (
		_ctx: unknown,
		args: {
			namespace: string;
			limit?: number;
			filters?: Array<{ name: string; value: string }>;
		},
	) => {
		const filters = args.filters ?? [];
		// OR across filters, as the component does (see header). No filter: all.
		const matched = (indexed.get(args.namespace) ?? [])
			.filter((e) => {
				if (filters.length === 0) return true;
				const fields: Record<string, string> = {
					namespace: args.namespace,
					type: e.type,
					isLatest: e.isLatest,
				};
				return filters.some((f) => fields[f.name] === f.value);
			})
			.slice(0, args.limit ?? 10);
		return {
			results: matched.map((r, i) => ({
				entryId: `${args.namespace}#${r.key}`,
				score: 0.9 - i * 0.01,
				content: [{ text: r.text }],
			})),
			entries: matched.map((r) => ({
				entryId: `${args.namespace}#${r.key}`,
				key: r.key,
				filterValues: [
					{ name: "namespace", value: args.namespace },
					{ name: "type", value: r.type },
					{ name: "isLatest", value: r.isLatest },
				],
			})),
		};
	}) as unknown as Parameters<typeof __setRagSearcherForTests>[0]);
});
afterEach(() => {
	vi.useRealTimers();
	__setRagSearcherForTests(null);
	__setQueryEmbedderForTests(null);
});

const PATHS = [
	{ name: "recall", ref: api.search.recall },
	{ name: "textSearch", ref: api.search.textSearch },
	{ name: "hybridSearch", ref: api.search.hybridSearch },
] as const;

for (const { name, ref } of PATHS) {
	const search = async (
		t: T,
		namespace: string,
		extra: { type?: "reference" | "project"; limit?: number } = {},
	) =>
		(
			(await asMember(t, X).action(ref, {
				query: "anything",
				namespace,
				...extra,
			})) as Array<{ memoryId: string }>
		).map((r) => r.memoryId);

	describe(`search:${name}: a retired entry is never returned`, () => {
		test("PRESENT: a live KB chunk is found on the root and on its exact namespace", async () => {
			const t = createT();
			await seedOrg(t, X);
			const id = await ingestChunk(t, `team/${X_ID}/doc-a`, "alpha");
			expect(await search(t, `team/${X_ID}`)).toEqual([id]);
			expect(await search(t, `team/${X_ID}/doc-a`)).toEqual([id]);
		});

		test("RETIRED: a soft-deleted KB document (re-indexed) is on neither path; its neighbour stays", async () => {
			const t = createT();
			await seedOrg(t, X);
			await ingestChunk(t, `team/${X_ID}/doc-a`, "alpha");
			const keep = await ingestChunk(t, `team/${X_ID}/doc-b`, "bravo");
			await t.mutation(internal.kbMutations.markDocSoftDeleted, {
				namespace: `team/${X_ID}/doc-a`,
			});
			expect(await applyScheduledRagSupersedes(t)).toBe(1);
			expect(await search(t, `team/${X_ID}/doc-a`)).toEqual([]);
			expect(await search(t, `team/${X_ID}`)).toEqual([keep]);
			expect(await search(t, `team/${X_ID}/doc-b`)).toEqual([keep]);
		});

		test("RETIRED: a KB chunk superseded by a re-ingest leaves only the new chunk", async () => {
			const t = createT();
			await seedOrg(t, X);
			const old = await ingestChunk(t, `team/${X_ID}/doc-a`, "old text");
			await t.mutation(internal.kbMutations.supersedePriorChunks, {
				chunkIds: [old],
			});
			const fresh = await ingestChunk(t, `team/${X_ID}/doc-a`, "new text");
			expect(await applyScheduledRagSupersedes(t)).toBe(1);
			expect(await search(t, `team/${X_ID}/doc-a`)).toEqual([fresh]);
			expect(await search(t, `team/${X_ID}`)).toEqual([fresh]);
		});

		test("RETIRED (legacy): a document retired before the re-index existed -- row isLatest=false, RAG entry still 'true' -- is on neither path", async () => {
			const t = createT();
			await seedOrg(t, X);
			const dead = await ingestChunk(t, `team/${X_ID}/doc-a`, "alpha");
			const keep = await ingestChunk(t, `team/${X_ID}/doc-b`, "bravo");
			await retireRowOnly(t, dead);
			expect(await search(t, `team/${X_ID}/doc-a`)).toEqual([]);
			expect(await search(t, `team/${X_ID}`)).toEqual([keep]);
		});

		test("RETIRED: a soft-deleted memory (memories:softDeleteMemory) is not returned", async () => {
			const t = createT();
			await seedOrg(t, X);
			const gone = await ingestMemory(t, `team/${X_ID}/notes`, "gone");
			const keep = await ingestMemory(t, `team/${X_ID}/notes`, "kept");
			await asMember(t, X).mutation(api.memories.softDeleteMemory, {
				memoryId: gone,
			});
			expect(await applyScheduledRagSupersedes(t)).toBe(1);
			expect(await search(t, `team/${X_ID}/notes`)).toEqual([keep]);
			expect(await search(t, `team/${X_ID}`)).toEqual([keep]);
		});

		test("RETIRED (legacy): a memory retired with its RAG entry still 'true' is not returned", async () => {
			const t = createT();
			await seedOrg(t, X);
			const gone = await ingestMemory(t, `team/${X_ID}/notes`, "gone");
			const keep = await ingestMemory(t, `team/${X_ID}/notes`, "kept");
			await retireRowOnly(t, gone);
			expect(await search(t, `team/${X_ID}/notes`)).toEqual([keep]);
		});

		test("NEGATIVE: a type filter is not widened by the OR -- a project memory is not returned for type=reference", async () => {
			const t = createT();
			await seedOrg(t, X);
			const ref = await ingestChunk(t, `team/${X_ID}/notes`, "chunk");
			await ingestMemory(t, `team/${X_ID}/notes`, "memory");
			expect(await search(t, `team/${X_ID}/notes`, { type: "reference" })).toEqual(
				[ref],
			);
		});

		test("LIMIT: retired entries ranked first do not shorten the page (over-fetch)", async () => {
			const t = createT();
			await seedOrg(t, X);
			const dead: Id<"memories">[] = [];
			for (let i = 0; i < 4; i++) {
				dead.push(await ingestMemory(t, `team/${X_ID}/notes`, `dead ${i}`));
			}
			const live1 = await ingestMemory(t, `team/${X_ID}/notes`, "live 1");
			const live2 = await ingestMemory(t, `team/${X_ID}/notes`, "live 2");
			for (const d of dead) await retireRowOnly(t, d);
			// limit 2: the component's top 2 are retired; over-fetch (3x) reaches the live ones.
			expect(await search(t, `team/${X_ID}/notes`, { limit: 2 })).toEqual([
				live1,
				live2,
			]);
		});
	});
}
