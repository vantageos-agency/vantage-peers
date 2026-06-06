# Runbook: OAuth migration (legacy static bearers → DCR + authorization_code)

**Audience:** orchestrators performing an OAuth migration on a VP MCP Cloud tenant.
**Scope:** migration from pre-OAuth static bearers (per-user `BEARER_*` env vars) to
OAuth 2.1 DCR + confidential clients with `authorization_code` grant.
**Status:** v1 — captured from Day 92 migration on `compassionate-goldfinch-737`
(mission `k57a36y8w5t085bqr23dsmvb2d882506`) and Day 93 capitalize from triage
`k17bhtdpjpb96d4q9nkpa8h59d884grj` (stale env-var false positive).

---

## 1. When to use this runbook

Run this when migrating a tenant from any flow that exposed a long-lived per-user
static bearer (typed into a chat connector, hardcoded in a smoke test, or stored
in a Convex env var like `BEARER_CHATGPT_<USER>_VP`) to OAuth flow with
dynamically issued tokens.

Symptoms that say "this migration was never finished cleanly":

- Stale `BEARER_*` env vars on the Convex deployment whose owning OAuth client has
  a `revokedAt` timestamp.
- Smoke scripts that `curl /mcp -H "Bearer ${BEARER_CHATGPT_<USER>_VP}"` and report 401.
- Two OAuth clients with the same end-user name but disjoint scope profiles —
  expected when the migration also re-scoped that user, but the old client
  should be `revokedAt`-set, not just orphaned.

## 2. Migration steps

### 2.1 Register confidential clients (DCR or manual)

Create one `oauth_clients` row per (user × surface) pair you need to support.
Each row carries `clientId` (UUID), `clientSecretHash`, the target `scopeProfile`,
`redirectUris` for the surface (Claude.ai, ChatGPT, …), and
`tokenEndpointAuthMethod: "client_secret_post"`.

Surfaces and their canonical `redirectUris`:

| Surface | `redirectUris` |
|---|---|
| Claude.ai | `https://claude.ai/api/mcp/auth_callback`, `https://claude.ai/api/organizations/oauth/callback` |
| ChatGPT custom connector | `https://chatgpt.com/connector/oauth/*` (wildcard) |

### 2.2 Revoke the legacy clients

For every legacy `oauth_clients` row that represented the same end-user under
the deprecated flow, set `revokedAt = now`. Do **not** delete the row — the
audit log references `clientId`. Revoked rows stay queryable for
`oauth:listClients` audits but reject token exchange.

### 2.3 Purge stale `BEARER_*` env vars (DAY 93 ADDITION — non-negotiable)

This is the step that was missing in Day 92 and surfaced as a false-positive
smoke failure on Day 93.

```bash
# Inventory: every BEARER_* on the prod deployment
CONVEX_DEPLOY_KEY='<prod-deploy-key>' npx convex env list | grep -E '^BEARER_'

# For each entry that is NOT BEARER_SECRET_MASTER, confirm it points at a
# revoked client (curl /mcp with that bearer should return HTTP 401):
curl -X POST https://<host>/mcp \
  -H "Authorization: Bearer ${VALUE}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}' \
  -w "\nHTTP %{http_code}\n" -sS | tail -3

# If 401, the bearer is stale. Purge:
CONVEX_DEPLOY_KEY='<prod-deploy-key>' npx convex env remove BEARER_CHATGPT_<USER>_VP

# Verify:
CONVEX_DEPLOY_KEY='<prod-deploy-key>' npx convex env list | grep -E '^BEARER_'
# Expected: only BEARER_SECRET_MASTER remains.
```

`BEARER_SECRET_MASTER` is the live master bearer used by admin tooling and
smoke regression. **Do not remove it.** Every other `BEARER_*` on a tenant
that has been OAuth-migrated is stale by definition — the live access path
is OAuth flow with dynamically issued tokens.

## 3. Smoke test methodology (post-migration)

The migration changes what is testable. After running steps 2.1–2.3:

- **Allowed**: smoke `/mcp` with the master bearer (`BEARER_SECRET_MASTER`) and
  with the persistent test-tenant trio bearers
  (`VP_TEST_ALPHA_BEARER`, `VP_TEST_BETA_BEARER`, `VP_TEST_GAMMA_BEARER`).
  These bearers belong to clients designed to remain stable across migrations.
- **Forbidden**: smoke `/mcp` with any `BEARER_CHATGPT_<USER>_VP` or other
  user-named static bearer. Those bearers either point at revoked clients
  (return 401) or — worse — point at a client that has not been revoked yet,
  in which case the smoke succeeds today and silently fails tomorrow.

For OAuth-flow validation, exercise `/oauth/authorize` + `/oauth/token` directly
with the current `clientId` for the surface under test. Never hardcode a
post-issue bearer in a smoke script.

## 4. Verification checklist

- [ ] `npx convex env list | grep BEARER_` returns `BEARER_SECRET_MASTER` only.
- [ ] `npx convex run oauth:listClients '{"callerToken":"<master>"}'` lists at
      most one active (non-`revokedAt`) client per (user × surface).
- [ ] Smoke regression with master bearer returns HTTP 200 on `whoami`.
- [ ] Smoke regression with each trio bearer returns HTTP 200 on `whoami`.
- [ ] Migration audit entry appended (`actor=<orchestrator>`,
      `reason="<mission-id>-oauth-migration"`).

