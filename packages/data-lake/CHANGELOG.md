# @vantage/data-lake — Changelog

## 0.3.0 — 2026-05-21 (Phase E.0)

Architectural correction discovered via Xi deploy attempt to dev astute-turtle-213
(msg jn70qs563c0qj7np3fw7ze0rx5875vjq): Convex CLI 1.39.1 rejects "use node"
directives in Convex Component packages.

Refactor per Pi+Xi consensus option (b):
- DELETED: packages/data-lake/component/aiClient.ts (host-only now)
- searchV1.ts: removed "use node", refactored to accept pre-computed
  queryEmbedding from caller instead of inline embedding compute
- memoriesV1.ts: refactored store to accept optional embedding arg from
  caller (host action wraps with embedding compute)

Host convex/ unchanged. Embedding computation remains a host responsibility
via convex/lib/aiClient.ts. The Component is now pure DB ops + RAG storage,
no external API calls.

Phase D.2 host handlers (commit 0644cc7) already route via agent-protocol,
not data-lake, so unaffected by this refactor. Phase E PR #509 updates
required: description note that "use node" issue was resolved by this
architectural correction.

## 0.1.0 — 2026-05-21

- Initial scaffold (Phase A of C1 modularization).
- Empty `defineComponent("dataLake")` with empty schema.
- Package wired into `vantage-peers` monorepo (`packages/data-lake/`).
- No code move yet — Phase B moves memories + episodes + aiClient + search
  from host `convex/` folder.
- Convention reference: `decisions/c1-namespacing-convention-2026-05-21.md`.

## 0.2.0 — 2026-05-21 (Phase B.1)

Files moved (copied) from host `convex/` into `component/`:

| File | Source lines | Destination |
|------|-------------|-------------|
| `memoriesV1.ts` | 353 | `component/memoriesV1.ts` |
| `episodesV1.ts` | 187 | `component/episodesV1.ts` |
| `searchV1.ts` | 342 | `component/searchV1.ts` |
| `aiClient.ts` | 107 | `component/aiClient.ts` |

Schema changes:
- `component/schema.ts` — `memories` table defined inside Component (exact
  mirror of host `convex/schema.ts` memories definition, shared validators
  `memoryTypeValidator`, `creatorValidator`, `relationTypeValidator`,
  `severityValidator` co-located).

Generated stubs:
- `component/_generated/server.ts` — binds `queryGeneric`, `mutationGeneric`,
  `actionGeneric` (and internal variants) to component `DataModel`.
- `component/_generated/api.ts` — stubs `api.fixPatterns.get`,
  `internal.ragSync.{addRagEntry,markRagEntrySuperseded}`, `components` for tsc.
- `component/_generated/dataModel.ts` — derives `DataModel`, `Doc`, `Id` from
  component schema.

Adaptations from host:
- `searchV1.ts`: import path for `aiClient` changed from `./lib/aiClient` to
  `./aiClient` (flat component layout).
- All other imports unchanged (same relative `_generated/` paths, same schema
  validator imports).

Host `convex/` folder: zero modifications (D2 zero-regression verified).
Host tests: 295/295 green before and after.
tsc: 0 errors (`npx tsc --noEmit -p packages/data-lake/tsconfig.json`).

## Pending (Phase C+)

- Contract tests Suite 1 (per `decisions/c1-contract-tests-spec-2026-05-21.md`).
- Phase D cutover: `app.use(dataLake)` in host `convex/convex.config.ts`,
  remove duplicate host functions.
