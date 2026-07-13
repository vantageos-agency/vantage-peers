# VantagePeers Cloud — Security & Multi-Tenant Doctrine

**Scope:** VantagePeers Cloud (multi-tenant). Self-host operations are documented separately under `docs/getting-started/`. The two products share the same security core but diverge on tenant isolation, emergency maintenance, and audit retention. Do not cross-apply runbooks.

This document is the canonical reference for the v2.12.0 security baseline.

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

### D8 — DCR `redirect_uris` validation at `POST /register`

- **Location:** `mcp-server/server-http.ts` L333-405.
- **Rationale:** RFC 7591 §3.2.2 mandates `invalid_redirect_uri` as the canonical error when `redirect_uris` is absent, empty, or invalid. Without this guard, a client can be stored with an empty `redirectUris` array and subsequently bypass the D7 exact-match check (zombie-client class — e.g. prod client `87abdf5c-616b-4767-8a96-5ca04db88d9f`).
- **Behavior — five rejection shapes (all return HTTP 400 `invalid_redirect_uri`):**
  1. `redirect_uris` absent from body or not an array.
  2. `redirect_uris` is an empty array (`length === 0`).
  3. Any element is not a `string`.
  4. Any element is not a parseable URL (`new URL(uri)` throws).
  5. Any element has a scheme other than `https:` — or `http:` unless the host is `localhost` / `127.0.0.1` (dev exemption). Fragments (`#...`) are also rejected per RFC 6749 §3.1.2.
- **Defense-in-depth:** the same guard is enforced at the Convex layer in `convex/oauth.ts` (`registerPublicClient`, which throws `InvalidRedirectUris` on an empty array), ensuring the contract holds even if the HTTP surface is bypassed.
- **Failure mode:** `{ error: "invalid_redirect_uri", error_description: "redirect_uris is required and must be a non-empty array of valid HTTPS URIs" }` — no client row is persisted.
- **Provenance:** commit `2f3e653` (TDD fix), biome cleanup `60f5f51`. Test coverage: RED-then-GREEN, unit suite in `convex/__tests__/`.

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
- **Coverage:** at v2.5.0, the only writer is `patchScopeProfileEmergency`. Any future master-gated mutation must write a ledger row as part of the same transaction; PR review checks enforce this.

---

## 4. S3.1 — scope-aware filter framework (D3) — rewritten Day 92

The scope-aware filter framework is the single chokepoint that translates an authenticated caller's OAuth scope into row-level predicates applied to every multi-tenant list/get path. This section was rewritten on Day 92 to clarify three distinct concepts that had been conflated in prior implementations and caused production regressions (see §4.4).

---

### §4.1 Three distinct concepts — DO NOT CONFLATE

**EN — Three fields in a `scope_profile` document serve entirely different purposes. Conflating them causes security regressions.**

| Concept | Type | Purpose | Never used as |
|---|---|---|---|
| `scope_profile.name` | `string` (opaque identifier) | Uniquely identifies a scope-profile record in the catalog. Human-readable slug (`zoe-acme-hr`, `alpha-test-trio`). | Orchestrator ID, namespace prefix, identity filter value |
| `scope_profile.fromAllowList[]` | `string[]` | Exhaustive list of orchestrator IDs authorized to appear as `assignedTo`, `createdBy`, `from`, `recipient`, `pilot` under this scope. | Namespace filter, profile name comparison |
| `scope_profile.namespaceReadPrefixes[]` | `string[]` | Prefix list for namespace-scoped **READ** operations (`list_memories`, `recall`, `get_memory`). | Identity filter, write gate |
| `scope_profile.namespaceWritePrefixes[]` | `string[]` | Prefix list for namespace-scoped **WRITE** operations (`store_memory`). | Identity filter, read gate |

**FR — Trois champs dans un document `scope_profile` ont des rôles entièrement distincts. Les confondre provoque des régressions de sécurité.**

| Concept | Type | Rôle | Ne jamais utiliser comme |
|---|---|---|---|
| `scope_profile.name` | `string` (identifiant opaque) | Identifie de manière unique un enregistrement scope-profile dans le catalogue. Slug lisible (`zoe-acme-hr`, `alpha-test-trio`). | ID d'orchestrateur, préfixe de namespace, valeur de filtre d'identité |
| `scope_profile.fromAllowList[]` | `string[]` | Liste exhaustive des IDs d'orchestrateurs autorisés à apparaître comme `assignedTo`, `createdBy`, `from`, `recipient`, `pilot` sous ce scope. | Filtre de namespace, comparaison de nom de profil |
| `scope_profile.namespaceReadPrefixes[]` | `string[]` | Liste de préfixes pour les opérations de **LECTURE** par namespace (`list_memories`, `recall`, `get_memory`). | Filtre d'identité, verrou d'écriture |
| `scope_profile.namespaceWritePrefixes[]` | `string[]` | Liste de préfixes pour les opérations d'**ÉCRITURE** par namespace (`store_memory`). | Filtre d'identité, verrou de lecture |

