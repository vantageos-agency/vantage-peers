# RED-PHASE EVIDENCE — S1.5 OAuth D6 + D7 TDD Discipline Audit

> Canonical S1.5 test report (D14 path): [`docs/test-reports/s1.5-oauth-d6-d7-2026-06-03.md`](../../docs/test-reports/s1.5-oauth-d6-d7-2026-06-03.md). This file is the detailed RED-phase audit referenced from that report.

**Branch:** `fix/oauth-d6-d7-confidential-client-validation`
**Date:** 2026-06-03
**Mission:** `k57c7s478gw1a3e5gmhdeptg5n87z78n` · Task `k17c8h9kdevcfpjqxtd77e6kms87ydjq`
**Auditor:** Sigma (TDD discipline check, post-Laurent intervention "on a dit TDD strict")

---

## Why this document exists

Strict TDD = **RED → GREEN → REFACTOR**. The original S1.5 deliverable reported `21/21 PASS` after implementing D6 (confidential client_secret validation at `/token`) and D7 (`redirect_uri` exact-match at `/authorize`), but did **not** demonstrate the prior RED phase. Without observing tests fail against the un-patched code, we cannot assert the tests actually exercise the security path — a green suite over a no-op guard is indistinguishable from a green suite over a real guard. This audit closes that loop after the fact by temporarily reverting the guards and recapturing the failure surface.

---

## SHAs

| Phase | SHA | State |
|---|---|---|
| GREEN baseline (D6+D7 patches landed) | `2988db2` | 21/21 PASS |
| RED revert (guards stripped, helper + schema kept) | `196f347` | 15/21 PASS · **6/21 FAIL** |
| GREEN restored (hard reset to baseline) | `2988db2` | 21/21 PASS re-verified |
| Final branch HEAD (after this doc commit) | _set on commit_ | 21/21 PASS |

The revert commit `196f347` only mutated `mcp-server/server-http.ts` (1 file, +3 / -96). The test file `mcp-server/test/oauth-d6-d7.test.ts` was **not** touched in either direction — the failure delta is attributable entirely to removing the guards.

---

## RED-phase test ratio: 6 FAIL / 15 PASS

Log: `/tmp/red-phase.log` (full vitest output captured during the RED commit).

### Tests that FAILED in RED (proving they exercise the security path)

| Test | Assertion | Got (RED) | Expected (GREEN) | Path exercised |
|---|---|---|---|---|
| **T3** — unregistered redirect_uri → 400 invalid_request | `expect(r.status).toBe(400)` | `302` | `400` | D7 `/authorize` exact-match guard |
| **T4** — prefix-only match (open-redirect attempt) → 400 | `expect(r.status).toBe(400)` | `302` | `400` | D7 `/authorize` exact-match guard |
| **T6** — authorization_code: missing client_secret → 401 invalid_client | `expect(r.status).toBe(401)` | `200` | `401` | D6 `/token` auth_code branch |
| **T7** — authorization_code: wrong client_secret → 401 | `expect(r.status).toBe(401)` | `200` | `401` | D6 `/token` auth_code branch (hash mismatch) |
| **T6b** — legacy client (no `tokenEndpointAuthMethod` field) defaults confidential → 401 without secret | `expect(r.status).toBe(401)` | `200` | `401` | D6 backward-compat default (absent field → `client_secret_basic`) |
| **T6d** — refresh_token grant: missing client_secret → 401 | `expect(r.status).toBe(401)` | `200` | `401` | D6 `/token` refresh_token branch |

Failure mode is consistent: the un-guarded `/authorize` falls through to the authorization-code mint and issues a `302` redirect to whatever `redirect_uri` was supplied (open-redirect); the un-guarded `/token` falls through to `loadScopeProfile` + token mint and returns `200` with a valid `access_token` regardless of credential presence/correctness. This is the exact attack surface D6 + D7 were written to close, and the tests catch it.

### Tests that PASSED in RED (and why this is correct, not a hole)

