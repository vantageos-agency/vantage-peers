// convex/loadChunks.ts — reusable batched loader: takes already-normalized
// chunks (contract shape, see normalizeSourceChunk.ts) and replays them into
// `insertChunks` (convex/chunks.ts) in batches of BATCH_SIZE, so a domain
// ingestion worker calls ONE committed function instead of hand-rolling its
// own batching loop. Zero domain knowledge here — this module knows nothing
// about legi/kali/fiches or any other domain, only the contract shape and
// the batching mechanics.
//
// Ported verbatim (logic unchanged) from @vantageos/corpus's
// component/loadChunks.ts (VP task k170s8gd4zj5f8aews4ja2xdwn8bqvj4, mission
// convergence), as part of data-lake absorbing corpus's distinct value.
//
// A Convex mutation has a payload-size ceiling; batching keeps each
// `insertChunks` call well under it regardless of corpus size (corpus's
// T-C1 proved 87292 chunks load fine at this batch size).

import type { NormalizedChunk } from "./normalizeSourceChunk";

export const DEFAULT_BATCH_SIZE = 500;

// The subset of the Convex `ctx`/client this loader needs: something that
// can run the `insertChunks` mutation. Kept minimal and untyped to the
// Convex runtime so this module stays testable with a plain mock — no
// `convex-test` harness required to exercise the batching logic itself.
export type InsertChunksFn = (args: {
	orgId: string;
	scope: string;
	chunks: NormalizedChunk[];
}) => Promise<number>;

export type LoadChunksResult = {
	totalChunks: number;
	batches: number;
	inserted: number;
};

// loadChunksBatched — splits `chunks` into batches of `batchSize` (default
// 500) and calls `insertChunks` once per batch, sequentially (never
// concurrent — insertChunks batches share the same (orgId, scope) target
// and sequential calls keep the ingestion order deterministic and replay
// re-runnable). Returns the total inserted count, derived from the sum of
// each batch's own return value — never assumed equal to `chunks.length`.
export async function loadChunksBatched(
	insertChunks: InsertChunksFn,
	args: {
		orgId: string;
		scope: string;
		chunks: NormalizedChunk[];
		batchSize?: number;
	},
): Promise<LoadChunksResult> {
	const { orgId, scope, chunks, batchSize = DEFAULT_BATCH_SIZE } = args;
	if (!orgId) {
		throw new Error(
			"loadChunksBatched: orgId is required — deny by default, refusing an unscoped load.",
		);
	}
	if (!scope) {
		throw new Error(
			"loadChunksBatched: scope is required — deny by default, refusing an unscoped load.",
		);
	}
	if (batchSize <= 0) {
		throw new Error(`loadChunksBatched: batchSize must be > 0, got ${batchSize}.`);
	}

	let inserted = 0;
	let batches = 0;
	for (let i = 0; i < chunks.length; i += batchSize) {
		const batch = chunks.slice(i, i + batchSize);
		const count = await insertChunks({ orgId, scope, chunks: batch });
		inserted += count;
		batches += 1;
	}

	return { totalChunks: chunks.length, batches, inserted };
}
