// ─────────────────────────────────────────────────────────────────────────────
// reindexMemoriesByPeriod — batch reindex memories embeddings for a period
// ─────────────────────────────────────────────────────────────────────────────
//
// PURPOSE
// Re-emit embeddings for every memory created in a time window. Used after an
// embeddings-provider migration (e.g. Vercel AI Gateway → direct OpenAI key on
// 2026-05-06) where existing rows kept content + RAG entries but the indexed
// vectors became invalid or empty. `rag.add` is idempotent on key=memoryId, so
// re-calling it for each row replaces the embedding under the same key.
//
// SCHEMA NOTE
// `memories` does NOT track embedding_provider_version. The query therefore
// reindexes ALL memories whose `createdAt` falls in [startMs, endMs]. Safe by
// design (idempotent replace). Operator must specify the period.
//
// WHEN TO RUN
// After confirming `recall()` returns valid results for memories stored AFTER
// the migration date (proof the new provider works), and you only need to
// rebuild vectors for the pre-migration tail.
//
// USAGE
//
//   # 1. Count rows in the window (read-only, no cost)
//   npx convex run migrations/reindexMemoriesByPeriod:countByPeriod \
//     '{"startMs": 1778457600000, "endMs": 1779580800000}'
//
//   # 2. Reindex one batch (schedules N rag.add background actions)
//   npx convex run migrations/reindexMemoriesByPeriod:reindexBatch \
//     '{"startMs": 1778457600000, "endMs": 1779580800000, "limit": 200}'
//
//   # Returns { processed, nextCursor, isDone }.
//   # Repeat with afterCreationTime=nextCursor until isDone=true.
//
// PERIOD REFERENCE (UTC ms epochs)
//   2026-05-06T00:00:00Z = 1778457600000
//   2026-05-19T23:59:59Z = 1779580799000
//
// COST
// text-embedding-3-small pricing: $0.020 / 1M tokens. The countByPeriod query
// returns a token approximation derived from total content chars (1 token ≈ 4
// chars for prose, plus 20 % overhead for title + metadata) so the operator
// can confirm cost before running reindexBatch. 1 000 average memories land
// near $0.01 in our reference dataset.
//
// IDEMPOTENCY
// `rag.add(ctx, { key: memoryId, ... })` replaces under the same key.
// Re-running the same window does not duplicate rows or vectors.
//
// SAFETY
// - Read-only `countByPeriod` is safe to run anytime.
// - `reindexBatch` schedules background actions; it does NOT block on
//   embeddings, so a single transaction can fan out hundreds of jobs without
//   hitting Convex action-runtime limits.
// - Throughput is bounded by OpenAI rate limits. Use limit=100–200 per batch
//   and pace if you hit 429s.

import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

const REINDEX_PAGE_SIZE = 200;

// ─── countByPeriod ──────────────────────────────────────────────────────────
// Read-only count of memories in [startMs, endMs]. Returns total + an average
// content-length so the operator can estimate embedding cost.

export const countByPeriod = internalQuery({
	args: {
		startMs: v.number(),
		endMs: v.number(),
	},
	returns: v.object({
		count: v.number(),
		sampleAvgContentChars: v.number(),
		approxTokens: v.number(),
		approxCostUSD: v.number(),
	}),
	handler: async (ctx, args) => {
		// `memories` has no createdAt index; scan + filter is acceptable here
		// because this is a one-shot operator action.
		const rows = await ctx.db
			.query("memories")
			.filter((q) =>
				q.and(
					q.gte(q.field("createdAt"), args.startMs),
					q.lte(q.field("createdAt"), args.endMs),
				),
			)
			.collect();

		const count = rows.length;
		const totalChars = rows.reduce((sum, r) => sum + r.content.length, 0);
		const sampleAvgContentChars = count > 0 ? Math.round(totalChars / count) : 0;

		// Token approximation: 1 token ≈ 4 chars for prose, +20 % overhead for
		// title + metadata sent alongside the content in the embedding call.
		const approxTokens = Math.round((totalChars / 4) * 1.2);

		// text-embedding-3-small pricing: $0.020 / 1M tokens
		const approxCostUSD = (approxTokens / 1_000_000) * 0.02;

		return { count, sampleAvgContentChars, approxTokens, approxCostUSD };
	},
});

// ─── reindexBatch ───────────────────────────────────────────────────────────
// Schedule rag.add for up to `limit` memories in the window, ordered by
// _creationTime. Returns the cursor of the last processed row so the operator
// can iterate to completion.

export const reindexBatch = internalMutation({
	args: {
		startMs: v.number(),
		endMs: v.number(),
		limit: v.optional(v.number()),
		// Resume cursor — pass `nextCursor` from the previous call (or omit).
		afterCreationTime: v.optional(v.number()),
	},
	returns: v.object({
		processed: v.number(),
		nextCursor: v.union(v.number(), v.null()),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const limit = args.limit ?? REINDEX_PAGE_SIZE;

		// Order by _creationTime ascending so the cursor is monotonic.
		// Filter by createdAt window + (if resuming) _creationTime > cursor.
		const rows = await ctx.db
			.query("memories")
			.filter((q) => {
				const inWindow = q.and(
					q.gte(q.field("createdAt"), args.startMs),
					q.lte(q.field("createdAt"), args.endMs),
				);
				if (args.afterCreationTime !== undefined) {
					return q.and(
						inWindow,
						q.gt(q.field("_creationTime"), args.afterCreationTime),
					);
				}
				return inWindow;
			})
			.order("asc")
			.take(limit + 1);

		const hasMore = rows.length > limit;
		const batch = hasMore ? rows.slice(0, limit) : rows;

		for (const row of batch) {
			await ctx.scheduler.runAfter(0, internal.ragSync.addRagEntry, {
				memoryId: row._id,
				content: row.content,
				namespace: row.namespace,
				type: row.type,
			});
		}

		const nextCursor = hasMore ? batch[batch.length - 1]._creationTime : null;
		return {
			processed: batch.length,
			nextCursor,
			isDone: !hasMore,
		};
	},
});