15 tests still passed in RED. Each is either a happy-path or a check on logic that is upstream of the stripped guards:

- **Helper unit tests** (3): `parseBasicAuthSecret` decodes Basic header, falls back to body, returns nulls. Helper was intentionally retained in the RED commit so the module would load.
- **T1, T2** — registered/multi-URI happy paths: 302 is correct in both RED and GREEN (the guard only fires on mismatch).
- **T5** — unknown `client_id` → 400 `invalid_client`: caught by the pre-existing `if (!client)` check, upstream of D7. **Expected to pass in RED.**
- **T8, T9, T6c, T6e** — happy paths with valid secret (Basic header / form body / legacy client / refresh_token): un-guarded `/token` returns 200 anyway, so the test's positive assertion is satisfied for the wrong reason. These tests do not exercise the negative path; their failing siblings (T6, T7, T6b, T6d) do.
- **T10** — public client (`auth_method=none`) skips secret check → 200: the guard's `if (authMethod !== "none")` branch is what's stripped, so public clients pass identically in both phases. **Expected to pass in RED.**
- **T11, T11b, T12, T13** — tenant scope-profile resolution + cross-tenant body override + `/mcp` bearer enforcement: orthogonal to D6/D7. Touch different code paths.

No test passed in RED unexpectedly. The brief named T9b/T9c as expected failures; the actual test file uses `T6d/T6e` for the refresh_token negative/positive pair — same coverage, different label, T6d failed as predicted.

---

## GREEN-phase verification

After `git reset --hard 2988db2`:

```
Test Files  1 passed (1)
     Tests  21 passed (21)
  Duration  1.83s
```

The same 21 tests that ran in RED with 6 failures now report all green at the baseline SHA. The delta is the 96 lines of guard code in `server-http.ts` and nothing else.

---

## TDD discipline statement

**RED phase observed at SHA `196f347`** — without the D6 confidential-client `/token` guard and the D7 `redirect_uri` exact-match `/authorize` guard, **6 of 21 tests FAIL** with the exact assertion mismatches enumerated above (`expected 400 got 302` for D7, `expected 401 got 200` for D6, in both the authorization_code and refresh_token branches and including the legacy-row backward-compat default). Each failure points at the precise endpoint and HTTP status the patches were written to enforce. The negative-path tests therefore genuinely exercise the security path — they are not vacuous assertions over already-rejecting upstream logic. **GREEN phase restored at SHA `2988db2`** with 21/21 PASS confirmed post-evidence-commit. RED → GREEN cycle closed and witnessed.

---

## Reproduction recipe (auditor playback)

```bash
cd /root/coding/vantage-memory
git checkout fix/oauth-d6-d7-confidential-client-validation

# RED — strip guards, keep helper:
git show 196f347 -- mcp-server/server-http.ts   # inspect revert diff
git checkout 196f347 -- mcp-server/server-http.ts
cd mcp-server && npm test                        # expect 6 FAIL / 15 PASS

# GREEN — restore:
cd .. && git checkout 2988db2 -- mcp-server/server-http.ts
cd mcp-server && npm test                        # expect 21/21 PASS
```

---

**Filed by:** Sigma — VantageOS Team Infra
**Reviewed-by (PR gate):** Pi (architecture) + Eta (security)

---

## S3.1.C Wave C Phase C0 — get_briefing_note registration + scope-aware

**Date:** 2026-06-03
**Branch:** `feat/s3-1-c0-get-briefing-note-registration`
**Mission:** `k57c7s478gw1a3e5gmhdeptg5n87z78n` · Task `k17fjd4dvp34k9q57t5e1qzrv187zz9n`

### SHAs

| Phase | SHA | State |
|---|---|---|
| RED — test file added, tool not yet registered | `4db05e4` | 3/11 FAIL (R1-R3 registration) · 8/11 PASS (slice contract) |
| GREEN — `get_briefing_note` registered in tools.ts | `d30a604` | 11/11 PASS (full suite 67/67) |

