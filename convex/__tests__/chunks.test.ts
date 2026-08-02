/// <reference types="vite/client" />
/**
 * Convergence KB — convex/chunks.ts (VP task k170s8gd4zj5f8aews4ja2xdwn8bqvj4,
 * mission convergence). data-lake absorbs @vantageos/corpus's distinct value:
 * documentary chunks, (orgId, scope) isolation, native BM25 search, ZERO
 * embeddings. Mirrors corpus's `insertChunks` / `searchCorpus` contract 1:1.
 *
 * RED->GREEN: written before convex/chunks.ts existed. Every test below must
 * fail against a repo with no `chunks` table / no convex/chunks.ts module,
 * then pass once both are added (additive-only schema + new file).
 *
 * AUTH_NAMESPACE_DENIED-style isolation proof: org A can never read org B's
 * chunks via searchCorpus, proven with a POSITIVE CONTROL (org A finds its
 * own chunk in the same assertion block, so the negative result is not a
 * broken query returning empty for everyone).
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

describe("convex/chunks.ts — insertChunks + searchCorpus (BM25-only, no embeddings)", () => {
	test("insertChunks stores N chunks under (orgId, scope) and returns the count", async () => {
		const t = createT();
		const count = await t.mutation(api.chunks.insertChunks, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunk_id: "chunk-1",
					text: "Le contrat de travail à durée indéterminée est la forme normale.",
					section_title: "Article L1221-1",
					legal_references: ["Code du travail L1221-1"],
					source_ref: "https://legifrance.gouv.fr/L1221-1",
				},
				{
					chunk_id: "chunk-2",
					text: "La période d'essai peut être renouvelée une fois.",
					legal_references: ["Code du travail L1221-19"],
					source_ref: "https://legifrance.gouv.fr/L1221-19",
				},
			],
		});
		expect(count).toBe(2);
	});

	test("searchCorpus returns BM25-matched chunks for the caller's own (orgId, scope) — POSITIVE CONTROL", async () => {
		const t = createT();
		await t.mutation(api.chunks.insertChunks, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunk_id: "chunk-essai",
					text: "La période d'essai renouvelable une fois pour les cadres.",
					legal_references: ["L1221-19"],
					source_ref: "https://legifrance.gouv.fr/L1221-19",
				},
			],
		});

		const results = await t.query(api.chunks.searchCorpus, {
			orgId: "org-a",
			scope: "droit-du-travail",
			query: "période d'essai",
		});

		expect(results.length).toBeGreaterThan(0);
		expect(results[0].chunk_id).toBe("chunk-essai");
		expect(results[0].source_ref).toBe("https://legifrance.gouv.fr/L1221-19");
	});

	test("AUTH_NAMESPACE_DENIED-equivalent — org B cannot read org A's chunks via searchCorpus (isolation proof, same query text)", async () => {
		const t = createT();

		// Seed org-a with a chunk matching the query text.
		await t.mutation(api.chunks.insertChunks, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunk_id: "chunk-secret-a",
					text: "Confidentiel org-a: clause de non-concurrence renforcée.",
					legal_references: ["L1221-1"],
					source_ref: "https://legifrance.gouv.fr/org-a",
				},
			],
		});

		// org-b queries the SAME scope with the SAME text but a DIFFERENT orgId.
		const crossTenantResults = await t.query(api.chunks.searchCorpus, {
			orgId: "org-b",
			scope: "droit-du-travail",
			query: "clause de non-concurrence",
		});
		expect(crossTenantResults).toEqual([]);

		// POSITIVE CONTROL — org-a, same query, DOES see its own chunk. Proves
		// the empty result above is isolation, not a broken/always-empty query.
		const ownResults = await t.query(api.chunks.searchCorpus, {
			orgId: "org-a",
			scope: "droit-du-travail",
			query: "clause de non-concurrence",
		});
		expect(ownResults.length).toBeGreaterThan(0);
		expect(ownResults[0].chunk_id).toBe("chunk-secret-a");
	});

	test("searchCorpus refuses an empty orgId — deny by default", async () => {
		const t = createT();
		await expect(
			t.query(api.chunks.searchCorpus, {
				orgId: "",
				scope: "droit-du-travail",
				query: "anything",
			}),
		).rejects.toThrow(/orgId/i);
	});

	test("searchCorpus refuses an empty scope — deny by default", async () => {
		const t = createT();
		await expect(
			t.query(api.chunks.searchCorpus, {
				orgId: "org-a",
				scope: "",
				query: "anything",
			}),
		).rejects.toThrow(/scope/i);
	});

	test("upsert-by-chunk_id idempotence — re-ingesting the same chunk_id (same orgId+scope) patches in place, row count stable", async () => {
		const t = createT();
		await t.mutation(api.chunks.insertChunks, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunk_id: "chunk-idempotent",
					text: "Article L1234-1 version initiale.",
					section_title: "Rupture du contrat",
					legal_references: ["L1234-1"],
					source_ref: "code-travail/L1234-1",
				},
			],
		});

		const secondCount = await t.mutation(api.chunks.insertChunks, {
			orgId: "org-a",
			scope: "droit-du-travail",
			chunks: [
				{
					chunk_id: "chunk-idempotent",
					text: "Article L1234-1 version amendée — texte mis à jour au réingest.",
					section_title: "Rupture du contrat — version amendée",
					legal_references: ["L1234-1"],
					source_ref: "code-travail/L1234-1",
				},
			],
		});
		expect(secondCount).toBe(1);

		const rows = await t.run(async (ctx) =>
			ctx.db
				.query("chunks")
				.withIndex("by_org_scope", (q) =>
					q.eq("orgId", "org-a").eq("scope", "droit-du-travail"),
				)
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].text).toBe(
			"Article L1234-1 version amendée — texte mis à jour au réingest.",
		);
	});

	test("BM25-only path — searchCorpus never calls an embedding/AI Gateway endpoint (no-embedding-budget domains)", async () => {
		const t = createT();
		const originalFetch = globalThis.fetch;
		let fetchCalled = false;
		globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
			fetchCalled = true;
			return originalFetch(...args);
		}) as typeof fetch;

		try {
			await t.mutation(api.chunks.insertChunks, {
				orgId: "org-a",
				scope: "no-embedding-domain",
				chunks: [
					{
						chunk_id: "chunk-plain",
						text: "Texte simple sans budget d'embedding.",
						legal_references: [],
						source_ref: "https://example.org/plain",
					},
				],
			});

			const results = await t.query(api.chunks.searchCorpus, {
				orgId: "org-a",
				scope: "no-embedding-domain",
				query: "texte simple",
			});

			expect(results.length).toBeGreaterThan(0);
			// Native Convex BM25 search runs inside the deployment's own query
			// engine — no outbound `fetch` (i.e. no embedding/AI Gateway call)
			// is ever made by this path.
			expect(fetchCalled).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