---

## Runbook: migration OAuth (bearers statiques legacy → DCR + authorization_code)

**Audience :** orchestrateurs effectuant une migration OAuth sur un tenant VP MCP Cloud.
**Périmètre :** migration depuis un flow pré-OAuth avec bearers statiques par utilisateur
(env vars `BEARER_*`) vers OAuth 2.1 DCR + clients confidentiels avec grant
`authorization_code`.
**Statut :** v1 — capitalisé depuis la migration Day 92 sur `compassionate-goldfinch-737`
(mission `k57a36y8w5t085bqr23dsmvb2d882506`) + capitalize Day 93 du triage
`k17bhtdpjpb96d4q9nkpa8h59d884grj` (faux positif env var stale).

### 1. Quand utiliser

À utiliser pour migrer un tenant depuis un flow qui exposait un bearer statique
long-lived par utilisateur (saisi dans un connecteur chat, hardcodé dans un
smoke, ou stocké dans une env var Convex comme `BEARER_CHATGPT_<USER>_VP`)
vers un flow OAuth avec tokens émis dynamiquement.

Symptômes "migration jamais finalisée proprement" :

- Env vars `BEARER_*` orphelines sur le déploiement Convex alors que le client
  OAuth propriétaire est marqué `revokedAt`.
- Scripts smoke qui font `curl /mcp -H "Bearer ${BEARER_CHATGPT_<USER>_VP}"`
  et reçoivent 401.
- Deux clients OAuth avec le même nom utilisateur mais des scope profiles
  disjoints — normal si la migration ré-scope l'utilisateur, anormal si
  l'ancien client n'a pas reçu son `revokedAt`.

### 2. Étapes

#### 2.1 Enregistrer les clients confidentiels (DCR ou manuel)

Une ligne `oauth_clients` par couple (utilisateur × surface). Chaque ligne porte
`clientId` (UUID), `clientSecretHash`, `scopeProfile` cible, `redirectUris` de
la surface (Claude.ai, ChatGPT…), `tokenEndpointAuthMethod: "client_secret_post"`.

#### 2.2 Révoquer les clients legacy

Pour chaque ligne legacy qui représentait le même utilisateur sous l'ancien
flow, poser `revokedAt = now`. **Ne pas supprimer** la ligne — l'audit log
référence `clientId`. Les lignes révoquées restent interrogeables via
`oauth:listClients` mais rejettent l'échange de token.

#### 2.3 Purger les env vars `BEARER_*` stale (AJOUT DAY 93 — non négociable)

Étape manquante Day 92, surfacée comme faux positif smoke Day 93.

```bash
# Inventaire : toutes les BEARER_* sur prod
CONVEX_DEPLOY_KEY='<prod-deploy-key>' npx convex env list | grep -E '^BEARER_'

# Pour chaque entrée qui n'est PAS BEARER_SECRET_MASTER, confirmer qu'elle
# pointe vers un client révoqué (curl /mcp -> HTTP 401) puis purger :
CONVEX_DEPLOY_KEY='<prod-deploy-key>' npx convex env remove BEARER_CHATGPT_<USER>_VP

# Vérification : seul BEARER_SECRET_MASTER doit subsister.
CONVEX_DEPLOY_KEY='<prod-deploy-key>' npx convex env list | grep -E '^BEARER_'
```

`BEARER_SECRET_MASTER` est le bearer master live (outil admin + smoke
regression). **Ne pas le supprimer.** Toute autre `BEARER_*` sur un tenant
OAuth-migré est stale par définition — le chemin d'accès live est OAuth flow
avec tokens émis dynamiquement.

### 3. Méthodologie smoke test (post-migration)

- **Autorisé** : smoke `/mcp` avec le master bearer (`BEARER_SECRET_MASTER`)
  et avec les bearers du trio test persistant
  (`VP_TEST_ALPHA_BEARER`, `VP_TEST_BETA_BEARER`, `VP_TEST_GAMMA_BEARER`).
  Ces bearers sont conçus pour rester stables d'une migration à l'autre.
- **Interdit** : smoke `/mcp` avec un `BEARER_CHATGPT_<USER>_VP` ou autre
  bearer statique nommé d'après un utilisateur. Soit ils pointent vers un
  client révoqué (401), soit — pire — ils pointent vers un client pas
  encore révoqué : le smoke passe aujourd'hui et échoue silencieusement
  demain.

Pour valider le flow OAuth lui-même, exercer `/oauth/authorize` + `/oauth/token`
directement avec le `clientId` courant de la surface testée. Jamais hardcoder
un bearer post-émission dans un script smoke.

### 4. Checklist de vérification

- [ ] `npx convex env list | grep BEARER_` retourne uniquement `BEARER_SECRET_MASTER`.
- [ ] `npx convex run oauth:listClients '{"callerToken":"<master>"}'` ne liste
      au maximum qu'un client actif (non `revokedAt`) par (utilisateur × surface).
- [ ] Smoke regression master bearer → HTTP 200 sur `whoami`.
- [ ] Smoke regression chaque bearer du trio → HTTP 200 sur `whoami`.
- [ ] Entrée audit migration appendée (`actor=<orchestrator>`,
      `reason="<mission-id>-oauth-migration"`).