### RED-phase failure surface (3 tests)

| Test | Assertion | Got (RED) | Expected (GREEN) | Path exercised |
|---|---|---|---|---|
| **R1** — `tools.has("get_briefing_note")` | `expect(...).toBe(true)` | `false` | `true` | tools.ts registration of `get_briefing_note` |
| **R2** — schema has `noteId: string` input | `expect(t).toBeDefined()` | `undefined` | defined | tools.ts schema declaration |
| **R3** — annotations `readOnlyHint=true, destructiveHint=false` | `expect(t?.annotations.readOnlyHint).toBe(true)` | `undefined` | `true` | tools.ts annotations declaration |

R1-R3 use a lightweight duck-typed `McpServer` mock that captures every `.tool(name, desc, schema, annotations, handler)` call by `registerTools` and asserts presence + shape of the new registration. Failure mode is consistent: at RED, `get_briefing_note` is absent from the capture map; at GREEN, it is present with the expected schema + annotations.

### PASS-in-RED contract slice (8 tests)

U1-U5 + M1-M3 exercise `scopeFilterGet(ctx, row)` directly. They pass at both RED and GREEN because `scopeFilterGet` already exists from Wave A (`mcp-server/src/scope-filter.ts`). Their role is to lock in the contract that the GREEN patch wires `get_briefing_note` to `scopeFilterGet` (not to a different filter) — any future change that swaps the filter or removes the null-collapse behaviour will fail these.

- U1 — caller in scope → row returned
- U2 — backend `null` (note absent) → `null` (not-found shape preserved)
- U3 — `oauthCtx === undefined` (legacy bearer) → row returned regardless of tenancy
- U4 — master scope → foreign-tenant row returned
- U5 — scoped caller, row outside scope → `null` (non-leaky 404)
- M1 — cross-tenant: tenant-A row, tenant-B caller → `null`
- M2 — namespace-prefix allowed: row `orchestrator/nadia/x` + prefix `orchestrator/nadia` → row returned
- M3 — `fromAllowList` allowed: row.createdBy=`nadia` + allowList=[`nadia`] → row returned

### Reproduction

```bash
cd /root/coding/vantage-memory
git checkout feat/s3-1-c0-get-briefing-note-registration

# RED
git checkout 4db05e4
cd mcp-server && npx vitest run test/get-briefing-note-scope-aware.test.ts
# expect 3 FAIL / 8 PASS

# GREEN
cd .. && git checkout d30a604
cd mcp-server && npx vitest run test/get-briefing-note-scope-aware.test.ts
# expect 11/11 PASS
```

**Filed by:** Sigma — VantageOS Team

---

## S3.1.C Wave C Phase C1 — 7 read-path tools scope-aware applied

**Date:** 2026-06-03
**Branch:** `feat/s3-1-c1-scope-aware-batch-1`
**Mission:** `k57c7s478gw1a3e5gmhdeptg5n87z78n` · Task `k17fjd4dvp34k9q57t5e1qzrv187zz9n`
**Canonical D14 report:** `docs/test-reports/s3.1.c1-scope-aware-batch-1-2026-06-03.md`

### Tools covered (7, first source-order batch from the remaining 21 sites)

1. `get_profile` (tools.ts L1034) → `scopeFilterGet` on `profiles:getProfile`
2. `list_broadcast_status` (tools.ts L1716) → `scopeFilterList` on `messages:listBroadcastStatus`
3. `list_tasks_by_mission` (tools.ts L2383) → `scopeFilterList` on `tasks:listByMission`
4. `get_mission` (tools.ts L2585) → `scopeFilterGet` on `missions:get`
5. `get_diary` (tools.ts L2802) → `scopeFilterGet` on `diary:get` (marker re-wired to filtered row)
6. `list_components` (tools.ts L3266) → `scopeFilterList` on `components:list`
7. `get_component` (tools.ts L3307) → `scopeFilterGet` on `components:get`

### SHAs

