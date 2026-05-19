# Batch reindex memories — self-host runbook

*Issued 2026-05-19 · Tier: Pro Support · For Cédric Delport (self-host)*

## Context

Following the embeddings-provider migration on 2026-05-06 (Vercel AI Gateway → direct OpenAI key) and the fix shipped in PRs #398 + #399 (BYOK fallback v1 + v2), every memory stored AFTER the deploy works as expected — `recall()` returns valid results (score 0.86 confirmed on your end).

What remains: memories stored BETWEEN 2026-05-06 and the deploy date kept their content rows in Convex but their vector embeddings under `@convex-dev/rag` are either missing or generated against the failing provider. Their `key=memoryId` records exist in the RAG index; only the vector itself needs replacement.

Because `rag.add(ctx, { key: memoryId, ... })` is idempotent under the same key, re-emitting an embedding for each pre-migration row overwrites the vector in place. No duplicates, no orphans, no schema change.

## What you need

- Latest `vantage-peers` main on disk (post commit landing this migration).
- Your Convex deploy keys for the two self-host projects:
  - `flippant-bullfrog-274`
  - `perceptive-firefly-422`
- `AI_GATEWAY_API_KEY` or `OPENAI_API_KEY` set in each Convex backend env (already done — that's the PR #398/#399 fix).

## Procedure (per deployment)

### Step 1 — Pull the migration

```bash
cd /path/to/vantage-peers
git checkout main && git pull
```

The migration file lives at `convex/migrations/reindexMemoriesByPeriod.ts`. No other code change is required.

### Step 2 — Deploy schema-equivalent code

```bash
npx convex deploy --yes
```

Schema is unchanged. This deploy registers the two new internal functions:

- `migrations/reindexMemoriesByPeriod:countByPeriod` (query, read-only)
- `migrations/reindexMemoriesByPeriod:reindexBatch` (mutation, schedules `rag.add` background actions)

### Step 3 — Count rows in the migration window

```bash
npx convex run migrations/reindexMemoriesByPeriod:countByPeriod \
  '{"startMs": 1778457600000, "endMs": 1779580799000}'
```

Returns:

```json
{
  "count": <total rows>,
  "sampleAvgContentChars": <avg chars>,
  "approxTokens": <token approximation>,
  "approxCostUSD": <USD>
}
```

Use this to confirm the row count looks plausible and the embedding cost is acceptable.

**Reference window (UTC ms epochs):**

- `1778457600000` = 2026-05-06T00:00:00Z
- `1779580799000` = 2026-05-19T23:59:59Z

Adjust `startMs` / `endMs` to narrow if you only need a sub-window.

### Step 4 — Reindex in batches

```bash
npx convex run migrations/reindexMemoriesByPeriod:reindexBatch \
  '{"startMs": 1778457600000, "endMs": 1779580799000, "limit": 200}'
```

Returns:

```json
{
  "processed": 200,
  "nextCursor": 1779100000000,
  "isDone": false
}
```

If `isDone: false`, repeat with `afterCreationTime: <nextCursor>`:

```bash
npx convex run migrations/reindexMemoriesByPeriod:reindexBatch \
  '{"startMs": 1778457600000, "endMs": 1779580799000, "limit": 200, "afterCreationTime": 1779100000000}'
```

Loop until `isDone: true`. Each call schedules `limit` background `rag.add` actions; the mutation itself returns in milliseconds. The embeddings finish asynchronously in the Convex action runtime.

### Step 5 — Wait for background actions to drain

Embeddings run as scheduled actions. Watch the Convex dashboard → **Functions** tab → filter on `ragSync:addRagEntry`. The throughput is bounded by OpenAI rate limits (≈ 3 000 RPM on standard tiers). If you see 429s, halve `limit` and pace the loop with a `sleep` between calls.

### Step 6 — Validate

Pick three memories you know existed in the window and confirm `recall()` now returns them with score > 0.5:

```
mcp__vantage-peers__recall query="<distinctive phrase from a known memory>" namespace="<that memory's namespace>" limit=5
```

Spot-check across each of the namespaces you actually use (`global`, `project/<bu>`, `orchestrator/<role>`).

## Idempotency + safety

- **Read-only:** `countByPeriod` is a query; running it any number of times is free and safe.
- **Replace-in-place:** `reindexBatch` schedules `rag.add` under `key=memoryId`. The RAG component overwrites the existing vector with the new embedding. No duplicates.
- **No data loss:** the mutation never deletes memory rows or RAG entries. The worst case of a failed batch is that some vectors remain unchanged — re-running covers them.
- **Re-runnable:** you can run the same window twice without consequence beyond the second embedding bill (which is still negligible).

## Cost

Pricing model: OpenAI `text-embedding-3-small` = $0.020 / 1M tokens. The `countByPeriod` query returns an approximation derived from total content chars (1 token ≈ 4 chars for prose, +20 % overhead for title + metadata). The number it prints is what you'll be billed within a small margin.

## Self-service vs Sigma-execute

Default path: **self-service.** Deploy keys for `flippant-bullfrog-274` and `perceptive-firefly-422` stay on your side. The procedure above is end-to-end.

If you'd rather have Sigma run it, share a temporary `CONVEX_DEPLOY_KEY` (rotate after) via secure channel and we execute Steps 3–5 from VPS. Either path produces the same result.

## Support

Any 429 spam, partial progress, or unexpected `nextCursor` behavior — reply to the same thread. Pro Support window applies.

— VantageOS Team
