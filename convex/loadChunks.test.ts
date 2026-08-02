import { describe, expect, test, vi } from "vitest";
import { DEFAULT_BATCH_SIZE, loadChunksBatched } from "./loadChunks";
import type { NormalizedChunk } from "./normalizeSourceChunk";

// component/loadChunks.test.ts — RED-then-GREEN, pure unit against a mocked
// insertChunks (no Convex runtime needed to prove the batching mechanics;
// component/corpus.test.ts already covers insertChunks itself against the
// real convex-test harness).
//
// RED (recorded verbatim, captured BEFORE component/loadChunks.ts existed):
//
//   FAIL  component/loadChunks.test.ts [ component/loadChunks.test.ts ]
//   Error: Cannot find module './loadChunks' imported from
//   component/loadChunks.test.ts

function makeChunks(n: number): NormalizedChunk[] {
  return Array.from({ length: n }, (_, i) => ({
    chunk_id: `chunk-${i}`,
    text: `text ${i}`,
    legal_references: [],
    source_ref: `src/${i}`,
  }));
}

describe("loadChunksBatched", () => {
  test("MUST_PASS: default batch size is 500", () => {
    expect(DEFAULT_BATCH_SIZE).toBe(500);
  });

  test("MUST_PASS: splits chunks into ceil(n/batchSize) sequential insertChunks calls", async () => {
    const insertChunks = vi.fn(async (args: { chunks: NormalizedChunk[] }) => args.chunks.length);
    const chunks = makeChunks(1201);

    const result = await loadChunksBatched(insertChunks, {
      orgId: "org_a",
      scope: "labor-A",
      chunks,
      batchSize: 500,
    });

    expect(insertChunks).toHaveBeenCalledTimes(3);
    expect(insertChunks.mock.calls[0][0].chunks).toHaveLength(500);
    expect(insertChunks.mock.calls[1][0].chunks).toHaveLength(500);
    expect(insertChunks.mock.calls[2][0].chunks).toHaveLength(201);
    expect(result).toEqual({ totalChunks: 1201, batches: 3, inserted: 1201 });
  });

  test("MUST_PASS: every batch call carries the same (orgId, scope)", async () => {
    const insertChunks = vi.fn(
      async (args: { orgId: string; scope: string; chunks: NormalizedChunk[] }) =>
        args.chunks.length,
    );
    await loadChunksBatched(insertChunks, {
      orgId: "org_x",
      scope: "scope_y",
      chunks: makeChunks(600),
      batchSize: 500,
    });

    for (const call of insertChunks.mock.calls) {
      expect(call[0].orgId).toBe("org_x");
      expect(call[0].scope).toBe("scope_y");
    }
  });

  test("MUST_PASS: empty chunks array makes zero insertChunks calls", async () => {
    const insertChunks = vi.fn(async () => 0);
    const result = await loadChunksBatched(insertChunks, {
      orgId: "org_a",
      scope: "labor-A",
      chunks: [],
    });
    expect(insertChunks).not.toHaveBeenCalled();
    expect(result).toEqual({ totalChunks: 0, batches: 0, inserted: 0 });
  });

  test("MUST_PASS: inserted total is derived from insertChunks' own returned counts, not assumed", async () => {
    // A batch that (hypothetically) dedupes and inserts fewer rows than
    // it received must be reflected honestly in the aggregate.
    const insertChunks = vi.fn(async (args: { chunks: NormalizedChunk[] }) =>
      args.chunks.length - 1,
    );
    const result = await loadChunksBatched(insertChunks, {
      orgId: "org_a",
      scope: "labor-A",
      chunks: makeChunks(500),
      batchSize: 500,
    });
    expect(result.inserted).toBe(499);
  });

  test("MUST_REFUSE: an empty orgId throws, naming the missing instrument", async () => {
    const insertChunks = vi.fn(async () => 0);
    await expect(
      loadChunksBatched(insertChunks, { orgId: "", scope: "labor-A", chunks: [] }),
    ).rejects.toThrow(/orgId/);
    expect(insertChunks).not.toHaveBeenCalled();
  });

  test("MUST_REFUSE: an empty scope throws, naming the missing instrument", async () => {
    const insertChunks = vi.fn(async () => 0);
    await expect(
      loadChunksBatched(insertChunks, { orgId: "org_a", scope: "", chunks: [] }),
    ).rejects.toThrow(/scope/);
    expect(insertChunks).not.toHaveBeenCalled();
  });

  test("MUST_REFUSE: a batchSize of 0 throws", async () => {
    const insertChunks = vi.fn(async () => 0);
    await expect(
      loadChunksBatched(insertChunks, {
        orgId: "org_a",
        scope: "labor-A",
        chunks: makeChunks(1),
        batchSize: 0,
      }),
    ).rejects.toThrow(/batchSize/);
  });
});