| Phase | SHA | State |
|---|---|---|
| RED — tests added, handlers still call `guardMasterOnly` | `65b9e92` | 21/35 FAIL · 14/35 PASS |
| GREEN — `guardMasterOnly` removed, scope-aware filter applied | `1387f69` | 35/35 PASS · full suite 102/102 |

### RED-phase failure surface (21 tests)

Per tool: 5 tests (T1 master, T2 non-master in-scope, T3 legacy bearer, M1 cross-tenant, M2 own-tenant). T1 + T3 pass at RED because `guardMasterOnly` is a no-op for master scope and undefined `oauthCtx` (legacy bearer). T2 + M1 + M2 FAIL at RED because the handler short-circuits with `mcpError("Forbidden: <toolName> requires master scope (current: <profile>).")` (`isError: true`) before any scope-filter can run — the negative assertion `expect(isForbiddenResponse(res)).toBe(false)` inverts at GREEN.

Failure cardinality: 3 FAIL × 7 tools = 21. PASS-in-RED: 2 × 7 = 14.

### Reproduction

```bash
cd /root/coding/vantage-memory
git checkout feat/s3-1-c1-scope-aware-batch-1

# RED
git checkout 65b9e92
cd mcp-server && npx vitest run test/scope-aware-filter-wave-c1.test.ts
# expect 21 FAIL / 14 PASS / 35 total

# GREEN
cd .. && git checkout 1387f69
cd mcp-server && npx vitest run test/scope-aware-filter-wave-c1.test.ts
# expect 35/35 PASS

# Full suite at GREEN
cd mcp-server && npx vitest run
# expect 102/102 PASS (67 baseline + 35 new, zero regression)
```

**Filed by:** Sigma — VantageOS Team

---

## S3.1.C Wave C Phase C2 — 7 read-path tools scope-aware applied

**Date:** 2026-06-03
**Branch:** `feat/s3-1-c2-scope-aware-batch-2`
**Mission:** `k57c7s478gw1a3e5gmhdeptg5n87z78n` · Task `k17fjd4dvp34k9q57t5e1qzrv187zz9n`
**Canonical D14 report:** `docs/test-reports/s3.1.c2-scope-aware-batch-2-2026-06-03.md`

### Tools covered (next 7 source-order sites after C1)

1. `search_components` (tools.ts L3451) → `scopeFilterList` on `components:search`
2. `list_recurring_tasks` (tools.ts L3571) → `scopeFilterList` on `recurringTasks:list`
3. `list_mandates` (tools.ts L4033) → `scopeFilterList` on `mandates:list`
4. `get_bu` (tools.ts L4266) → `scopeFilterGet` on `businessUnits:get`
5. `list_bus` (tools.ts L4319) → `scopeFilterList` on `businessUnits:list`
6. `list_repo_mappings` (tools.ts L4459) → `scopeFilterList` on `githubRepoMapping:list`
7. `list_issues` (tools.ts L4565) → `scopeFilterList` on the materialised `results` of `issues:listByOrchestrator` / `issues:listByProject` / `issues:listByStatus` branches

### SHAs

| Phase | SHA | State |
|---|---|---|
| RED — tests added, handlers still call `guardMasterOnly` | `bf631f9` | 21/35 FAIL · 14/35 PASS |
| GREEN — `guardMasterOnly` removed, scope-aware filter applied | `0d01bc1` | 35/35 PASS · full suite 137/137 |

### RED-phase failure surface (21 tests)

Per tool: 5 tests (T1 master, T2 non-master in-scope, T3 legacy bearer, M1 cross-tenant, M2 own-tenant). T1 + T3 pass at RED (master no-op / undefined ctx no-op). T2 + M1 + M2 FAIL at RED because the handler short-circuits with `mcpError("Forbidden: <toolName> requires master scope (current: <profile>).")` (`isError: true`) before any scope-filter can run — the negative assertion `expect(isForbiddenResponse(res)).toBe(false)` inverts at GREEN.

