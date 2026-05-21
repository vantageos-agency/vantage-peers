# @vantage/data-lake — Changelog

## 0.1.0 — 2026-05-21

- Initial scaffold (Phase A of C1 modularization).
- Empty `defineComponent("dataLake")` with empty schema.
- Package wired into `vantage-peers` monorepo (`packages/data-lake/`).
- No code move yet — Phase B moves memories + episodes + aiClient + search
  from host `convex/` folder.
- Convention reference: `decisions/c1-namespacing-convention-2026-05-21.md`.

## Pending (Phase B+)

- Move `memories` + `episodes` tables.
- Move `aiClient.ts` (embedding provider with PR #505 discriminated union).
- Expose `memoriesV1.{store,recall,validateIds,softDelete,get}`,
  `searchV1.{text,hybrid}`, `episodesV1.store`.
- Contract tests Suite 1 (per `decisions/c1-contract-tests-spec-2026-05-21.md`).
