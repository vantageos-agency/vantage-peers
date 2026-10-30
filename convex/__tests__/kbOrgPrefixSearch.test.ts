/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud KB: a search on `team/<org ID>` finds the org's KB documents.
//
// Defect (prod, 2026-10-30): kb:storeDocumentChunked files each document in the
// RAG namespace `team/<orgId>/<docId>`. RAG searches ONE namespace by exact
// name, so `hybrid_search` / `text_search` / `recall` on `team/<orgId>` returned
// [] while the exact `team/<orgId>/<docId>` returned the document.
//
// The RAG backend is substituted by a fake that behaves like the real one on
// the one property that matters here: it answers ONLY for the exact namespace
// asked, from what was indexed under that exact name.
//
// PRESENT   the org-root search returns the org's documents (all three paths);
//           documents ingested BEFORE this change are found with no backfill.
// ABSENT    an org with no document gets [].
// REFUSED   org Y on team/<X> or team/<X>/<doc> gets [] and the RAG backend is
//           never asked for X's namespaces; `team` / `team/` stay empty.
// BOUNDARY  team/<X> never reaches team/<X>suffix/... or team/<Y>/...
// UNCHANGED exact-doc namespace, and a non-team namespace, search exactly as before.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
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
const Y = "org-y";
const X_ID = testClerkOrgId(X);
const Y_ID = testClerkOrgId(Y);

const asMember = (t: T, slug: string) =>
	t.withIdentity({
		subject: `user-${slug}`,
		organizationId: slug,
		organizationSlug: slug,
		org_id: testClerkOrgId(slug),
	} as Identity);
const asMaster = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

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

// RAG fake: exact-namespace index. `indexed` maps a namespace to its entries.
const indexed = new Map<string, Array<{ key: string; text: string }>>();
let asked: string[] = [];
// searches that would embed the query themselves (string query, not a text search)
let embeddingSearches = 0;
// calls to the query embedder
let embedCalls = 0;