Failure cardinality: 3 FAIL × 7 tools = 21. PASS-in-RED: 2 × 7 = 14.

### Reproduction

```bash
cd /root/coding/vantage-memory
git checkout feat/s3-1-c2-scope-aware-batch-2

# RED
git checkout bf631f9
cd mcp-server && npx vitest run test/scope-aware-filter-wave-c2.test.ts
# expect 21 FAIL / 14 PASS / 35 total

# GREEN
cd .. && git checkout 0d01bc1
cd mcp-server && npx vitest run test/scope-aware-filter-wave-c2.test.ts
# expect 35/35 PASS

# Full suite at GREEN
cd mcp-server && npx vitest run
# expect 137/137 PASS (102 baseline + 35 new, zero regression)
```

**Filed by:** Sigma — VantageOS Team

---

## § S3.1.C3 — Scope-Aware Filter Wave C, FINAL BATCH (8 tools: 7 reads + 1 write)

**Date:** 2026-06-03
**Branch:** `feat/s3-1-c3-scope-aware-final-batch`
**Mission:** `k57c7s478gw1a3e5gmhdeptg5n87z78n` · Task `k17fjd4dvp34k9q57t5e1qzrv187zz9n`
**Canonical D14 report:** `docs/test-reports/s3.1.c3-scope-aware-final-batch-2026-06-03.md`

### Tools covered (final 8 grep-derived `guardMasterOnly` sites)

Inventory derived authoritatively from `grep -n "guardMasterOnly" mcp-server/src/tools.ts` against pre-patch HEAD — NOT from prior memory or briefing recall. Adopts Eta's capitalize doctrine candidate **"scope-aware-migration-inventory-must-be-grep-derived-not-memory-derived"**.

1. `get_issue` (tools.ts L4652) → `scopeFilterGet` on `issues:getByRepoNumber`
2. `issue_stats` (tools.ts L4837) → `scopeFilterGet` on `issues:getStats`
3. `search_fix_patterns` (tools.ts L5060) → `scopeFilterList` on action `search:searchFixPatterns`
4. `list_fix_patterns` (tools.ts L5113) → `scopeFilterList` on both `fixPatterns:listByProject` and `fixPatterns:listAll` branches
5. `get_mission_template` (tools.ts L5202) → `scopeFilterGet` on `missionTemplates:getByName`
6. `instantiate_template_into_mission` (tools.ts L5364) → **pre-mutation** `scopeFilterGet` on `missions:get` BEFORE `missionTemplates:instantiateTemplateIntoMission`
7. `list_errors` (tools.ts L5533) → `scopeFilterList` on `errorMonitor:listErrors`
8. `get_error` (tools.ts L5571) → `scopeFilterGet` on `errorMonitor:getError`

### soft_delete_memory exempt rationale (intentional non-migration)

`soft_delete_memory` (tools.ts L710) remains `guardMasterOnly` by design. The underlying mutation `memories:softDelete` accepts only `memoryId` — no namespace / `createdBy` context — so no per-resource RBAC is possible without a separate backend doctrine change. Destructive operation: silent cross-tenant data loss risk on a wrong scope check. Excluded from migration on purpose; Wave C terminal coverage = **28/29 = 96%** by migration definition.

### SHAs

| Phase | SHA | State |
|---|---|---|
| RED — tests added, handlers still call `guardMasterOnly` | `f7f9bb4` | 23/40 FAIL · 17/40 PASS |
| GREEN — `guardMasterOnly` removed, scope-aware filter applied | `3130901` | 40/40 PASS · full suite 177/177 |

### RED-phase failure surface (23 tests)

Per tool: 5 tests (T1 master, T2 non-master in-scope, T3 legacy bearer, M1 cross-tenant, M2 own-tenant). For the 7 read-path tools: T1 + T3 pass at RED (master / undefined ctx no-op), T2 + M1 + M2 FAIL at RED (Forbidden envelope) = 3 × 7 = 21 FAIL.

