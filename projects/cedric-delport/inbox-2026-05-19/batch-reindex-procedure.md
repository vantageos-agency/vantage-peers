# Batch reindex memories — self-host runbook

*Issued 2026-05-19 · Tier: Pro Support · For Cédric Delport (self-host VantagePeers)*

## Context

After the embeddings-provider migration on 2026-05-06 (Vercel AI Gateway → direct OpenAI key) and the fix shipped in PRs #398 + #399 (BYOK fallback v1 + v2), every memory stored AFTER the deploy works as expected — `recall()` returns valid results (score 0.86 confirmed on your end).

What remains: memories stored BETWEEN 2026-05-06 and the deploy date kept their content rows in Convex but their vector embeddings under `@convex-dev/rag` are either missing or generated against the failing provider. Their `key=memoryId` records exist in the RAG index; only the vector itself needs replacement.

Because `rag.add(ctx, { key: memoryId, ... })` is idempotent under the same key, re-emitting an embedding for each pre-migration row overwrites the vector in place. No duplicates, no orphans, no schema change.

## Run order

Two deployments to handle:

1. **`flippant-bullfrog-274`** — dev. Run the full procedure here first, validate, then move on.
2. **`perceptive-firefly-422`** — prod. Repeat the exact same steps once dev is green.

Treat each as an independent pass. The migration file is the same; only the deployment target changes.

## Pre-flight

### Code

```bash
cd /path/to/vantage-peers
git checkout main && git pull
```

Confirm the migration file exists at `convex/migrations/reindexMemoriesByPeriod.ts`. If not, this PR has not landed on main yet — ping Laurent to confirm merge status before continuing.

### Convex auth

The procedure runs entirely via `npx convex` CLI. You need to point each invocation at the right deployment.

Two ways — pick whichever you prefer:

**(a) Per-shell env var** — fastest, works without changing the project's `.env.local`:

```bash
# For dev runs:
export CONVEX_DEPLOY_KEY="<deploy key for flippant-bullfrog-274>"

# For prod runs (in a separate shell or after the dev pass is done):
export CONVEX_DEPLOY_KEY="<deploy key for perceptive-firefly-422>"
```

Both deploy keys are in your Convex dashboard → project → Settings → Deploy Keys.

**(b) Interactive login** — `npx convex login` then `npx convex dashboard` to verify the active deployment. Switch deployments via `npx convex env list --prod` vs default (dev).

In every command below, append `--prod` when you're operating on `perceptive-firefly-422`. Omit it (or use it without) for `flippant-bullfrog-274`.

## Procedure (run twice — once dev, once prod)

### Step 1 — Deploy the migration code

```bash
# Dev
npx convex deploy --yes

# Prod
npx convex deploy --yes --prod
```

Schema is unchanged. This deploy registers the two new internal functions:

- `migrations/reindexMemoriesByPeriod:countByPeriod` (query, read-only)
- `migrations/reindexMemoriesByPeriod:reindexBatch` (mutation, schedules `rag.add` background actions)

### Step 2 — Count rows in the migration window

```bash
# Dev
npx convex run migrations/reindexMemoriesByPeriod:countByPeriod \
  '{"startMs": 1778457600000, "endMs": 1779580799000}'

# Prod
npx convex run migrations/reindexMemoriesByPeriod:countByPeriod \
  '{"startMs": 1778457600000, "endMs": 1779580799000}' --prod
```

Output:

```json
{
  "count": <total rows>,
  "sampleAvgContentChars": <avg chars>,
  "approxTokens": <token approximation>,
  "approxCostUSD": <USD>
}
```

Read `count` and `approxCostUSD` to confirm both numbers look reasonable before you spend on the reindex. The cost approximation is OpenAI `text-embedding-3-small` × tokens (≈ 4 chars per token + 20 % metadata overhead).

**Reference window (UTC ms epochs):**

- `1778457600000` = `2026-05-06T00:00:00Z`
- `1779580799000` = `2026-05-19T23:59:59Z`

Narrow the window by adjusting `startMs` / `endMs` if you only need a sub-range.