---

### §4.2 Identity-filter tools — `fromAllowList[]` semantic

**EN — For a non-master bearer, identity-filter tools MUST gate the request using `fromAllowList`, not `scope_profile.name`.**

```typescript
/**
 * Returns true when the presented identity is authorized under the given scope.
 * Reference: mcp-server/src/list-tasks-gate.ts (PR #654, commit 00b95f0)
 */
function canListByIdentity(scope: OAuthContext, presentedIdentity: string): boolean {
  if (isMasterScope(scope)) return true;
  const allowList = scope.fromAllowList ?? [];
  if (allowList.length === 0) {
    // Legacy fallback: no explicit list configured — compare against userId only.
    return presentedIdentity === scope.userId;
  }
  // Case-insensitive match to handle Zoé / zoe / ZOE variants.
  return allowList.some(allowed => allowed.toLowerCase() === presentedIdentity.toLowerCase());
}
```

Reference implementation: `mcp-server/src/list-tasks-gate.ts` (PR #654, commit `00b95f0`). Identical pattern in `check_messages` (commit `24b39c5`). Phase C0 will mirror this for `list_messages`, `list_missions`, `list_briefing_notes`, `list_peers`.

**FR — Pour un bearer non-master, les outils de filtre d'identité DOIVENT contrôler la requête via `fromAllowList`, et non via `scope_profile.name`.**

L'implémentation de référence est `mcp-server/src/list-tasks-gate.ts` (PR #654, commit `00b95f0`). Le pattern identique existe dans `check_messages` (commit `24b39c5`). La phase C0 reproduira ce pattern pour `list_messages`, `list_missions`, `list_briefing_notes`, `list_peers`.

---

### §4.3 Namespace-filter tools — `namespace*Prefixes` semantic

**EN — For a non-master bearer, namespace-scoped tools MUST filter against the relevant prefix list, not against `scope_profile.name`.**

```typescript
/**
 * Returns true when the requested namespace falls within the scope's read prefixes.
 */
function canReadNamespace(scope: OAuthContext, namespace: string): boolean {
  if (isMasterScope(scope)) return true;
  const prefixes = scope.namespaceReadPrefixes ?? [];
  // Exact match OR the namespace is nested under a configured prefix.
  return prefixes.some(p => namespace === p || namespace.startsWith(p + "/"));
}

/**
 * Returns true when the requested namespace falls within the scope's write prefixes.
 */
function canWriteNamespace(scope: OAuthContext, namespace: string): boolean {
  if (isMasterScope(scope)) return true;
  const prefixes = scope.namespaceWritePrefixes ?? [];
  return prefixes.some(p => namespace === p || namespace.startsWith(p + "/"));
}
```

**FR — Pour un bearer non-master, les outils filtrés par namespace DOIVENT filtrer contre la liste de préfixes appropriée, et non contre `scope_profile.name`.**

Correspondance exacte ou hiérarchique : `project/acme-hr/sub` passe si le préfixe `project/acme-hr` est configuré.

### §4.3.1 Built-in scope profiles — `team-member` (B4, 2026-06-20)

**EN — `team-member` is the built-in scope profile issued to Clerk JWT callers that carry an `org_id` claim.**

| Field | Value |
|---|---|
| `scopeProfile` | `"team-member"` |
| `namespaceReadPrefixes` | `["team/<orgId>"]` |
| `namespaceWritePrefixes` | `["team/<orgId>"]` |
| `fromAllowList` | `[]` (no identity filter — team members write under their own userId) |
| `isMaster` | `false` |

Layer 2.5 in `bearerAuthMiddleware` verifies the Clerk JWT against the JWKS at `CLERK_DOMAIN/.well-known/jwks.json` (10-min in-process cache) and populates the above context. The Convex layer enforces the same boundary via `memoriesScoped.ts` (`assertNamespaceAllowed`). Cross-tenant reads and writes emit `AUTH_NAMESPACE_DENIED`. Unregistered or inactive orgs are also fail-closed with `AUTH_NAMESPACE_DENIED`.

---

### §4.4 Anti-patterns — REGRESSIONS TO AVOID

**EN — The following patterns have caused production incidents. Do not reintroduce them.**

| Code | Anti-pattern | Regression | Fix |
|---|---|---|---|
| A1 | `presentedIdentity === scope_profile.name` | PR #625 commit `28db616` — `list_tasks` blocked Zoé on `zoe-acme-hr` | PR #654 commit `00b95f0` — `list-tasks-gate.ts` uses `fromAllowList` |
| A2 | Case-sensitive identity match | Blocks `Zoe` when `zoe` is in `fromAllowList` | Always use `.toLowerCase()` on both sides |
| A3 | NFC normalization absent at write time | `Zoé` (NFC composed) vs `Zoé` (NFD decomposed) mismatch | Normalize to NFC at insert time and at compare time |
| A4 | `masterOnlyMiddleware` bypass missing | Master-only tools accidentally accessible to tenant bearers | Every admin-surface tool must pass through `guardMasterOnly` |
| A5 | No auth check on write tools | 14 P0 tools identified in A1 matrix (Day 92) with zero-auth write surface | Phase C0 sub-batch will add `guardFrom` / `guardWrite` gates |

**FR — Les patterns suivants ont causé des incidents de production. Ne pas les réintroduire.**

| Code | Anti-pattern | Régression | Correctif |
|---|---|---|---|
| A1 | `presentedIdentity === scope_profile.name` | PR #625 commit `28db616` — `list_tasks` bloquait Zoé sur `zoe-acme-hr` | PR #654 commit `00b95f0` — `list-tasks-gate.ts` utilise `fromAllowList` |
| A2 | Comparaison d'identité sensible à la casse | Bloque `Zoe` quand `zoe` est dans `fromAllowList` | Toujours utiliser `.toLowerCase()` des deux côtés |
| A3 | Normalisation NFC absente à l'écriture | `Zoé` (NFC composé) vs `Zoé` (NFD décomposé) ne correspondent pas | Normaliser en NFC à l'insertion et à la comparaison |
| A4 | Absence du bypass `masterOnlyMiddleware` | Outils master-only accessibles aux bearers tenant | Chaque outil admin doit passer par `guardMasterOnly` |
| A5 | Outils d'écriture sans vérification auth | 14 outils P0 identifiés dans la matrice A1 (Day 92) sans auth sur surface d'écriture | Le sous-batch Phase C0 ajoutera les verrous `guardFrom` / `guardWrite` |

---

### §4.5 Tool-by-tool reference table

**EN — All 85+ Cloud MCP tools categorized by filter type. Source of truth: `docs/test-reports/day92-vp-mcp-audit-matrix.md` (PR #661).**

#### Identity-filter tools (gate via `fromAllowList[]`)

| Tool | Status | Notes |
|---|---|---|
| `list_tasks` | **Fixed** PR #654 commit `00b95f0` | `list-tasks-gate.ts` — reference implementation |
| `check_messages` | **Fixed** commit `24b39c5` | Mirrors `list-tasks-gate` pattern |
| `send_message` | **Fixed** Day 92 | `guardFrom` check wired |
| `create_task` | **Pending C0** | `guardFrom` not yet enforced |
| `list_messages` | **Pending C0** | `from` / `recipient` filter regression (commit `28db616`) |
| `list_missions` | **Pending C0** | `pilot` filter regression (commit `28db616`) |
| `list_briefing_notes` | **Pending C0** | `fromAllowList` gate TBD |
| `list_peers` | **Pending C0** | `fromAllowList` gate TBD |

#### Namespace-filter tools (gate via `namespace*Prefixes[]`)

| Tool | Status | Notes |
|---|---|---|
| `list_memories` | Fixed — Wave A PR #624 `251d183` | `namespaceReadPrefixes` enforced |
| `recall` | Fixed — Wave A PR #624 `251d183` | `namespaceReadPrefixes` enforced |
| `get_memory` | Fixed — Wave A PR #624 `251d183` | `namespaceReadPrefixes` enforced |
| `store_memory` | Fixed | `namespaceWritePrefixes` enforced |

#### Master-only tools (gate via `guardMasterOnly`)

`revokeAccessTokensOnly`, `patchScopeProfileEmergency`, `PATCH /admin/scope-profiles/:id`, and all `/admin/*` surface tools. See §2.

**FR — Tous les outils Cloud MCP catégorisés par type de filtre. Source de vérité : `docs/test-reports/day92-vp-mcp-audit-matrix.md` (PR #661).**

#### Outils à filtre d'identité (verrou via `fromAllowList[]`)

`list_tasks` (corrigé PR #654), `check_messages` (corrigé commit `24b39c5`), `send_message` (corrigé Day 92). En attente C0 : `create_task`, `list_messages`, `list_missions`, `list_briefing_notes`, `list_peers`.

#### Outils à filtre de namespace (verrou via `namespace*Prefixes[]`)

`list_memories`, `recall`, `get_memory` (corrigés Wave A PR #624). `store_memory` (corrigé).

#### Outils master-only

`revokeAccessTokensOnly`, `patchScopeProfileEmergency`, et toute la surface `/admin/*`. Voir §2.

---

### §4.6 Concrete example — tenant Alice Acme HR / Zoé

**EN — This example anchors the Day 92 live regression (visio blocked) and its resolution.**

Tenant scope_profile `zoe-acme-hr`:

```json
{
  "name": "zoe-acme-hr",
  "fromAllowList": ["Zoé", "Zoe", "zoe", "zoé", "Milo", "milo", "Victor", "victor"],
  "namespaceReadPrefixes": [
    "orchestrator/Zoé", "orchestrator/Zoe",
    "orchestrator/Milo", "orchestrator/milo",
    "orchestrator/Victor", "project/acme-hr"
  ],
  "namespaceWritePrefixes": [
    "orchestrator/Zoé", "orchestrator/Zoe",
    "project/acme-hr"
  ]
}
```

**Correct flow (post PR #654):**

- Zoé bearer calls `list_tasks assignedTo=Zoe`
  → `canListByIdentity`: `"Zoe"` ∈ `fromAllowList` (case-insensitive) → **PASS**

- Zoé bearer calls `list_tasks assignedTo=zoe-acme-hr`
  → `canListByIdentity`: `"zoe-acme-hr"` ∉ `fromAllowList` → **FORBIDDEN** (correct)
  *(This is the regression introduced by PR #625 commit `28db616`: the filter was matching against `scope_profile.name` instead of `fromAllowList`.)*

- Zoé bearer calls `list_memories namespace=project/acme-hr`
  → `canReadNamespace`: `"project/acme-hr"` exact-matches prefix `"project/acme-hr"` → **PASS**

- Zoé bearer calls `list_memories namespace=project/other-tenant`
  → `canReadNamespace`: no prefix matches → **FORBIDDEN** (correct)

**FR — Cet exemple ancre la régression de production Day 92 (visio bloquée) et sa résolution.**

Tenant scope_profile `zoe-acme-hr` (voir JSON ci-dessus).

Flux correct (après PR #654) :
- Zoé appelle `list_tasks assignedTo=Zoe` → `canListByIdentity` : `"Zoe"` ∈ `fromAllowList` (insensible à la casse) → **PASS**.
- Zoé appelle `list_tasks assignedTo=zoe-acme-hr` → `"zoe-acme-hr"` ∉ `fromAllowList` → **FORBIDDEN** (correct). C'est exactement la régression du commit `28db616` : le filtre comparait avec `scope_profile.name` au lieu de `fromAllowList`.
- Zoé appelle `list_memories namespace=project/acme-hr` → correspondance exacte du préfixe → **PASS**.
- Zoé appelle `list_memories namespace=project/other-tenant` → aucun préfixe ne correspond → **FORBIDDEN** (correct).

---

### §4.7 Wave history

**EN — Shipped waves and pending phases.**

| Wave | PR | Commit | Tools covered | Status |
|---|---|---|---|---|
| Wave A | PR #624 | `251d183` | `list_memories`, `get_memory` | Shipped |
| Wave B | PR #625 | `28db616` | `list_briefing_notes`, `list_messages`, `list_peers` — namespace filter only; identity filter regressed | Shipped with regression |
| list_tasks gate | PR #654 | `00b95f0` | `list_tasks` identity filter (`fromAllowList`) | Shipped — fixes Wave B regression |
| check_messages gate | inline | `24b39c5` | `check_messages` identity filter | Shipped |
| Phase C0 | pending | — | `list_messages.from`, `list_missions.pilot`, `list_briefing_notes`, `list_peers`, `create_task` identity gates | Pending |

Day 92 Laurent doctrine (verbatim): *"on le fait pour un MCP d'abord, ensuite on reproduit sur l'autre, pour être cohérent et même standard"* — this document is the canonical spec Athena replicates on vCRM.

**FR — Vagues livrées et phases en attente.**

| Vague | PR | Commit | Outils couverts | Statut |
|---|---|---|---|---|
| Wave A | PR #624 | `251d183` | `list_memories`, `get_memory` | Livré |
| Wave B | PR #625 | `28db616` | `list_briefing_notes`, `list_messages`, `list_peers` — filtre namespace uniquement ; filtre identité régressé | Livré avec régression |
| list_tasks gate | PR #654 | `00b95f0` | `list_tasks` filtre identité (`fromAllowList`) | Livré — corrige la régression Wave B |
| check_messages gate | inline | `24b39c5` | `check_messages` filtre identité | Livré |
| Phase C0 | en attente | — | `list_messages.from`, `list_missions.pilot`, `list_briefing_notes`, `list_peers`, `create_task` verrous identité | En attente |

Doctrine Day 92 Laurent (verbatim) : *"on le fait pour un MCP d'abord, ensuite on reproduit sur l'autre, pour être cohérent et même standard"* — ce document est la spécification canonique qu'Athena reproduit sur vCRM.

> Available in vantage-peers-mcp v2.5.0+ (Day 92 mission k57a36y8w5t085bqr23dsmvb2d882506). The `fromAllowList` + case-insensitive matching + NFC normalization described in this section are enforced as of v2.5.0.

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

## 7. Convex-layer authorization — `withOrgScope` fail-closed step (Day 128)

**Status: a STEP, not the completion of the multi-tenant model.** The full multi-tenant contract — each tenant reads/writes strictly its own data, everywhere — is the product direction reaffirmed by Laurent and is tracked/realigned separately by Pi. This section documents one closed gap: `withOrgScope`'s fail-open default and four unscoped client-facing handlers. It does not claim the overall model is finished.

### 7.1 What changed

- **`convex/lib/auth.ts` — `withOrgScope(ctx, opts?)`.** Previously, when no Clerk identity was present on the request, `withOrgScope` unconditionally resolved to `isMaster=true, allowedOrchestrators=["*"]` — a fail-open default. It now defaults to **fail-closed**: no identity + no explicit opt-in → `{ isMaster: false, allowedOrchestrators: [], scopes: [] }`.
- **Opt-in preserved for legitimate internal call sites.** A new `WithOrgScopeOptions.allowNoIdentityMaster` flag lets call sites that are known-legitimate internal/back-compat surfaces explicitly request the old master behavior. Convex exposes no reliable signal to distinguish an MCP-server call made without a JWT from an anonymous caller, so this is a deliberate per-call-site marker rather than a blanket default. The 10 existing internal call sites that pass it: `convex/tasks.ts`, `convex/missions.ts`, `convex/dashboard.ts`, `convex/stats.ts`, `convex/briefingNotes.ts`, internal `convex/messages.ts` paths, and `convex/memories.ts`.
- **Client-facing handlers scoped.** `convex/memories.ts` (`listMemories`, `getMemory`), `convex/messages.ts` (`listByChannel`), `convex/diary.ts` (`list`) now call `withOrgScope` / `filterByOrgScope` before returning data. An org-A-scoped caller no longer receives org-B's rows from these handlers.
- **MCP layer — legacy bearer path (4) closed.** `mcp-server/src/auth.ts`, path (4) (`mcpTenants` table lookup) previously left `oauthContext` **unset**, which made every guard in `tools.ts` (`guardRead`/`guardWrite`/`guardMasterOnly`) and every `checkNamespaceRead`/`checkNamespaceWrite`/`checkFromAllowed` predicate treat the request as unscoped/allowed — a legacy bearer could read/write any namespace. Path (4) now sets a deny-by-default `oauthContext` (`scopeProfile: "legacy-tenant-generic"`, empty `fromAllowList`/`namespaceReadPrefixes`/`namespaceWritePrefixes`, `isMaster: false`). The `mcpTenants` table carries no per-tenant scope config, so empty/deny-by-default is the only defensible default until a tenant is re-provisioned through the OAuth scoped-token path (layer 2) with explicit prefixes.

### 7.2 Auth surfaces at a glance

| Layer | Surface | Client-facing (Clerk identity) | Internal/fleet (no identity) |
|---|---|---|---|
| Convex | `withOrgScope(ctx)` | Resolves org from Clerk identity → org mapping lookup → scoped `OrgScope` | Fail-closed by default. `allowNoIdentityMaster: true` opt-in preserves master for the 10 audited internal call sites. |
| MCP HTTP | `bearerAuthMiddleware` paths (1) master token, (2) OAuth scoped token, (2.5) Clerk JWT (`team-member` profile), (3) DCR token (`client-generic`), (4) legacy `mcpTenants` bearer | Paths (2), (2.5), (3) resolve a scoped `oauthContext` | Path (1) is the only route to `isMaster: true`; path (4) now resolves deny-by-default (`legacy-tenant-generic`) instead of leaving `oauthContext` unset |
| MCP tool guards | `checkNamespaceRead`/`checkNamespaceWrite`/`checkFromAllowed` in `mcp-server/src/auth.ts`, consumed by `guardRead`/`guardWrite`/`guardMasterOnly` in `mcp-server/src/tools.ts` | Enforce `namespaceReadPrefixes`/`namespaceWritePrefixes`/`fromAllowList` from `oauthContext` | No-op only if `oauthContext` is `undefined` (direct unit-test predicate calls) — every real auth path (1)-(4) now sets a context |

### 7.3 Test evidence

`convex/__tests__/multiTenantIsolation.test.ts` — 5 isolation tests: `withOrgScope` no-identity fail-closed unit test, plus cross-tenant read denial for `memories.listMemories`, `memories.getMemory`, `messages.listByChannel`, `diary.list`. Full suite at time of this fix: **2384 passed / 12 skipped, exit 0**.

### 7.4 Open follow-ups — NOT resolved by this step

- **(a) Residual weak point.** A non-MCP anonymous call site that explicitly passes `allowNoIdentityMaster: true` still resolves to master. This opt-in is only as safe as the audit of its call sites; it is not re-verified automatically on new call sites.
- **(b) Legacy tenant e2e test regression.** The legacy-tenant (path 4) e2e test now falls under an empty scope by design (deny-by-default) and needs to be re-provisioned through the OAuth scoped-token path with explicit `namespaceReadPrefixes`/`namespaceWritePrefixes` before it will pass again.
- **(c) `global` prefix in Alice's OAuth profile — undecided.** Whether a `global` namespace prefix belongs in Alice's scope profile is **not settled**. TODO: confirm intent with Laurent before assuming any behavior for this prefix.
- **(d) No real-network e2e.** Isolation above is proven at the Convex-test-harness level (`convex-test` + `t.withIdentity(...)`). No end-to-end test against a live Clerk JWT / real deployment has been run — there is no test Clerk JWT infrastructure available yet.

### 7.5 Provenance

- Task: `k1759yh6mjqcgwq7am85acvqh18abbjd`.
- Files: `convex/lib/auth.ts`, `convex/memories.ts`, `convex/messages.ts`, `convex/diary.ts`, `convex/tasks.ts`, `convex/missions.ts`, `convex/dashboard.ts`, `convex/stats.ts`, `convex/briefingNotes.ts`, `mcp-server/src/auth.ts`, `convex/__tests__/multiTenantIsolation.test.ts`.
- Analysis plan: `analysis/multi-tenant-fail-closed-plan-day128.md`.

---

## 6. References

- PR #621 — D6 + D7 hardening at `/token` and `/authorize`.
- PR #622 — `patchScopeProfileEmergency` + `oauth_audit_log`.
- PR #623 — D9 full cascade-update across `oauth_clients`.
- PR #624 — S3.1 scope-aware filter Wave A (`251d183`).
- PR #625 — S3.1 scope-aware filter Wave B (`28db616`) — Wave B regression introduced here.
- PR #654 — `list-tasks-gate.ts` `fromAllowList` fix (`00b95f0`) — fixes Wave B identity-filter regression.
- PR #661 — Day 92 A0+A1+A2+A3 stacked review — A1 audit matrix source of truth.
- `mcp-server/src/list-tasks-gate.ts` — canonical `fromAllowList` gate reference implementation.
- Test reports: `docs/test-reports/s1.5-oauth-d6-d7-2026-06-03.md`, `docs/test-reports/s1.2-mutation-2026-06-03.md`, `docs/test-reports/s2.1-d9-cascade-clients-2026-06-03.md`, `docs/test-reports/s3.1.a-scope-aware-filter-wave-a-2026-06-03.md`, `docs/test-reports/s3.1.b-scope-aware-filter-wave-b-2026-06-03.md`, `docs/test-reports/day92-vp-mcp-audit-matrix.md`.