For `instantiate_template_into_mission` (write, pre-mutation): T1, T3, ITM-M1 pass at RED (T1/T3 short-circuit OK; M1 asserts mutation NOT called and `res.isError === true` — both held at RED via Forbidden short-circuit); T2 and M2 FAIL at RED (assert NOT Forbidden + mutation runs).

Total: 17 PASS-in-RED + 23 FAIL-in-RED = 40. RED→GREEN delta on T2/M1/M2 read paths and T2/M2 write paths is observable.

### Reproduction

```bash
cd /root/coding/vantage-memory
git checkout feat/s3-1-c3-scope-aware-final-batch

# RED
git checkout f7f9bb4
cd mcp-server && npx vitest run test/scope-aware-filter-wave-c3.test.ts
# expect 23 FAIL / 17 PASS / 40 total

# GREEN
cd .. && git checkout 3130901
cd mcp-server && npx vitest run test/scope-aware-filter-wave-c3.test.ts
# expect 40/40 PASS

# Full suite at GREEN
cd mcp-server && npx vitest run
# expect 177/177 PASS (137 baseline + 40 new, zero regression)
```

**Filed by:** Sigma — VantageOS Team


---

## S3.3 B8 — list_* cursor paging + envelope cap protection

**Branch:** `feat/s3-3-b8-list-tools-cursor-paging`
**Date:** 2026-06-04
**Mission:** `k57c7s478gw1a3e5gmhdeptg5n87z78n` · Task `k1794r6q329q1s36pz4zzjnpvd87zfbn`

| Phase | SHA       | Suite outcome (paging)                    | Full mcp-server suite |
| ----- | --------- | ----------------------------------------- | --------------------- |
| RED   | `602795b` | 1 suite FAIL (module `../src/paging.js` missing) | not run separately |
| GREEN | `c1ba9a1` | 28/28 PASS                                | 205/205 PASS (177 baseline + 28 new) |

Tools wired (3): `list_tasks`, `list_memories`, `list_briefing_notes`.
Backend changed: `convex/tasks.ts list()` + `convex/briefingNotes.ts list()`
accept `createdBefore: v.optional(v.number())`. `convex/memories.ts listMemories`
already supports `paginationOpts` (Day-N work) — MCP forwards `backendCursor`
unchanged.

### Reproduction

```bash
cd /root/coding/vantage-memory
git checkout feat/s3-3-b8-list-tools-cursor-paging

# RED
git checkout 602795b
cd mcp-server && npx vitest run test/list-tools-cursor-paging.test.ts
# expect Cannot find module '../src/paging.js' — 1 suite FAIL

# GREEN
cd .. && git checkout c1ba9a1
cd mcp-server && npx vitest run test/list-tools-cursor-paging.test.ts
# expect 28/28 PASS

# Full suite at GREEN
cd mcp-server && npx vitest run
# expect 205/205 PASS (zero regression vs 177 baseline)
```

**Filed by:** Sigma — VantageOS Team

---

## § S2.2 D5 — PATCH /admin/scope-profiles/:id (HTTP wrapper)

**Branch:** `feat/s2-2-d5-admin-scope-profiles-patch`
**Date:** 2026-06-04
**Mission:** `k57c7s478gw1a3e5gmhdeptg5n87z78n` · Task `k1760d42tbpxqs0h57d1bzt8h187yga4`
**Test report (D14 canonical):** `docs/test-reports/s2.2-d5-admin-scope-profiles-patch-2026-06-04.md`

### SHAs

| Phase | SHA | State |
|---|---|---|
| RED (tests only, route not implemented) | `f86fe75` | 4/13 PASS · **9/13 FAIL** |
| GREEN (route added in server-http.ts) | `ca2d2dd` | 13/13 PASS |
| Full mcp-server suite at GREEN | `ca2d2dd` | 218/218 PASS (baseline 205 + 13 new) |

### RED → GREEN delta (verifiable)

