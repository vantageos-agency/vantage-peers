# @vantage/data-lake — Changelog

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
