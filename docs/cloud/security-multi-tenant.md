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
| `scope_profile.name` | `string` (opaque identifier) | Uniquely identifies a scope-profile record in the catalog. Human-readable slug (`helios-<client-org>`, `alpha-test-trio`). | Orchestrator ID, namespace prefix, identity filter value |
| `scope_profile.fromAllowList[]` | `string[]` | Speak-as identities: `createdBy`, `from`, `callerOrchestrator`, and `recipient` when the caller claims to be that identity. Also the **list/read** filter for `list_tasks assignedTo=` / `createdBy=` (who this client may *query*). | Namespace filter, profile name comparison, **create/update `assignedTo` (delegation)** |
| Org roster (`client_org_mapping.allowedOrchestrators`, derived from the access token's `clerkOrgSlug` or a Clerk JWT — never from an org argument) | `string[]` (data) | Delegation: `assignedTo` on `create_task` / `update_task` / `create_recurring_task` / `update_recurring_task`. Membership is read from that mapping row. | Speak-as; the MCP service-account `["*"]` roster |
| `scope_profile.namespaceReadPrefixes[]` | `string[]` | Prefix list for namespace-scoped **READ** operations (`list_memories`, `recall`, `get_memory`). | Identity filter, write gate |
| `scope_profile.namespaceWritePrefixes[]` | `string[]` | Prefix list for namespace-scoped **WRITE** operations (`store_memory`). | Identity filter, read gate |

`fromAllowList` is **not** the exhaustive list of IDs authorized as create/update `assignedTo`. Applying `checkFromAllowed` / `guardFrom` to the assignee was the 2026-08-21 defect (a station could only assign to itself). Operator ruling: any member of an organisation may delegate to any member of the same organisation.

**FR — Trois champs dans un document `scope_profile` ont des rôles entièrement distincts. Les confondre provoque des régressions de sécurité.**

| Concept | Type | Rôle | Ne jamais utiliser comme |
|---|---|---|---|
| `scope_profile.name` | `string` (identifiant opaque) | Identifie de manière unique un enregistrement scope-profile dans le catalogue. Slug lisible (`helios-<client-org>`, `alpha-test-trio`). | ID d'orchestrateur, préfixe de namespace, valeur de filtre d'identité |
| `scope_profile.fromAllowList[]` | `string[]` | Identités speak-as : `createdBy`, `from`, `callerOrchestrator`, et `recipient` quand l'appelant prétend être cette identité. Aussi le filtre **lecture** de `list_tasks assignedTo=` / `createdBy=` (qui ce client peut *interroger*). | Filtre de namespace, comparaison de nom de profil, **`assignedTo` à la création/mise à jour (délégation)** |
| Roster d'org (`client_org_mapping.allowedOrchestrators`, dérivé du `clerkOrgSlug` du jeton ou d'un JWT Clerk — jamais d'un argument d'organisation) | `string[]` (données) | Délégation : `assignedTo` sur `create_task` / `update_task` / `create_recurring_task` / `update_recurring_task`. L'appartenance se lit sur cette row. | Speak-as ; le roster `["*"]` du service-account MCP |
| `scope_profile.namespaceReadPrefixes[]` | `string[]` | Liste de préfixes pour les opérations de **LECTURE** par namespace (`list_memories`, `recall`, `get_memory`). | Filtre d'identité, verrou d'écriture |
| `scope_profile.namespaceWritePrefixes[]` | `string[]` | Liste de préfixes pour les opérations d'**ÉCRITURE** par namespace (`store_memory`). | Filtre d'identité, verrou de lecture |

`fromAllowList` n'est **pas** la liste exhaustive des IDs autorisés comme `assignedTo` à l'écriture. Appliquer `checkFromAllowed` / `guardFrom` à l'assigné était le défaut du 2026-08-21 (une station ne pouvait assigner qu'à elle-même). Ruling : tout membre d'une organisation peut déléguer à tout membre de la même organisation.

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
  // Case-insensitive match to handle Hélios / helios / HELIOS variants.
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

Correspondance exacte ou hiérarchique : `project/<client-org>/sub` passe si le préfixe `project/<client-org>` est configuré.

### §4.3.1 Built-in scope profiles — `team-member` (B4, 2026-06-20)

**EN — `team-member` is the built-in scope profile issued to Clerk JWT callers that carry an `org_id` claim.**