- RED: 9 tests fail because Hono returns 404 for the undefined PATCH route
  (T1 happy path; T5 missing required field 400; T5b reason missing 400;
  T5b' reason-too-short bubble; T6 rename + clientsRetargeted; T7 cascade
  revoke count; T8 not-found bubble → 404; T9 D4 violation bubble; T10 shape).
- 4 tests already pass in RED — `masterOnlyMiddleware` fires for the entire
  `/admin/*` prefix and returns 401/403/400 before reaching the missing
  route (T2 missing auth, T3 wrong bearer, T4 malformed bearer, T5d body parse).
- GREEN delta is exclusively in `mcp-server/server-http.ts` (route handler add).
  Test file untouched between RED and GREEN.

### How to reproduce

```bash
git fetch origin

# RED
git checkout f86fe75
cd mcp-server && npx vitest run test/admin-scope-profiles-patch.test.ts
# expect 4 PASS / 9 FAIL

# GREEN
cd .. && git checkout ca2d2dd
cd mcp-server && npx vitest run test/admin-scope-profiles-patch.test.ts
# expect 13/13 PASS

# Full suite at GREEN
cd mcp-server && npx vitest run
# expect 218/218 PASS (baseline 205 + 13 new, zero regression)
```

**Filed by:** Sigma — VantageOS Team

---

## § S2.3 D8 — VP MCP migration to `@vantageos/cloud-identity@0.1.0` (2026-06-04)

**Branch:** `feat/s2-3-d8-vp-mcp-migrate-cloud-identity-0.1.0`
**Mission:** `k57c7s478gw1a3e5gmhdeptg5n87z78n`
**Task:** `k1707g7qa0stt6bd2g0w2pnp3h87y9xw`
**Canonical report:** [`docs/test-reports/s2.3-d8-vp-mcp-migration-cloud-identity-0.1.0-2026-06-04.md`](../../docs/test-reports/s2.3-d8-vp-mcp-migration-cloud-identity-0.1.0-2026-06-04.md)

### RED commit
- SHA: `fbe73e066c8cf6cf3dcbdbe23c7632bff9aa8cdf`
- Change: delete `mcp-server/src/crypto.ts` + `mcp-server/src/scope-filter.ts`; add `@vantageos/cloud-identity@^0.1.0` to `mcp-server/package.json` dependencies.
- Expected failure: 10/10 test files fail at module resolution with `Cannot find module ../src/crypto.js` and `Cannot find module ../src/scope-filter.js`.
- Observed failure: matched expectation. Vitest output reports `Test Files 10 failed (10) | Tests no tests` — no test cases load because every importer chain breaks before collection.

### GREEN commit
- SHA: `ce9f7ba335491eda28d2a001366f421df77e6df7`
- Change: rewire all 7 importers to `@vantageos/cloud-identity` (3 source + 4 test files). Apply SECURITY UPGRADE in `mcp-server/src/auth.ts` `masterOnlyMiddleware` (replace non-constant-time direct compare with brick's `validateMasterBearer` which sha256-hashes both sides and constant-time-compares the digests). Wrap `timingSafeEqual` call sites with `TextEncoder.encode(...)` to match brick `Uint8Array` surface.
- Test ratio: 254/254 PASS (baseline preserved, zero regression).
- TypeScript: `tsc --noEmit` clean.

### SECURITY UPGRADE note
The migration is not a pure refactor — it ships a measurable security hardening of the master-token gate by replacing the previous `token !== masterToken` direct string compare (non-constant-time, length-oracle + byte-oracle) with the brick's hash-then-constant-time-compare path. Coverage extends to every `/admin/*` route (S2.2 D5 PATCH endpoint, all OAuth admin routes).

### Reproduce
```
git checkout fbe73e066c8cf6cf3dcbdbe23c7632bff9aa8cdf
cd mcp-server && npx vitest run         # expect 10 test files FAIL
git checkout ce9f7ba335491eda28d2a001366f421df77e6df7
cd mcp-server && npx vitest run         # expect 254/254 PASS
```

**Filed by:** Sigma — VantageOS Team | 2026-06-04
