# RED-PHASE EVIDENCE — S1.5 OAuth D6 + D7 TDD Discipline Audit

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
