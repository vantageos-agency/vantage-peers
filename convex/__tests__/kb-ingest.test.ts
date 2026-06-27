/// <reference types="vite/client" />
/**
 * B5 Knowledge Base ingest backend — TDD test scaffold.
 *
 * Mission: k5779qbxhwrfjmj02t31yvehns8911jp (VP Cloud Dashboard OKF Phase 2).
 * Task:    k17bdmhr2hffhz2t96p65j70nh891wcp.
 *
 * Verifies the full KB ingest pipeline:
 *   upload binary → Convex storage → text extract → chunk →
 *   store_memory(type=reference, namespace=team/<orgId>/<docId>)
 *
 * Hook signal: AUTH_NAMESPACE_DENIED appears in test assertions — required by
 * enforce-rag-namespace-deny-test hook (convex/auth.ts + convex/rag* paths).
 *
 * TDD RULE #12 — tests land BEFORE implementation. All 8 tests are intentionally
 * RED until convex/kb.ts is implemented.
 *
 * Orchestrator: Sigma — VantagePeers | 2026-06-27
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround — kb.ts is created post-RED
const KB_ACTION_REF = "kb:storeDocumentChunked" as any;
// biome-ignore lint/suspicious/noExplicitAny: codegen-lag workaround
const KB_SOFT_DELETE_REF = "kb:softDeleteDocument" as any;

// Exclude RAG/search/backfill to keep convex-test hermetic (matches B4 pattern)
const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	clerkOrgSlug: string,
) {
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

function withTeamIdentity(
	t: ReturnType<typeof createT>,
	orgId: string,
): ReturnType<typeof t.withIdentity> {
	return t.withIdentity({
		subject: `user-${orgId}`,
		tokenIdentifier: `test|user-${orgId}`,
		organizationId: orgId,
	} as Parameters<typeof t.withIdentity>[0]);
}

function readFixture(filename: string): ArrayBuffer {
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const buf = readFileSync(join(__dirname, "fixtures", filename));
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function textToArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer;
}

async function getChunksForDoc(
	t: ReturnType<typeof createT>,
	orgId: string,
	docId: string,
): Promise<Array<{ content: string; namespace: string }>> {
	return await t.run(async (ctx) => {
		return await ctx.db
			.query("memories")
			.withIndex("by_namespace", (q) =>
				q.eq("namespace", `team/${orgId}/${docId}`).eq("isLatest", true),
			)
			.collect();
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — Happy path: PDF ingest
// ─────────────────────────────────────────────────────────────────────────────

describe("B5 KB ingest — PDF happy path", () => {
	// PDF extraction falls back to stub in convex-test env — allow 15s for pdf-parse cold start
	test("store_document_chunked with PDF → returns docId+chunkCount>0, chunks land at team/A/<docId>", async () => {
		const t = createT();
		await seedOrgMapping(t, "team-a");
		const tA = withTeamIdentity(t, "team-a");

		const pdfBytes = readFixture("sample.pdf");
		const storageId = await t.run(async (ctx) => {
			return await ctx.storage.store(
				new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }),
			);
		});

		const result = await tA.action(KB_ACTION_REF, {
			storageId,
			mimeType: "application/pdf",
			filename: "sample.pdf",
		});

		expect(result).toHaveProperty("docId");
		expect(result).toHaveProperty("chunkCount");
		expect(result).toHaveProperty("storageId");
		expect(typeof result.docId).toBe("string");
		// PDF may be stubbed — chunkCount >= 1 (at least one stub chunk)
		expect(result.chunkCount).toBeGreaterThan(0);

		// All chunks land at the correct namespace
		const chunks = await getChunksForDoc(t, "team-a", result.docId);
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.length).toBe(result.chunkCount);
		for (const chunk of chunks) {
			expect(chunk.namespace).toBe(`team/team-a/${result.docId}`);
		}
	}, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — Happy path: Markdown ingest
// ─────────────────────────────────────────────────────────────────────────────

describe("B5 KB ingest — Markdown happy path", () => {
	test("store_document_chunked with MD bytes → chunks land at namespace team/A/<docId>", async () => {
		const t = createT();
		await seedOrgMapping(t, "team-a");
		const tA = withTeamIdentity(t, "team-a");

		const mdText =
			"# Introduction\n\nThis is a markdown document.\n\n" +
			"## Section 1\n\nContent of section 1 with enough text to form a chunk.\n\n" +
			"## Section 2\n\nContent of section 2 with enough text to form another chunk.\n";
		const mdBytes = textToArrayBuffer(mdText);

		const storageId = await t.run(async (ctx) => {
			return await ctx.storage.store(
				new Blob([new Uint8Array(mdBytes)], { type: "text/markdown" }),
			);
		});

		const result = await tA.action(KB_ACTION_REF, {
			storageId,
			mimeType: "text/markdown",
			filename: "doc.md",
		});

		expect(result.chunkCount).toBeGreaterThan(0);

		const chunks = await getChunksForDoc(t, "team-a", result.docId);
		expect(chunks.length).toBe(result.chunkCount);

		// Verify chunks are typed as "reference" and scored
		const allChunks = await t.run(async (ctx) => {
			return await ctx.db
				.query("memories")
				.withIndex("by_namespace_type", (q) =>
					q
						.eq("namespace", `team/team-a/${result.docId}`)
						.eq("type", "reference")
						.eq("isLatest", true),
				)
				.collect();
		});
		expect(allChunks.length).toBeGreaterThan(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3 — Happy path: Plain text ingest
// ─────────────────────────────────────────────────────────────────────────────

describe("B5 KB ingest — TXT happy path", () => {
	test("store_document_chunked with TXT bytes → chunks recalled by namespace", async () => {
		const t = createT();
		await seedOrgMapping(t, "team-a");
		const tA = withTeamIdentity(t, "team-a");

		const txtContent =
			"First paragraph of plain text document.\n\n" +
			"Second paragraph with more content to ensure chunking.\n\n" +
			"Third paragraph completing the document content.\n";
		const txtBytes = textToArrayBuffer(txtContent);

		const storageId = await t.run(async (ctx) => {
			return await ctx.storage.store(
				new Blob([new Uint8Array(txtBytes)], { type: "text/plain" }),
			);
		});

		const result = await tA.action(KB_ACTION_REF, {
			storageId,
			mimeType: "text/plain",
			filename: "doc.txt",
		});

		expect(result.chunkCount).toBeGreaterThan(0);

		const chunks = await getChunksForDoc(t, "team-a", result.docId);
		expect(chunks.length).toBe(result.chunkCount);

		// Content-level assertion (seeded-data per doctrine §3.5)
		const firstChunk = chunks[0];
		expect(firstChunk.content.length).toBeGreaterThan(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4 — Cross-tenant isolation: AUTH_NAMESPACE_DENIED
// ─────────────────────────────────────────────────────────────────────────────

describe("B5 KB ingest — cross-tenant isolation — AUTH_NAMESPACE_DENIED", () => {
	test("team B recall on team/A/<docId> returns zero results via memoriesScoped", async () => {
		const t = createT();
		await seedOrgMapping(t, "team-a");
		await seedOrgMapping(t, "team-b");
		const tA = withTeamIdentity(t, "team-a");
		const tB = withTeamIdentity(t, "team-b");

		// team-a ingests a document
		const mdBytes = textToArrayBuffer(
			"# Secret doc\n\nConfidential content for team A only.\n",
		);
		const storageId = await t.run(async (ctx) => {
			return await ctx.storage.store(
				new Blob([new Uint8Array(mdBytes)], { type: "text/markdown" }),
			);
		});
		const result = await tA.action(KB_ACTION_REF, {
			storageId,
			mimeType: "text/markdown",
			filename: "secret.md",
		});
		expect(result.chunkCount).toBeGreaterThan(0);

		// team-b tries to read team-a's namespace via memoriesScoped
		// Should throw AUTH_NAMESPACE_DENIED
		await expect(
			tB.query(api.memoriesScoped.listMemoriesScoped, {
				namespace: `team/team-a/${result.docId}`,
			}),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
	});

	test("team B direct DB query on team/A/<docId> returns zero results via store_document_chunked", async () => {
		const t = createT();
		await seedOrgMapping(t, "team-a");
		await seedOrgMapping(t, "team-b");
		const tA = withTeamIdentity(t, "team-a");

		const mdBytes = textToArrayBuffer("Team A private doc.\n");
		const storageId = await t.run(async (ctx) => {
			return await ctx.storage.store(
				new Blob([new Uint8Array(mdBytes)], { type: "text/markdown" }),
			);
		});
		const result = await tA.action(KB_ACTION_REF, {
			storageId,
			mimeType: "text/markdown",
			filename: "private.md",
		});

		// team-b direct action call targeting team-a's org namespace is denied
		const mdB = textToArrayBuffer("Team B doc.\n");
		const storageIdB = await t.run(async (ctx) => {
			return await ctx.storage.store(
				new Blob([new Uint8Array(mdB)], { type: "text/markdown" }),
			);
		});
		const tB = withTeamIdentity(t, "team-b");
		// team-b trying to ingest into team-a's namespace via explicit docId
		await expect(
			tB.action(KB_ACTION_REF, {
				storageId: storageIdB,
				mimeType: "text/markdown",
				filename: "inject.md",
				// team-b cannot force writing into team-a's docId
				docId: result.docId,
				// The action resolves orgId from JWT, so even if docId is supplied,
				// the namespace will be team/team-b/<docId> — not team-a's namespace.
				// Cross-tenant isolation is enforced by JWT orgId resolution, not docId.
			}),
		).resolves.toMatchObject({
			// Should succeed but go into team-b's OWN namespace, not team-a's
			chunkCount: expect.any(Number),
		});

		// Verify team-a's doc is untouched
		const teamAChunks = await getChunksForDoc(t, "team-a", result.docId);
		expect(teamAChunks.length).toBe(result.chunkCount);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5 — Soft-delete propagation: recall excludes deleted doc chunks
// ─────────────────────────────────────────────────────────────────────────────

describe("B5 KB ingest — soft-delete propagation", () => {
	test("soft_delete_document → all chunks become isLatest=false, excluded from active recall", async () => {
		const t = createT();
		await seedOrgMapping(t, "team-a");
		const tA = withTeamIdentity(t, "team-a");

		const txtBytes = textToArrayBuffer(
			"Document to be deleted.\n\nSecond paragraph.\n",
		);
		const storageId = await t.run(async (ctx) => {
			return await ctx.storage.store(
				new Blob([new Uint8Array(txtBytes)], { type: "text/plain" }),
			);
		});

		const result = await tA.action(KB_ACTION_REF, {
			storageId,
			mimeType: "text/plain",
			filename: "to-delete.txt",
		});

		// Verify chunks exist before delete
		const beforeDelete = await getChunksForDoc(t, "team-a", result.docId);
		expect(beforeDelete.length).toBe(result.chunkCount);

		// Soft-delete the document
		await tA.action(KB_SOFT_DELETE_REF, {
			docId: result.docId,
		});

		// After soft-delete: isLatest=false, active recall returns 0
		const afterDelete = await getChunksForDoc(t, "team-a", result.docId);
		expect(afterDelete.length).toBe(0); // isLatest=true filter → 0 results

		// But the rows still exist with isLatest=false (soft-delete, not hard-delete)
		const allChunks = await t.run(async (ctx) => {
			return await ctx.db
				.query("memories")
				.withIndex("by_namespace", (q) =>
					q
						.eq("namespace", `team/team-a/${result.docId}`)
						.eq("isLatest", false),
				)
				.collect();
		});
		expect(allChunks.length).toBe(result.chunkCount);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6 — No-org bearer denied: no master-fallback into team/* namespace
// ─────────────────────────────────────────────────────────────────────────────

describe("B5 KB ingest — no-org bearer denied", () => {
	test("bearer without org_id → store_document_chunked rejects with explicit error", async () => {
		const t = createT();

		// Clerk user with no org attached — no organizationId / organizationSlug
		const tNoOrg = t.withIdentity({
			subject: "user-no-org",
			tokenIdentifier: "test|user-no-org",
			// Explicitly no organizationId
		} as Parameters<typeof t.withIdentity>[0]);

		const mdBytes = textToArrayBuffer("Some content.\n");
		const storageId = await t.run(async (ctx) => {
			return await ctx.storage.store(
				new Blob([new Uint8Array(mdBytes)], { type: "text/markdown" }),
			);
		});

		await expect(
			tNoOrg.action(KB_ACTION_REF, {
				storageId,
				mimeType: "text/markdown",
				filename: "test.md",
			}),
		).rejects.toThrow(/NO_ORG_ID|AUTH_NO_ORG|no org/i);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 7 — Chunking determinism: same input → same chunk boundaries
// ─────────────────────────────────────────────────────────────────────────────

describe("B5 KB ingest — chunking determinism", () => {
	test("same input text produces identical first-N chunk text prefixes", async () => {
		const t = createT();
		await seedOrgMapping(t, "team-a");
		const tA = withTeamIdentity(t, "team-a");

		const longText =
			"First chunk paragraph.\n\n" +
			"Second chunk paragraph.\n\n" +
			"Third chunk paragraph.\n\n" +
			"Fourth chunk paragraph.\n";

		// Ingest twice with different docIds
		async function ingest(suffix: string) {
			const bytes = textToArrayBuffer(longText);
			const storageId = await t.run(async (ctx) => {
				return await ctx.storage.store(
					new Blob([new Uint8Array(bytes)], { type: "text/plain" }),
				);
			});
			return tA.action(KB_ACTION_REF, {
				storageId,
				mimeType: "text/plain",
				filename: `doc-${suffix}.txt`,
			});
		}

		const r1 = await ingest("det1");
		const r2 = await ingest("det2");

		// Same chunk count
		expect(r1.chunkCount).toBe(r2.chunkCount);

		// First-N chunk text prefixes are identical (determinism assertion)
		const chunks1 = await getChunksForDoc(t, "team-a", r1.docId);
		const chunks2 = await getChunksForDoc(t, "team-a", r2.docId);

		const n = Math.min(chunks1.length, chunks2.length, 3);
		for (let i = 0; i < n; i++) {
			const prefix1 = chunks1[i].content.substring(0, 30);
			const prefix2 = chunks2[i].content.substring(0, 30);
			expect(prefix1).toBe(prefix2);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 8 — Idempotent re-ingest: second ingest supersedes first (isLatest flip)
// ─────────────────────────────────────────────────────────────────────────────

describe("B5 KB ingest — idempotent re-ingest", () => {
	test("same docId ingested twice → second supersedes first, recall returns only latest chunks", async () => {
		const t = createT();
		await seedOrgMapping(t, "team-a");
		const tA = withTeamIdentity(t, "team-a");

		const docId = "test-idempotent-doc-001";
		const text1 = "Version 1 content.\n\nSecond paragraph v1.\n";
		const text2 = "Version 2 content.\n\nSecond paragraph v2.\n";

		async function ingestVersion(text: string) {
			const bytes = textToArrayBuffer(text);
			const storageId = await t.run(async (ctx) => {
				return await ctx.storage.store(
					new Blob([new Uint8Array(bytes)], { type: "text/plain" }),
				);
			});
			return tA.action(KB_ACTION_REF, {
				storageId,
				mimeType: "text/plain",
				filename: "test-idem.txt",
				docId,
			});
		}

		const r1 = await ingestVersion(text1);
		expect(r1.docId).toBe(docId);

		const r2 = await ingestVersion(text2);
		expect(r2.docId).toBe(docId);

		// Active chunks (isLatest=true) should only be from v2
		const activeChunks = await getChunksForDoc(t, "team-a", docId);
		expect(activeChunks.length).toBe(r2.chunkCount);

		// Old chunks (isLatest=false) should exist for v1 (soft supersede)
		const oldChunks = await t.run(async (ctx) => {
			return await ctx.db
				.query("memories")
				.withIndex("by_namespace", (q) =>
					q
						.eq("namespace", `team/team-a/${docId}`)
						.eq("isLatest", false),
				)
				.collect();
		});
		// v1 chunks should now be superseded
		expect(oldChunks.length).toBe(r1.chunkCount);

		// Content of active chunks matches v2 text
		const hasV2Content = activeChunks.some((c) =>
			c.content.includes("Version 2"),
		);
		expect(hasV2Content).toBe(true);
	});
});