### Step 3 — Reindex in batches

Two options.

**Option A — one batch at a time (safest, manual):**

```bash
# First batch (no cursor):
npx convex run migrations/reindexMemoriesByPeriod:reindexBatch \
  '{"startMs": 1778457600000, "endMs": 1779580799000, "limit": 200}'
```

Output:

```json
{ "processed": 200, "nextCursor": 1779100000000, "isDone": false }
```

If `isDone` is `false`, repeat with `afterCreationTime` set to the returned `nextCursor`:

```bash
npx convex run migrations/reindexMemoriesByPeriod:reindexBatch \
  '{"startMs": 1778457600000, "endMs": 1779580799000, "limit": 200, "afterCreationTime": 1779100000000}'
```

Repeat until `isDone` is `true`.

**Option B — bash loop (faster, requires `jq`):**

```bash
START=1778457600000
END=1779580799000
LIMIT=200
CURSOR=null

while :; do
  if [ "$CURSOR" = "null" ]; then
    PAYLOAD=$(printf '{"startMs":%d,"endMs":%d,"limit":%d}' "$START" "$END" "$LIMIT")
  else
    PAYLOAD=$(printf '{"startMs":%d,"endMs":%d,"limit":%d,"afterCreationTime":%d}' "$START" "$END" "$LIMIT" "$CURSOR")
  fi

  RES=$(npx convex run migrations/reindexMemoriesByPeriod:reindexBatch "$PAYLOAD")
  echo "$RES"

  DONE=$(echo "$RES" | jq -r '.isDone')
  CURSOR=$(echo "$RES" | jq -r '.nextCursor')

  [ "$DONE" = "true" ] && break
  sleep 2
done
```

Append `--prod` to the `npx convex run` line for the prod deployment.

Each batch schedules `LIMIT` background `rag.add` actions; the mutation itself returns in milliseconds. The embeddings finish asynchronously in the Convex action runtime.

### Step 4 — Wait for background actions to drain

Embeddings run as scheduled actions. Watch the Convex dashboard → **Functions** tab → filter on `ragSync:addRagEntry`.

Throughput is bounded by your OpenAI rate limit (≈ 3 000 RPM on standard tiers). If the dashboard shows 429s, lower `LIMIT` to `100` and the `sleep` to `5` in the bash loop, then re-run from the last successful `nextCursor`.

### Step 5 — Validate

Pick three memories you know existed in the window (e.g. anything stored on your Convex between 6 and 19 May 2026) and confirm `recall()` now returns them with score > 0.5.

**From Claude Code (recommended):**

```
mcp__vantage-peers__recall query="<distinctive phrase from a known memory>" namespace="<that memory's namespace>" limit=5
```

Spot-check at least one row per namespace you actually use (`global`, `project/<bu>`, `orchestrator/<role>`).

**From `npx convex run` (if your Claude Code is pointed elsewhere):**

```bash
npx convex run memories:recallMemories \
  '{"query":"<distinctive phrase>", "namespace":"global", "limit":5}'
```

Same call signature, same scoring. Append `--prod` for prod.

## Idempotency + safety

- **Read-only:** `countByPeriod` is a query; running it any number of times is free.
- **Replace-in-place:** `reindexBatch` schedules `rag.add` under `key=memoryId`. The RAG component overwrites the existing vector with the new embedding. No duplicates.
- **No data loss:** the mutation never deletes memory rows or RAG entries. The worst case of a failed batch is that some vectors remain unchanged — re-running covers them.
- **Re-runnable:** you can run the same window twice. The only consequence is a second OpenAI bill for the affected rows, which stays in the cents range.

## Cost

OpenAI `text-embedding-3-small` is priced at $0.020 per 1 M tokens. The `countByPeriod` query prints `approxCostUSD` so you see the exact number before paying. As a reference point, 1 000 average memories ≈ 500 000 tokens ≈ $0.01.

## Support

Any 429 spam, partial progress, or unexpected `nextCursor` behavior — reply to your usual VantageOS contact (Laurent / lp@perello.consulting). Pro Support window applies; we route from there.

— VantageOS Team
