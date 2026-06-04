# VantagePeers Cloud — Security & Multi-Tenant Doctrine

**Scope:** VantagePeers Cloud (multi-tenant). Self-host operations are documented separately under `docs/getting-started/`. The two products share the same security core but diverge on tenant isolation, emergency maintenance, and audit retention. Do not cross-apply runbooks.

This document is the canonical reference for the v2.4.14 security baseline.

---

## 1. OAuth 2.1 hardening

VantagePeers Cloud implements OAuth 2.1 with Dynamic Client Registration (DCR). Two controls are non-negotiable at the protocol surface.

### D6 — confidential `client_secret` at `/token`

- **Location:** `mcp-server/server-http.ts` L382-585.
- **Behavior:** clients registered as confidential at DCR (i.e. issued a `client_secret`) must present that secret on every token exchange (`grant_type=authorization_code` and `grant_type=refresh_token`).
- **Comparison:** `crypto.timingSafeEqual` over equal-length buffers. No `===`, no early exit, no length-based branching that could leak a timing oracle.
- **Failure mode:** missing or mismatched secret returns `invalid_client` per RFC 6749 §5.2.
- **Public clients:** clients registered without a secret remain PKCE-only. The `/token` endpoint does not require a secret for them.
- **Provenance:** PR #621, commit `5fd6354`. Test report: `docs/test-reports/s1.5-oauth-d6-d7-2026-06-03.md`.
- **S2.3 D8 brick migration (2026-06-04):** the `timingSafeEqual` implementation is now consumed from the shared npm brick `@vantageos/cloud-identity@0.1.0` (was an in-tree local module). The constant-time XOR-accumulate algorithm is unchanged; the brick's surface takes `Uint8Array` arguments and call sites at server-http.ts L580 + L711 wrap the hex digest strings via `TextEncoder.encode(...)`. Additionally, the **master-token gate** `masterOnlyMiddleware` (auth.ts L455) now consumes `validateMasterBearer` from the same brick, which sha256-hashes both the presented token and the configured master secret before constant-time comparing the digests — closing both the byte-oracle and length-oracle leaks present in the prior direct `token !== masterToken` compare. Coverage: every `/admin/*` route, including the `PATCH /admin/scope-profiles/:id` emergency endpoint. Test report: `docs/test-reports/s2.3-d8-vp-mcp-migration-cloud-identity-0.1.0-2026-06-04.md`.

### D7 — `redirect_uri` exact-match at `/authorize`

- **Location:** `mcp-server/server-http.ts` L298-376.
- **Behavior:** the authorization endpoint compares the inbound `redirect_uri` against every URI registered for the resolved `client_id` and accepts only a byte-identical match.
- **Explicitly rejected:** prefix match, host-only match, scheme normalization (`http` vs `https`), trailing-slash variance, percent-encoding variance.
- **Failure mode:** hard error returned to the user agent before any consent screen is rendered. No redirect is performed to an untrusted URI.
- **Provenance:** PR #621, commit `5fd6354`.

---

## 2. Emergency tenant maintenance — `patchScopeProfileEmergency`

Tenant operations that fall outside the normal admin path (scope-profile rewrite, key rename, large-scale cascade) are routed through a single master-token-gated mutation: `patchScopeProfileEmergency` in `convex/oauth.ts`.

### Invariants enforced inside the mutation

1. **D4 — no global wildcard in `cloud-*` profiles.** Any attempt to write `*` into a scope field of a profile whose key matches `cloud-*` is refused before any write occurs.
2. **D9 — cascade rename.** When a scope-profile key is renamed, every row in `oauth_clients` that references the old key is cascade-updated in the same transaction.
3. **Cascade-revoke tokens.** Every row in `oauth_tokens` issued under the old key is revoked atomically with the rename. No live token can survive a key rename.
4. **Append-only audit write.** Every successful invocation appends an `oauth_audit_log` row capturing actor, action, before/after snapshot, and timestamp. Failure to append is treated as a hard failure of the mutation.

### Authorization

- Caller must present the master operator token. No tenant-scoped credential can invoke this mutation.
- Master-token validation is constant-time; failure returns `unauthorized` without leaking which check failed.

### Provenance

- `patchScopeProfileEmergency` shipped in PR #622, commit `9a1b8cf`.
- D9 cascade-update across `oauth_clients` reached full enforcement parity in PR #623, commit `2f5c974`.
- Test reports: `docs/test-reports/s1.2-mutation-2026-06-03.md`, `docs/test-reports/s2.1-d9-cascade-clients-2026-06-03.md`.

### S2.2 D5 — HTTP wrapper `PATCH /admin/scope-profiles/:id`