/** A KB chunk: a memories row AND the RAG entry filed under that exact namespace. */
async function seedChunk(
	t: T,
	namespace: string,
	text: string,
	type: "reference" | "project" = "reference",
): Promise<string> {
	const id = await t.run(async (ctx) =>
		ctx.db.insert("memories", {
			namespace,
			type,
			content: text,
			createdBy: "kb",
			relations: [],
			isLatest: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
	const list = indexed.get(namespace) ?? [];
	list.push({ key: id as string, text });
	indexed.set(namespace, list);
	return id as string;
}

beforeEach(() => {
	indexed.clear();
	asked = [];
	embeddingSearches = 0;
	embedCalls = 0;
	__setQueryEmbedderForTests(async () => {
		embedCalls++;
		return [0.1, 0.2, 0.3];
	});
	__setRagSearcherForTests((async (
		_ctx: unknown,
		args: { namespace: string; query: string | number[]; searchType?: string },
	) => {
		asked.push(args.namespace);
		if (typeof args.query === "string" && args.searchType !== "text") {
			embeddingSearches++;
		}
		const rows = indexed.get(args.namespace) ?? [];
		return {
			results: rows.map((r, i) => ({
				entryId: `${args.namespace}#${i}`,
				score: 0.9 - i * 0.01,
				content: [{ text: r.text }],
			})),
			entries: rows.map((r, i) => ({
				entryId: `${args.namespace}#${i}`,
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

const PATHS = [
	{ name: "recall", ref: api.search.recall },
	{ name: "textSearch", ref: api.search.textSearch },
	{ name: "hybridSearch", ref: api.search.hybridSearch },
] as const;

for (const { name, ref } of PATHS) {
	describe(`search:${name} on the org KB root`, () => {
		test("PRESENT: team/<orgID> returns every document of the org", async () => {
			const t = createT();
			await seedOrg(t, X);
			const a = await seedChunk(t, `team/${X_ID}/doc-a`, "alpha");
			const b = await seedChunk(t, `team/${X_ID}/doc-b`, "bravo");
			const rows = (await asMember(t, X).action(ref, {
				query: "anything",
				namespace: `team/${X_ID}`,
			})) as Array<{ memoryId: string; namespace: string }>;
			expect(rows.map((r) => r.memoryId).sort()).toEqual([a, b].sort());
			expect(rows.map((r) => r.namespace).sort()).toEqual([
				`team/${X_ID}/doc-a`,
				`team/${X_ID}/doc-b`,
			]);
		});

		test("PRESENT: an entry filed directly at team/<orgID> is still returned", async () => {
			const t = createT();
			await seedOrg(t, X);
			const direct = await seedChunk(t, `team/${X_ID}`, "direct", "project");
			const doc = await seedChunk(t, `team/${X_ID}/doc-a`, "alpha");
			const rows = (await asMember(t, X).action(ref, {
				query: "anything",
				namespace: `team/${X_ID}`,
			})) as Array<{ memoryId: string }>;
			expect(rows.map((r) => r.memoryId).sort()).toEqual([direct, doc].sort());
		});

		test("ABSENT: an org with no document gets []", async () => {
			const t = createT();
			await seedOrg(t, X);
			await seedChunk(t, `team/${Y_ID}/doc-y`, "not mine");
			const rows = await asMember(t, X).action(ref, {
				query: "anything",
				namespace: `team/${X_ID}`,
			});
			expect(rows).toEqual([]);
		});

		test("BOUNDARY: team/<X> never reaches team/<X>suffix/... or another org", async () => {
			const t = createT();
			await seedOrg(t, X);
			const mine = await seedChunk(t, `team/${X_ID}/doc-a`, "alpha");
			await seedChunk(t, `team/${X_ID}suffix/doc-s`, "suffix org");
			await seedChunk(t, `team/${Y_ID}/doc-y`, "other org");
			const rows = (await asMember(t, X).action(ref, {
				query: "anything",
				namespace: `team/${X_ID}`,
			})) as Array<{ memoryId: string }>;
			expect(rows.map((r) => r.memoryId)).toEqual([mine]);
			expect(asked).not.toContain(`team/${X_ID}suffix/doc-s`);
			expect(asked).not.toContain(`team/${Y_ID}/doc-y`);
		});

		test("BOUNDARY: soft-deleted documents (no isLatest chunk) are not searched", async () => {
			const t = createT();
			await seedOrg(t, X);
			const live = await seedChunk(t, `team/${X_ID}/live`, "alpha");
			const dead = await seedChunk(t, `team/${X_ID}/dead`, "gone");
			await t.run(async (ctx) => {
				await ctx.db.patch(dead as never, { isLatest: false });
			});
			const rows = (await asMember(t, X).action(ref, {
				query: "anything",
				namespace: `team/${X_ID}`,
			})) as Array<{ memoryId: string }>;
			expect(rows.map((r) => r.memoryId)).toEqual([live]);
			expect(asked).not.toContain(`team/${X_ID}/dead`);
		});

		test("BOUNDED: a root search fans out to at most 50 documents (+ the root), residue is exact-namespace search", async () => {
			const t = createT();
			await seedOrg(t, X);
			for (let i = 0; i < 53; i++) {
				await seedChunk(t, `team/${X_ID}/d${String(i).padStart(3, "0")}`, `t${i}`);
			}
			await asMember(t, X).action(ref, {
				query: "anything",
				namespace: `team/${X_ID}`,
				limit: 100,
			});
			expect(asked).toHaveLength(51);
			expect(asked[0]).toBe(`team/${X_ID}`);
			expect(asked).not.toContain(`team/${X_ID}/d052`);
			asked = [];
			const rows = (await asMember(t, X).action(ref, {
				query: "anything",
				namespace: `team/${X_ID}/d052`,
			})) as unknown[];
			expect(rows).toHaveLength(1);
		});

		test("COST: a root search over 4 documents embeds the query at most once", async () => {
			const t = createT();
			await seedOrg(t, X);
			for (const d of ["a", "b", "c", "d"]) {
				await seedChunk(t, `team/${X_ID}/doc-${d}`, `text ${d}`);
			}
			await asMember(t, X).action(ref, {
				query: "anything",
				namespace: `team/${X_ID}`,
			});
			expect(asked).toHaveLength(5);
			expect(embeddingSearches).toBe(0);
			expect(embedCalls).toBe(name === "textSearch" ? 0 : 1);
		});

		test("REFUSED: org Y on team/<X> gets [] and X's namespaces are never asked", async () => {
			const t = createT();
			await seedOrg(t, X);
			await seedOrg(t, Y);
			await seedChunk(t, `team/${X_ID}/doc-a`, "alpha");
			for (const namespace of [`team/${X_ID}`, `team/${X_ID}/doc-a`]) {
				const rows = await asMember(t, Y).action(ref, {
					query: "anything",
					namespace,
				});
				expect(rows).toEqual([]);
			}
			expect(asked.filter((n) => n.includes(X_ID))).toEqual([]);
		});

		test("REFUSED: a signed-in caller with no organisation gets []", async () => {
			const t = createT();
			await seedChunk(t, `team/${X_ID}/doc-a`, "alpha");
			const rows = await t
				.withIdentity({ subject: "no-org-user" } as Identity)
				.action(ref, { query: "anything", namespace: `team/${X_ID}` });
			expect(rows).toEqual([]);
			expect(asked).toEqual([]);
		});

		test("REFUSED: the bare `team` and `team/` namespaces stay empty for a member", async () => {
			const t = createT();
			await seedOrg(t, X);
			await seedChunk(t, `team/${X_ID}/doc-a`, "alpha");
			for (const namespace of ["team", "team/"]) {
				const rows = await asMember(t, X).action(ref, {
					query: "anything",
					namespace,
				});
				expect(rows).toEqual([]);
			}
			expect(asked).toEqual([]);
		});

		test("UNCHANGED: the exact doc namespace still returns the document, one search", async () => {
			const t = createT();
			await seedOrg(t, X);
			const a = await seedChunk(t, `team/${X_ID}/doc-a`, "alpha");
			await seedChunk(t, `team/${X_ID}/doc-b`, "bravo");
			const rows = (await asMember(t, X).action(ref, {
				query: "anything",
				namespace: `team/${X_ID}/doc-a`,
			})) as Array<{ memoryId: string }>;
			expect(rows.map((r) => r.memoryId)).toEqual([a]);
			expect(asked).toEqual([`team/${X_ID}/doc-a`]);
		});

		test("UNCHANGED: the master on a memory namespace searches exactly that namespace", async () => {
			const t = createT();
			const m = await seedChunk(t, "orchestrator/sigma", "note", "project");
			await seedChunk(t, "orchestrator/sigma/child", "child", "project");
			const rows = (await asMaster(t).action(ref, {
				query: "anything",
				namespace: "orchestrator/sigma",
			})) as Array<{ memoryId: string }>;
			expect(rows.map((r) => r.memoryId)).toEqual([m]);
			expect(asked).toEqual(["orchestrator/sigma"]);
		});
	});
}
