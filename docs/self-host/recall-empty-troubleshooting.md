# Troubleshooting: recall() / hybrid_search() return []

*Applies to: VantagePeers self-host v2.2.0 and earlier*
*Fixed in: v2.3.0 (PR #505)*

---

## Symptom

- `mcp__vantage-peers__recall` always returns `[]`
- `mcp__vantage-peers__hybrid_search` always returns `[]`
- `mcp__vantage-peers__text_search` (BM25) returns results normally
- `mcp__vantage-peers__store_memory` succeeds (no error)
- `mcp__vantage-peers__list_memories` returns rows normally

## Root Cause

In v2.2.0 and earlier, the embedding provider selection in `convex/lib/aiClient.ts`
routed **any value in `AI_GATEWAY_API_KEY`** to the Vercel AI Gateway base URL
(`https://ai-gateway.vercel.sh/v1`), regardless of whether the key was actually a
gateway token or a direct OpenAI API key.

If you placed a direct OpenAI API key (beginning with `sk-`) into `AI_GATEWAY_API_KEY`
rather than into `OPENAI_API_KEY`, the embedding call was sent to the gateway URL with a
key that the gateway does not accept. The gateway returned 401/empty, the RAG index
stored no vector for the new memory, and every vector search returned `[]`.

BM25 text search was unaffected because it never calls the embedding endpoint.

## Affected Configurations

You are affected if **all** of the following are true:

1. You set `AI_GATEWAY_API_KEY` in your Convex dashboard to a value that starts with
   `sk-` (a direct OpenAI key — legacy form `sk-abc...` or project form `sk-proj-abc...`).
2. You did **not** set `OPENAI_API_KEY`.
3. You are running VantagePeers v2.2.0 or earlier.

A common migration path that triggers this: you previously used a Vercel AI Gateway token
in `AI_GATEWAY_API_KEY`, then replaced it with a direct OpenAI key without renaming the
env var.

## Fix

### Step 1 — Upgrade to v2.3.0 (or later)

```bash
cd /path/to/vantage-peers
git pull origin main
```

Confirm `convex/lib/aiClient.ts` version by checking that `resolveEmbeddingPath` is
exported (introduced in v2.3.0).

### Step 2 — Fix your Convex environment variable

In the Convex dashboard (Settings → Environment Variables) for each deployment:

**Option A (recommended — canonical naming):**

1. Add `OPENAI_API_KEY` = `<your sk-... key>`
2. Delete `AI_GATEWAY_API_KEY` (or leave it — OPENAI_API_KEY takes priority)

**Option B (single-var approach — if you prefer one var):**

Leave `AI_GATEWAY_API_KEY` = `<your sk-... key>` and deploy v2.3.0. The fix detects the
`sk-` prefix and routes automatically to `api.openai.com/v1`. No var rename needed.

### Step 3 — Deploy

```bash
# Dev deployment
npx convex deploy --yes

# Prod deployment
npx convex deploy --yes --prod
```

### Step 4 — Verify new embeddings work

Store a test memory and immediately recall it:

```
mcp__vantage-peers__store_memory namespace="global" type="user" content="canary test 2026-05-21"
mcp__vantage-peers__recall query="canary test" namespace="global" limit=3
```

If `recall` returns the canary memory with a score > 0.5, the provider is working.

### Step 5 — Reindex pre-migration memories

Memories stored while the broken provider was active have no valid vector in the RAG
index. They will not appear in `recall` or `hybrid_search` until you reindex them.

The reindex mutation (`convex/migrations/reindexMemoriesByPeriod.ts`) is idempotent.
Running it replaces the stored vector under each `key=memoryId` — no duplicates, no data
loss.

**Count rows first (read-only, free):**

```bash
npx convex run migrations/reindexMemoriesByPeriod:countByPeriod \
  '{"startMs": 1746489600000, "endMs": 1748217600000}'
```

Replace `startMs` / `endMs` with the epoch-ms timestamps that bracket the period when
your provider was misconfigured. Use an online epoch converter if needed.

Reference epochs:
- `2026-05-06T00:00:00Z` = `1778457600000`
- `2026-05-21T23:59:59Z` = `1779695999000`

**Reindex in batches:**

```bash
START=1778457600000
END=1779695999000
LIMIT=200
CURSOR=null

while :; do
  if [ "$CURSOR" = "null" ]; then
    PAYLOAD=$(printf '{"startMs":%d,"endMs":%d,"limit":%d}' "$START" "$END" "$LIMIT")
  else
    PAYLOAD=$(printf '{"startMs":%d,"endMs":%d,"limit":%d,"afterCreationTime":%d}' \
      "$START" "$END" "$LIMIT" "$CURSOR")
  fi

  RES=$(npx convex run migrations/reindexMemoriesByPeriod:reindexBatch "$PAYLOAD")
  echo "$RES"

  DONE=$(echo "$RES" | jq -r '.isDone')
  CURSOR=$(echo "$RES" | jq -r '.nextCursor')

  [ "$DONE" = "true" ] && break
  sleep 2
done
```

Append `--prod` to the `npx convex run` line for production deployments.

**Wait for background actions to drain:**

Watch the Convex dashboard → Functions tab → filter on `ragSync:addRagEntry`.
All scheduled actions must reach status `success` before validation.

**Validate:**

Pick 3–5 memories you know were stored in the affected window and confirm `recall`
returns them with score > 0.5.

## Cost Estimate

OpenAI `text-embedding-3-small` is priced at $0.020 / 1M tokens. The `countByPeriod`
query prints `approxCostUSD` so you can confirm the number before paying. As a reference,
1,000 average-length memories ≈ $0.01.

## Related

- `convex/migrations/reindexMemoriesByPeriod.ts` — batch reindex mutation
- `docs/self-host/batch-reindex-procedure.md` — full self-host reindex runbook (internal)
- CHANGELOG v2.3.0 — root cause analysis and fix description
- PR #505 — code fix + tests
- PR #483 — batch reindex mutation (Day 76)

## Support

Pro Support clients: reply to your usual VantageOS contact (Laurent / lp@perello.consulting).
Community: open a GitHub issue on vantageos-agency/vantage-peers with the label `self-host`.