| Field | Value |
|---|---|
| `scopeProfile` | `"team-member"` |
| `namespaceReadPrefixes` | `["team/<orgId>", "project/<orgId>"]` (project/<orgId> is the org agents' shared memory, read-only for people) |
| `namespaceWritePrefixes` | `["team/<orgId>"]` |
| `fromAllowList` | `[]` (no identity filter — team members write under their own userId) |
| `isMaster` | `false` |

Layer 2.5 in `bearerAuthMiddleware` verifies the Clerk JWT against the JWKS at `CLERK_DOMAIN/.well-known/jwks.json` (10-min in-process cache) and populates the above context. The Convex layer enforces the same boundary via `memoriesScoped.ts` (`assertNamespaceAllowed`). Cross-tenant reads and writes emit `AUTH_NAMESPACE_DENIED`. Unregistered or inactive orgs are also fail-closed with `AUTH_NAMESPACE_DENIED`.

---

### §4.4 Anti-patterns — REGRESSIONS TO AVOID

**EN — The following patterns have caused production incidents. Do not reintroduce them.**

| Code | Anti-pattern | Regression | Fix |
|---|---|---|---|
| A1 | `presentedIdentity === scope_profile.name` | PR #625 commit `28db616` — `list_tasks` blocked Hélios on `helios-<client-org>` | PR #654 commit `00b95f0` — `list-tasks-gate.ts` uses `fromAllowList` |
| A2 | Case-sensitive identity match | Blocks `Helios` when `helios` is in `fromAllowList` | Always use `.toLowerCase()` on both sides |
| A3 | NFC normalization absent at write time | `Hélios` (NFC composed) vs `Hélios` (NFD decomposed) mismatch | Normalize to NFC at insert time and at compare time |
| A4 | `masterOnlyMiddleware` bypass missing | Master-only tools accidentally accessible to tenant bearers | Every admin-surface tool must pass through `guardMasterOnly` |
| A5 | No auth check on write tools | 14 P0 tools identified in A1 matrix (Day 92) with zero-auth write surface | Phase C0 sub-batch will add `guardFrom` / `guardWrite` gates |

**FR — Les patterns suivants ont causé des incidents de production. Ne pas les réintroduire.**

| Code | Anti-pattern | Régression | Correctif |
|---|---|---|---|
| A1 | `presentedIdentity === scope_profile.name` | PR #625 commit `28db616` — `list_tasks` bloquait Hélios sur `helios-<client-org>` | PR #654 commit `00b95f0` — `list-tasks-gate.ts` utilise `fromAllowList` |
| A2 | Comparaison d'identité sensible à la casse | Bloque `Helios` quand `helios` est dans `fromAllowList` | Toujours utiliser `.toLowerCase()` des deux côtés |
| A3 | Normalisation NFC absente à l'écriture | `Hélios` (NFC composé) vs `Hélios` (NFD décomposé) ne correspondent pas | Normaliser en NFC à l'insertion et à la comparaison |
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

### §4.6 Concrete example — tenant Nadia <client-org> / Hélios

**EN — This example anchors the Day 92 live regression (visio blocked) and its resolution.**

Tenant scope_profile `helios-<client-org>`:

```json
{
  "name": "helios-<client-org>",
  "fromAllowList": ["Hélios", "Helios", "helios", "hélios", "Clio", "clio", "Victor", "victor"],
  "namespaceReadPrefixes": [
    "orchestrator/Hélios", "orchestrator/Helios",
    "orchestrator/Clio", "orchestrator/clio",
    "orchestrator/Victor", "project/<client-org>"
  ],
  "namespaceWritePrefixes": [
    "orchestrator/Hélios", "orchestrator/Helios",
    "project/<client-org>"
  ]
}
```

**Correct flow (post PR #654):**

- Hélios bearer calls `list_tasks assignedTo=Helios`
  → `canListByIdentity`: `"Helios"` ∈ `fromAllowList` (case-insensitive) → **PASS**

- Hélios bearer calls `list_tasks assignedTo=helios-<client-org>`
  → `canListByIdentity`: `"helios-<client-org>"` ∉ `fromAllowList` → **FORBIDDEN** (correct)
  *(This is the regression introduced by PR #625 commit `28db616`: the filter was matching against `scope_profile.name` instead of `fromAllowList`.)*

- Hélios bearer calls `list_memories namespace=project/<client-org>`
  → `canReadNamespace`: `"project/<client-org>"` exact-matches prefix `"project/<client-org>"` → **PASS**

- Hélios bearer calls `list_memories namespace=project/other-tenant`
  → `canReadNamespace`: no prefix matches → **FORBIDDEN** (correct)

**FR — Cet exemple ancre la régression de production Day 92 (visio bloquée) et sa résolution.**

Tenant scope_profile `helios-<client-org>` (voir JSON ci-dessus).

Flux correct (après PR #654) :
- Hélios appelle `list_tasks assignedTo=Helios` → `canListByIdentity` : `"Helios"` ∈ `fromAllowList` (insensible à la casse) → **PASS**.
- Hélios appelle `list_tasks assignedTo=helios-<client-org>` → `"helios-<client-org>"` ∉ `fromAllowList` → **FORBIDDEN** (correct). C'est exactement la régression du commit `28db616` : le filtre comparait avec `scope_profile.name` au lieu de `fromAllowList`.
- Hélios appelle `list_memories namespace=project/<client-org>` → correspondance exacte du préfixe → **PASS**.
- Hélios appelle `list_memories namespace=project/other-tenant` → aucun préfixe ne correspond → **FORBIDDEN** (correct).

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

### §4.8 The acting agent comes from a credential, never from a typed name (VantagePeers Cloud)

An org-level bearer (Clerk JWT or OAuth access token) authenticates the ORGANISATION. The AGENT inside it is authenticated by a second credential, presented in the `x-vantage-agent-credential` header (the plaintext returned once by `agentCredentials:mintAgentCredential`, org:admin only).

- The MCP boundary (`bearerAuthMiddleware`) resolves the agent once, via `agentCredentials:resolveAgentCredential`, and binds its org to the verified principal's org. Unresolvable / rotated-out / inactive credential, lookup failure, empty header, org mismatch: refused (401/403).
- Every acting-name argument (`callerOrchestrator`, and the `from`-kind argument such as `createdBy`/`from`/`orchestratorId`) is a CLAIM the resolved agent verifies: another agent's name is `AGENT_IDENTITY_MISMATCH`; an omitted name is derived from the agent; an org-only caller naming an agent is refused `AGENT_CREDENTIAL_REQUIRED` under `strict` (the default) unless it is a single-name seat naming itself (see below), and is served and RECORDED as unattributed only when the switch is set to `permissive` explicitly. The roster (`fromAllowList`) still applies as a narrowing intersect.
- With a resolved agent, task reads apply the tenant predicate `row.orgId === agent.orgSlug` on BOTH the by-id read (`get_task`) and the collection reads (`list_tasks`, `search_tasks_by_keyword`, `list_tasks_by_mission`); an unstamped row is denied.
- The master bearer and the local stdio context are all-authority identities, not agents, and are unchanged.
- **Strict is the default.** The switch is the environment variable `VANTAGE_ACTOR_CREDENTIAL_MODE`, read in one place. Absent or empty means `strict` (`/health` shows `actor_credential: { mode: "strict", source: "unset" }` or `"empty"`); any unrecognised value is also `strict`. An operator who must keep uncredentialed callers working during a migration opts into the compatibility path by setting `VANTAGE_ACTOR_CREDENTIAL_MODE=permissive` on the MCP service (`/health` then shows `source: "configured"`). Under `strict` there is ONE exemption: a seat token acting as itself. When the OAuth token row's `fromAllowList` holds exactly one name, that name is not `"*"`, the row carries no `principal` (a person token never qualifies), and the call names that same agent, it is served without `x-vantage-agent-credential`. The exemption is read from the token row, never from a tool argument; a multi-name bearer, a seat naming another agent, a person token and a Clerk-JWT session still need the credential. A `["*"]` allowlist never counts as single-name (it is master scope, served on the master branch as before). `/health` `unattributed_claims.strict_would_refuse` counts only calls strict would refuse under this rule, so a seat naming itself is not counted. For a person token (signed in through `/authorize`), the writer-role gate runs first, then this check: a viewer's write is refused `role-not-writer`; an editor or admin naming an org agent must present that agent's credential; reads that name no agent are served; a write on a tool whose acting name is required cannot omit it (the roster check refuses `from='undefined'`). A presented credential is authoritative in both modes. Before flipping to `strict`, run `bun mcp-server/scripts/verify-actor-credentials.ts` with `VANTAGE_MCP_URL`, `VANTAGE_ORG_BEARER` (an ordinary org bearer, never master) and `VANTAGE_AGENT_CREDENTIALS_FILE` (JSON of exact server identifier -> credential). Exit 0 = every actor derived from `list_peers` resolved and operated under its credential; exit 1 = at least one actor failed; exit 2 = the script could not read its subject (nothing is certified). Filing a credential under a retyped spelling of an identifier (for example an unaccented form of an accented one) provisions nothing, and the script reports it as such.

Both-pole tests: `mcp-server/test/actor-from-credential.test.ts`, `convex/__tests__/agentCredentialInactiveAgent.test.ts`.

---

### §4.9 Direct messages are bounded to the caller's own organisation (VantagePeers Cloud)

Measured on prod 2026-10-06: a client-org seat sent a direct message to a fleet orchestrator and it was delivered, because the direct-channel branch of `sendMessage` resolved recipients from every profile. It is now enforced in Convex (`convex/messages.ts`, `sendMessageCore`), so no transport can bypass it.

- A client-scoped caller may address only (a) orchestrators on its own `client_org_mapping.allowedOrchestrators` roster, by role or by one of their instances, and (b) the fleet coordinators on its explicit allow-list (§4.11: stored by agent ID, addressed by ID only). A `["*"]` roster or allow-list names nobody.
- The allow-list is empty by default, is never inferred, and is written only by the internal mutation `clientOrgMapping:setAddressableFleetCoordinators`, which since module M1 (§4.11) takes agent IDs (`agentIds`), accepts only active agents of the operator org and returns `{previous, current}` as ID lists. Example (operator command, run after deploy): `npx convex run clientOrgMapping:setAddressableFleetCoordinators '{"clerkOrgSlug":"iris-rh","agentIds":["<agents id of the operator pi>"]}'`.
- A comma list with one out-of-scope part is refused as a whole with the existing `recipient error / message non livré` bounce; no message or receipt is written.
- The internal master (service account, `isMaster && orgSlug === null`) keeps fleet-wide reach. Broadcast is unchanged (own roster only).
- **The scope also applies on the MCP service-account path.** An MCP seat reaches Convex as the service account (fleet master, no org), so the rules above did not reach it: measured on prod 2026-10-06, `send_message {from:"neo", channel:"sigma"}` from a `cgt-alsachimie` seat was delivered, with and without the agent credential header. `send_message` now forwards the seat's verified org as `seatOrgSlug`. The MCP reads it from the resolved principal (the token row's `clerkOrgSlug`, or the credential-bound actor's org; `resolveSeatOrg` in `mcp-server/src/auth.ts`), never from a tool argument; a seat with no resolvable org, or whose two verified sources disagree, is refused in the MCP with nothing sent. `messages:sendMessage` believes `seatOrgSlug` from the service account only (any other caller is refused `RBAC_DENIED`, reason `seat-org-not-trusted`), requires it to name an ACTIVE `client_org_mapping` row (else `seat-org-not-active`, fail closed), refuses a `tenantId` that names a different org, and then applies the same recipient scope for that org: its roster plus `addressableFleetCoordinators`, through the same `recipient error` bounce (mixed lists refused whole, nothing written). A seat's `broadcast` reaches only its own roster. Calls with no `seatOrgSlug` (the fleet master's own sends, sigma or pi through their tokens) keep fleet reach; Clerk-JWT sessions are scoped by their own JWT as before.
- Tests: `convex/__tests__/directMessageOrgScoped.test.ts`, `convex/__tests__/directMessageFleetCoordinators.test.ts`, `convex/messages.seatScope.test.ts`, `mcp-server/test/send-message-seat-org.test.ts`.

### §4.10 A recipient agent is addressed by its ID, never by its name (VantagePeers Cloud)

Client incident Iris RH (task k1716f01f9g1a0scz7nj30118h8fx32c). Two organisations may each hold an agent with the same display name (an Iris RH "hélios" and another org's "hélios"); a name typed without its accent did not reach the agent, and a name is not an identity. Operator decision 2026-10-08: a recipient is resolved by its agent ID, with no accent folding and no name tolerance.

- **Where the ID comes from.** `list_peers`, for a token that carries an organisation, returns each roster agent with `agentId`: the `agents` row `_id`. Convex attaches it (`orgRoster:getAgentDirectoryForAccessToken` for a seat token, `orgRoster:getMyAgentDirectory` for a Clerk session), from the caller's own organisation only, by an exact read of `agents.by_org_normalized_name` (NFC, lowercase, trim; no accent fold). A roster name with no active agent row is listed with `agentId: null` and cannot be addressed by ID. The MCP never turns a name into an ID.
- **How it is used.** `send_message` takes `recipientAgentIds` (1 to 50 IDs) instead of `channel`; exactly one of the two is accepted (`INVALID_RECIPIENTS` otherwise, before anything is sent). `messages:sendMessage` narrows each ID with `requireId` (a name, a malformed string or an ID of another table is a typed validation error naming `recipientAgentIds`), reads the row by ID, and admits it only if it is active, belongs to the organisation the message is written in, and, for a client-scoped sender, is on that organisation's roster. Every other outcome (deleted, inactive, another organisation's agent, off the roster) is the same refusal, `RBAC_DENIED` reason `recipient-agent-not-addressable`, so the refusal does not reveal whether an ID exists elsewhere. One refused ID refuses the whole send; nothing is written.
- **What the recipient sees.** The receipt is stored with `recipientId` = the agent ID, `recipient` = its normalised label and the message's tenant, so the recipient's `check_messages` reads it exactly as before.
- **Reach is never wider than the name path.** By ID, a client-scoped sender reaches only its own organisation's roster agents and the operator agents its mapping stores as coordinators (§4.11): no instance, no person. The fleet master reaches operator-organisation agents, or the agents of the tenant it names.
- **The name boundary.** `channel` keeps routing by name, exact under NFC + lowercase and nothing looser, for what an agent ID does not name: `broadcast`, fleet orchestrator roles and their instances, the coordinators a client organisation lists, and a person (`user:<subject>`). Moving fleet roles and client callers to IDs only is a separate, traced change.
- Tests: `convex/__tests__/recipientByAgentId.test.ts`, `mcp-server/test/send-message-recipient-agent-ids.test.ts`, `mcp-server/src/__tests__/list-peers-org-roster.test.ts`.

### §4.11 Rosters are stored as agent IDs and judged by `assertPrincipalListed` (VantagePeers Cloud, module M1)

Identity is the `agents` row `_id`, never a name. A roster of names let a same-named agent of another organisation, or a renamed agent, change who was admitted. Module M1 stores the roster as IDs and routes every decision about an AGENT through `@vantageos/cloud-identity` 0.13.0 `assertPrincipalListed` (agent IDs only, no wildcard, refused by default). The task is `k173a1jxyvgtsenh5y1j0sjehd8fzk6c`; this is the EXPAND half of an expand-contract change.

- **Stored fields (additive, all optional) on `client_org_mapping`.** `allowedAgentIds` (the agents of this organisation on its roster), `addressableFleetCoordinatorIds` (operator-org agents this client may message directly), `fleetWide` (the explicit flag that replaces the `"*"` sentinel). Absent `allowedAgentIds` means no roster is stored and nobody is admitted.
- **One adapter.** `convex/lib/rosterIds.ts` resolves the agent through `resolveActingPrincipal` (the row read by ID: active, stamped with the org it is judged in, in an active org) and calls `assertPrincipalListed`. It compares nothing and reads no name. A coordinator is first proven to belong to an ACTIVE operator org by the stored `orgKind`, then judged against the client's stored coordinator list.
- **Readers switched.** `messages:sendMessage` `recipientAgentIds` (own roster, then coordinators), the scoped `broadcast` fan-out (the sender's ID roster, written by ID), `orgRoster:getMyAgentDirectory` and `orgRoster:getAgentDirectoryForAccessToken` (the STORED ID is returned: a coordinator on a client roster carries its own `agentId`, with no name lookup, and a rename changes only the label shown), the inbox reader (a receipt that carries the verified agent's own ID is that agent's in any tenant, so an operator coordinator reads mail a client addressed to it by ID), `scope.fleetWide` in place of `["*"]` on every master scope, `clientOrgMapping:getByClerkSlug` and the MCP delegation check (`orgFleetWide`).
- **Writers write IDs.** `clientOrgMapping:addRosterMembers` and `setAddressableFleetCoordinators` take `agentIds`, validated (an active agent of the roster's own org; an active operator-org agent), and `provisionOrganization` creates (or reuses) the seat `agents` rows of the brand-new org and stores their IDs. `tenantOrgSeed:seedClientOrgMapping` / `setOrgRoster` accept `allowedAgentIds`. The legacy name roster is still written beside the IDs (labels only, never read by an agent decision) until the contract PR.
- **A rename keeps every grant.** The roster holds the ID, so `agents:renameAgent` changes the display name and nothing else.
- **Backfill.** `migrations/backfillRosterAgentIds:backfillRosterAgentIds` (internal; dry run by default, `{"dryRun":false}` writes). A roster name resolves inside the roster's OWN tenant, a coordinator name inside the OPERATOR org; exactly one agent yields its ID, none is `unknown`, several is `ambiguous`; both are listed by mapping row id and never guessed. It never rewrites a stored ID field and only ever sets `fleetWide` to true, so a second write run patches nothing. Run order on prod: deploy, dry run, review the lists, write run.
- **Still compared by NAME, with their owner, until their rows carry IDs.** These decide on a name that is stored on a data row or typed by a caller; there is no ID on that row to compare and no name-to-ID conversion is added. They read the legacy `scope.allowedOrchestrators`: tasks (`filterByOrgScope` on `pilot`/`assignedTo`, the `callerOrchestrator` check, `requireOrchestratorOnRoster` for `assignedTo`), recurringTasks, missions, diary, businessUnits, profiles, dashboard and stats (aggregates over those rows), messages (a channel string, the stored `receipt.recipient` / `message.from`, the seat sender, `getUnreadCount`'s typed `orchestratorId`), `orgRoster:getMyOrgRoster` / `getForAccessToken` (the name roster the MCP delegation check compares `assignedTo` against), `lib/inboxReader` (the stored spellings of a legacy receipt), `receiptTenantBackfill` / `receiptTenantAudit` (they attribute stored receipt names to an org), `oauth` seat-name collision, and the MCP `fromAllowList`. The contract PR (removing `allowedOrchestrators` and `addressableFleetCoordinators`) cannot ship before those rows carry IDs.
- **Behaviour change to know.** A channel NAME no longer reaches a fleet coordinator: a coordinator is addressed by `recipientAgentIds`. The roster a client org stores by name is unchanged for its own agents.
- Tests: `convex/__tests__/rosterById.test.ts` (scoped identities: listed ID admitted; same-name agent of another org, a name-only listing, a missing roster and an unlisted coordinator refused; the coordinator ID from the stored roster; rename keeps the grant; coordinator mail read by ID; the backfill dry run and idempotent write run), `convex/__tests__/audit/orgRoster.twoPoles.test.ts`, `convex/__tests__/audit/agents.twoPoles.test.ts`.

### §4.11 An inbox is read by the caller's verified agent ID, never by a name (VantagePeers Cloud)

Measured defect (convex-test probe, task k17c5q842gm1gbh0j2qjtc80g18fx5kb, class of the Iris RH incident): the fleet service account calling `messages:checkNewMessagesEnvelope({ recipient: "hélios" })` with no `tenantId` received another org's same-named agent's message. That is the wire shape of an MCP seat calling `check_messages`: every seat reaches Convex as the service account (master, no org), and the inbox doors keyed on the `recipient` NAME. Prod was read-only measured at 55 agents with 0 names shared across orgs, so it was latent. Operator decision 2026-10-08: no registration guard, no name tolerance; the key is the verified agent ID.

The five doors share ONE reader resolution, `convex/lib/inboxReader.ts` (`resolveInboxReader`), and one ownership predicate (`ownsReceipt`): `messages:checkNewMessages`, `messages:checkNewMessagesEnvelope`, `messages:getUnreadCount`, `messages:markAsRead`, `messages:deleteMessage` (sender-keyed: `ownsSentMessage`). The envelope's task blocks (`staleInProgress`, `stuckInProgress`, `peersStuckOnYou`, keyed on a name too) are filtered by the same reader (`taskVisibleTo`).

| Reader | How it is identified | What it reads |
|---|---|---|
| agent | `verifiedActor { agentId, orgSlug }`, forwarded by the MCP, believed from the service account only, resolved BY ID through `@vantageos/cloud-identity` | receipts with `recipientId` = its ID, in its org (the operator org's agent also owns the unstamped fleet rows) |
| org-name | `verifiedOrg { orgSlug }` (a token naming several agents) plus a name | the name is resolved in THAT org only to an agent (then it is an agent reader); a name with no agents row stays confined to that org's tenant and the exact name |
| member | a Clerk member of an org (dashboard) | its own tenant, derived from its identity |
| fleet | the service account with NO claim (pi, eta ... which have no `agents` row) | the FLEET's tenant only (unstamped or operator-stamped), by exact name |
| operator-admin | the verified operator-org admin human (dashboard reads) | cross-tenant by design, unchanged |

- `recipient` / `callerOrchestrator`, when sent by an agent, may only NARROW: it must equal the verified agent's ID or its name under `normalizeOrchestratorId` (no accent fold: `helios` is not `hélios`). A mismatch, a `tenantId` that is not the agent's org, or a `verifiedOrg` that differs from the agent's org is a raised `RBAC_DENIED` naming the door (`reason`: `recipient-not-the-reader`, `tenant-not-the-readers-org`, `verified-org-differs-from-actor`), never an empty success.
- The service account naming a CLIENT tenant is refused (`tenant-inbox-needs-verified-reader`); a client org's mail is read through a verified identity. The service account marking with no owner named (the check-messages call) marks only fleet-tenant receipts (unstamped, or the operator's slug); a receipt from a client tenant refuses the whole batch (`tenant-receipt-needs-verified-reader`).
- `markAsRead`: every receipt must satisfy `ownsReceipt` for the reader (the whole call is refused otherwise, nothing marked). `deleteMessage`: a sender-keyed delete is decided by `message.fromId` (else the exact name) in the reader's tenant; the fleet `system` word keeps its reach; a human org admin keeps the dashboard path.
- **Legacy receipts (no `recipientId`).** Until `migrations/backfill_actor_ids:run {"table":"messageReceipts"}` has stamped them (by the row's tenant, or the operator org when unstamped, plus the exact normalised name; ambiguous and unknown names are listed by row ID and left unset), a receipt without an ID is served to an agent reader only when BOTH its `tenantId` is the reader's verified org AND its `recipient` equals the agent's name under `normalizeOrchestratorId`. An unstamped receipt grants nothing to a client org. A receipt carrying a DIFFERENT `recipientId` is never served by name. So no receipt becomes unreadable for its owner, and none is readable across orgs.
- **What remains name-keyed, and why.** (1) Fleet orchestrators (pi, eta, sigma ...) have no `agents` row, so the fleet reader keys on the verified fleet identity (the service account) plus an exact name inside the fleet tenant only: traced to task k17a1yprfca2cfjc4cnz4ynvvs8fwe5m (fleet-role agents-row gap), it moves to IDs when those rows exist. (2) A Clerk member (dashboard) reads by name inside its OWN tenant: it cannot cross orgs. (3) The operator-admin human reads cross-tenant by name by design (a read-only dashboard console). (4) A `verifiedOrg` name with no agents row is confined to the org's tenant and the exact name.
- **No-interruption deploy (expand, then contract).** The MCP that serves every seat until the claim-sending MCP is live (main 71510d2) sends NO claim on its inbox tools: a client seat, a person and a fleet station all reach Convex as the service account with a recipient name and at most a free `tenantId` tool argument, byte-identical between two orgs' same-named seats. So the doors ship in EXPAND mode (`UNCLAIMED_SERVICE_ACCOUNT_READS_EVERY_TENANT = true` in `convex/lib/inboxReader.ts`): a claimed call is served by the verified reader above, and the claimless service account is served exactly as before (every tenant, or the `tenantId` it names, by exact name; marking with no owner named keeps the master path). The MCP, if deployed first, would be refused by the old Convex validators (`verifiedActor` / `verifiedOrg` are unknown arguments there), so the order is: (1) deploy Convex in EXPAND; (2) merge the MCP change, Railway redeploys it; (3) observe a client seat's `check_messages` served through its `verifiedActor`; (4) CONTRACT: flip the flag to `false` in its own PR and deploy Convex. Steps (1) to (3) ran on 2026-10-09: Convex d55c11a was released to prod, the MCP 3682c11 was observed live, and a seat was served by its `verifiedActor`. Step (4) is the CONTRACT PR; once it is released, the two bullets above about the claimless service account hold (fleet tenant only, client tenant refused, an ownerless mark confined to fleet receipts). Pins: `convex/__tests__/inboxOldMcpWire.test.ts` (old wire, EXPAND) and the flag-gated CONTRACT poles in `inboxByAgentId.test.ts`, `checkNewMessagesTenantIdentity.test.ts`, `markAsReadTenant.test.ts`.
- Tests: `convex/__tests__/inboxByAgentId.test.ts` (two orgs each with an agent "hélios"), `convex/__tests__/inboxOldMcpWire.test.ts` (the old MCP's wire shapes), `mcp-server/test/inbox-doors-verified-reader.test.ts`.

### §4.12 Agents and agent credentials are resolved by agent ID (VantagePeers Cloud)

Operator rule: identity is the stored ID, never a name. A name is a display label: it may be checked for uniqueness inside its organisation as a UX constraint, but it never selects a row and never authorises one. Identity is decided in `@vantageos/cloud-identity` (0.12.0 or later); VantagePeers keeps no identity primitive of its own. `convex/lib/agentIdentity.ts` is the adapter: it performs the indexed reads by ID the package asks for and turns the package's typed refusal into this backend's `RBAC_DENIED`.

- **Who may administer.** `agents:*` `agentCredentials:mintAgentCredential`, `revokeAgentCredential`, `getAgentCredentialStatus` and `agentRelations:*` prove the caller an administrator of `orgSlug` with `resolveActingPrincipal` (a `person` credential built from the verified session: subject, organisation slug, role claim, never an argument) and `assertOrgAdmin` (`org:admin`, byte-equal). The organisation must be an active mapping. There is no master or service-account carve-out: neither is ever an administrator.
- **Which agent.** Every door that acts on an existing agent takes its `agentId` (`registerAgent` returns it). The row is read by that ID and compared to the principal's organisation by `assertTargetBelongsTo` on stored organisation IDs. An ID naming another organisation's agent is refused `RBAC_DENIED` (`target-other-organisation`), never returned and never touched. An ID naming no row is an absence: `AGENT_NOT_FOUND` on a write, `null` on `agents:getAgent`, a zero on `getAgentCredentialStatus`. A same name in two organisations is two agents with two IDs.
- **What a name still does.** `registerAgent` creates a row and refuses a label already held in the organisation (case-insensitively): `AGENT_NAME_TAKEN` naming the holder by ID, or `AGENT_INACTIVE` when the holder is retired. It no longer updates or revives the holder: registering the same label twice is a refusal, not an idempotent upsert.
- **Which credential.** `agentCredentials:resolveAgentCredential` calls `validatePresentedBearer` (header parse, SHA-256, constant-time digest compare, revocation, one collapsed refusal), then `requireAgentScopedIdentity`, then `resolveActingPrincipal` for the agent by ID in the organisation the bearer row carries (agent active, organisation active). A garbled, empty, rotated-out or unknown secret raises `RBAC_DENIED` with a reason (`no-credential`, `credential-not-recognised`), never an empty success. The door stays service-account-only.
- **Legacy credential rows.** A row with no `agentId` (minted before the field existed) carries a label and no ID. It is no longer selected by that label: it does not resolve, whatever agent holds the label, until `migrations/agentIdentityRows:backfillCredentialAgentIds` has bound it to its agent by ID (that operator migration is the one place a label is still read, once, with refuse-never-guess). Run the dry-run on prod and confirm `missingAgentIds` and `ambiguousIds` are empty BEFORE deploying this change, or every un-backfilled credential stops authenticating.
- **A rename touches the display name only.** `agents:renameAgent` patches the label and its uniqueness key, nothing else. Credentials and every grant keyed on the ID are untouched, and no roster (`client_org_mapping.allowedOrchestrators`) is rewritten. The row remembers no former label: a roster that names agents by label resolves an entry to the one active agent that carries that label NOW (`orgRoster:getMyAgentDirectory`, `getAgentDirectoryForAccessToken`), so after a rename the old label names nobody (`agentId: null`) until rosters hold agent IDs (module M1, task `k173a1jxyvgtsenh5y1j0sjehd8fzk6c`). Following a rename through a remembered former label would be identity by name and is refused; the assertion that a renamed agent stays addressable is owned by M1 (task `k173a1jxyvgtsenh5y1j0sjehd8fzk6c`), not by this module. `agent_relations` stores a denormalised copy of each endpoint's label (no ID column), so the rename refreshes that copy in bounded batches; its doors take agent IDs.
- **Not covered here.** The name-keyed roster gate in `messages:sendMessage` for `recipientAgentIds` (`isOrchestratorOnOrgRoster(reach, row.name)`: a renamed agent is listed by the directory with its ID and is still refused `recipient-agent-not-addressable` until that gate compares IDs or the roster names the new label), the other roster checks keyed on `allowedOrchestrators` and `fromAllowList`, and the other name lookups outside the registry (`findAgentByName` callers in `convex/lib/auth.ts`, `convex/messages.ts`, `convex/lib/actorIds.ts`, `convex/lib/seatAgent.ts`, `convex/lib/inboxReader.ts`) belong to their own modules.
- Tests: `convex/__tests__/agentIdentityById.test.ts` (scoped identity by ID, same name in another org, missing or garbled credential, rename keeps every grant).

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
- **(c) `global` prefix in Nadia's OAuth profile — undecided.** Whether a `global` namespace prefix belongs in Nadia's scope profile is **not settled**. TODO: confirm intent with Laurent before assuming any behavior for this prefix.
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