Operators do not call Convex directly. The mutation is exposed at the MCP server HTTP surface as `PATCH /admin/scope-profiles/:id`, gated by `BEARER_SECRET_MASTER` via the existing `masterOnlyMiddleware` on the `/admin/*` Hono sub-app. The handler validates the body shape (`cascadeRevokeTokens: boolean` and `reason: string` are required; `rename` / `fromAllowList` / `namespaceReadPrefixes` / `namespaceWritePrefixes` are optional `string[]`), forwards to `oauth:patchScopeProfileEmergency`, and returns the mutation result body `{ patchedProfileId, cascadeRevokedCount, clientsRetargeted, auditLogId }` on 200. Convex throws are mapped to HTTP status: `profile not found` → 404, `D4 violation` → 400, `reason must be at least 40 characters` → 400, anything else → 500.

Token re-issue after cascade revoke is **not** an admin-endpoint responsibility: clients re-authenticate via the standard `/authorize` + `/token` flow against the patched profile. This keeps the emergency surface to a single revoke-and-audit primitive.

- Endpoint shipped in `feat/s2-2-d5-admin-scope-profiles-patch` (commit `ca2d2dd`, RED `f86fe75`).
- Test report: `docs/test-reports/s2.2-d5-admin-scope-profiles-patch-2026-06-04.md`.
- Phase tests: 13/13 PASS · Full mcp-server suite: 218/218 PASS (baseline 205 + 13 new).

---

## 3. `oauth_audit_log` — append-only ledger

- **Location:** `convex/schema.ts`.
- **Shape:** `{ ts, actor, action, before, after, context }`. `before` / `after` are JSON snapshots of the affected row(s).
- **Append-only:** there is no mutation path that updates or deletes rows in this table. Operationally this means the ledger is the system of record for every master-gated tenant change.
- **Coverage:** at v2.4.14, the only writer is `patchScopeProfileEmergency`. Any future master-gated mutation must write a ledger row as part of the same transaction; PR review checks enforce this.

---

## 4. S3.1 — scope-aware filter framework (D3)

The scope-aware filter framework is the single chokepoint that translates an authenticated caller's OAuth scope set into a row-level predicate applied to every multi-tenant list/get path.

- **Implementation:** `mcp-server/src/scope-filter.ts`.
- **Contract:** every list/get tool whose result set may span tenants composes its query through `scope-filter`. The filter rejects results the caller is not entitled to see, before they leave the server boundary.

### Wave A — initial surface (shipped, PR #624, main `251d183`)

- `list_memories`
- `get_memory`

Test report: `docs/test-reports/s3.1.a-scope-aware-filter-wave-a-2026-06-03.md`.

### Wave B — extended surface (shipped, PR #625, main `28db616`)

- `list_briefing_notes`
- `list_messages`
- `list_peers`

Wave B extends the framework across the remaining Marie-impacted cross-tenant-reachable read paths. Test report: `docs/test-reports/s3.1.b-scope-aware-filter-wave-b-2026-06-03.md`.

---

## 5. Cloud vs Self-host — non-negotiable separation

- **Cloud runbooks:** `docs/cloud/` only.
- **Self-host runbooks:** `docs/getting-started/` only.
- Briefs, mission descriptions, and operator messages must state "Cloud" or "Self-host" explicitly.
- The two products share the security core described above. They do **not** share tenant model, emergency tooling, or audit retention policy. Self-host operators run a single-tenant deployment; the cascade and ledger semantics in §2 and §3 do not apply in the same way.

---

## 5.b S3.3 B8 cursor paging rollout — COMPLETE

The envelope-safe cursor paging utility (`mcp-server/src/paging.ts`: `DEFAULT_LIMIT=50`, `MAX_LIMIT=200`, `ENVELOPE_TARGET_BYTES=50_000`) is now wired into **16 of 19** `list_*` / `search_*` tools in the Cloud MCP surface. The remaining 3 tools (`list_broadcast_status`, `search_components`, `search_fix_patterns`) carry explicit `@cursorPagingException` JSDoc markers documenting why cursor paging is not semantically applicable (single-object shape, relevance-ranked semantic search). Coverage is therefore **19 / 19** — every list/search tool has either cursor paging or a documented exception. See test reports `s3.3-followup-batch-1-cursor-paging-2026-06-04.md`, `s3.3-followup-batch-2-cursor-paging-2026-06-04.md`, and `s3.3-followup-batch-3-final-cursor-paging-2026-06-04.md`.

---

## 6. References

- PR #621 — D6 + D7 hardening at `/token` and `/authorize`.
- PR #622 — `patchScopeProfileEmergency` + `oauth_audit_log`.
- PR #623 — D9 full cascade-update across `oauth_clients`.
- PR #624 — S3.1 scope-aware filter Wave A.
- PR #625 — S3.1 scope-aware filter Wave B.
- Test reports: `docs/test-reports/s1.5-oauth-d6-d7-2026-06-03.md`, `docs/test-reports/s1.2-mutation-2026-06-03.md`, `docs/test-reports/s2.1-d9-cascade-clients-2026-06-03.md`, `docs/test-reports/s3.1.a-scope-aware-filter-wave-a-2026-06-03.md`, `docs/test-reports/s3.1.b-scope-aware-filter-wave-b-2026-06-03.md`.
