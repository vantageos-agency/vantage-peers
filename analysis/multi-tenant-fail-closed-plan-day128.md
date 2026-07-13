# Multi-tenant fail-closed — plan T0 (Day 128)

Mission `k575kke4e0sfesyh1jqza3hxhn8aa7tc` — T0 `k17dhtvz8ekwyawbasn7nsaet18abjcy`.
Scoping pur, aucune ligne de fix. Mesuré corps-par-corps, pas au grep de surface.

## Verdict de sévérité (question de Pi : emergency vs pré-go-live)

**Le trou est réel et localisé. La sévérité tient à UN fait de provisioning que je ne peux
pas lire depuis le code : le `convexUrl` du tenant MCP de Alice / Acme HR.**

- `convexUrl` de Alice = backend **partagé** (compassionate-goldfinch-737) → **EMERGENCY**.
  Elle voit les données de tous les orgs (voir mécanisme ci-dessous).
- `convexUrl` de Alice = déploiement **dédié** → isolée par déploiement → non-emergency,
  gate propre avant go-live du vecteur web.

Escaladé à Pi/Laurent — eux seuls connaissent la valeur provisionnée (ou peuvent lire la
table `mcpTenants` en master auth).

## Mécanisme mesuré

### Deux vecteurs, deux modèles d'auth (mcp-server/src/auth.ts)

Le serveur MCP appelle Convex via `buildInternalClient()` (auth.ts:88) **sans identité
Clerk** → tous ses appels sont `isMaster` côté `withOrgScope` (convex/lib/auth.ts, fail-open).
Donc l'isolation des clients MCP ne repose PAS sur `withOrgScope` — elle repose sur la
couche MCP (`checkNamespaceRead/Write`, auth.ts:200-238) via les guards de `registerTools`
(tools.ts:1478+).

Chemins d'auth (auth.ts, dans l'ordre) :

| # | Chemin | scopeProfile | oauthContext posé ? | Isolation |
|---|---|---|---|---|
| 1 | Master token | master | oui, prefixes `["*"]` | volontairement cross-tenant |
| 2 | OAuth (oauth_access_tokens) | admin-provisionné | oui, isMaster=false | namespace prefixes |
| 2.5 | Clerk JWT | team-member | oui, `team/<orgId>` | namespace prefixes — **correct** |
| 3 | DCR OAuth | client-generic | oui, prefixes `[]` (deny-by-default) | **correct** (fix Day 84) |
| 4 | **Legacy bearer mcpTenants** | — | **NON** (`c.set("tenant")` seul, pas d'`oauthContext`) | **uniquement `tenant.convexUrl`** |

### Le trou : chemin (4)

Le chemin (4) (auth.ts:515-560) pose `tenant` (tenantName + convexUrl) mais **jamais
`oauthContext`**. Or les guards de tools.ts sont explicitement no-op quand `oauthCtx` est
`undefined` (commentaire tools.ts:1478 « no-op when oauthCtx is undefined — legacy bearer
path ») :
- `checkNamespaceRead(!ctx)` → `return null` (passe)
- `guardMasterOnly(!oauthCtx)` → `return null` (passe)

Donc un bearer legacy mcpTenants **passe tous les contrôles de namespace ET les tools
master-only**. Sa seule frontière est `tenant.convexUrl`. Si ce convexUrl est le backend
partagé, l'appelant atteint les handlers Convex non scopés (audit précédent : 15
UNSCOPED-READ + 15 UNSCOPED-WRITE, dont memories.*) en `isMaster`.

### Couverture des guards dans tools.ts (comptage corrigé — mesuré sur les sites d'appel `guard*(`, pas la définition)

- `guardRead(` : 9 · `guardWrite(` : 2 · `guardMasterOnly(` : 20 · `guardFrom(` : 40

Ces guards protègent correctement les vecteurs (2)/(2.5)/(3). Ils sont **inertes** pour le
vecteur (4). Le design par namespace prefixes est sain ; le défaut est que (4) n'entre pas
dans ce design.

## Classification (a)/(b) — à finaliser après réponse convexUrl

- (a) client-facing → doivent porter withOrgScope (côté Convex) OU un oauthContext scopé
  (côté MCP) : memories.*, messages.listByChannel/getById, diary.*, tasks/missions get-by-id.
- (b) interne-flotte-only → interdiction structurelle depuis surface client : les tools
  master-only (20 sites guardMasterOnly), mcpTenants admin, okfBundle export/import.

Zones non encore lues corps-par-corps (déclarées) : oauth.ts (18 handlers), mandates, issues.

## Décision fail-closed proposée (T2)

1. Le chemin (4) doit poser un `oauthContext` scopé (prefixes = le tenant), OU être retiré
   au profit des chemins (2)/(2.5)/(3). Un bearer sans scope ne doit plus impliquer un accès
   non gardé.
2. `withOrgScope` (convex/lib/auth.ts) : sans identité vérifiable pour une surface client →
   refuser, pas isMaster. Distinguer l'appelant interne-flotte légitime de l'absence d'identité.
3. filterByOrgScope : scoper sur orgId, pas sur nom d'orchestrateur.

## Élargissement de périmètre (finding Kappa, Day 128)

Le vecteur web `/client/[orgSlug]` n'existe pas encore sur main (PR #45 non mergée) — pas
de fuite par là aujourd'hui. MAIS `messages.listByChannel` et `diary.list` sont **déjà
consommés en prod** par la surface interne Alpha (`/dashboard/**` :
unified-activity-feed.tsx, diary-feed.tsx, message-history-table.tsx, message-timeline.tsx).
Ce n'est pas une fuite aujourd'hui (seule identité Clerk = Laurent, master). Ça le devient
**mécaniquement** dès qu'un client externe reçoit un compte Clerk sur cette app : il
atterrit sur `/dashboard/**`, pas sur `/client`, et `/dashboard/activity` lui sert le diary
et les messages de tous les orgs.

**Conséquence pour la mission** : le fix ne peut pas se limiter à ne pas ajouter de source
au feed `/client`. Il faut AUSSI, avant tout go-live client :
- scoper `messages.listByChannel` / `diary.list` côté handler (T2),
- interdire structurellement `/dashboard/**` à une identité client (T3, garde route).

MISE À JOUR (Kappa, Day 128) : le garde ROUTE existe déjà et est désormais PROUVÉ.
`applyOrgRouting` (dashboard PR #3 @08991d5) redirige une identité client hors de
`/dashboard/**` ; PR #47 extrait la décision pure dans `lib/auth/dashboardGate.ts` et la
teste (7 tests, RED mutation-prouvé, 431/431). Donc le volet ROUTE de T3 côté dashboard
est couvert par Kappa — mon périmètre backend n'a pas à le refaire.

MAIS — et c'est le point de Kappa, exact : ce garde est PÉRIMÉTRIQUE, pas au niveau
donnée. Il empêche une identité client d'ATTEINDRE `/dashboard`, il n'empêche PAS
`messages.listByChannel` / `diary.list` de renvoyer TOUS les orgs à qui les appelle. Si un
seul chemin oublie le garde, OU si `withOrgScope` fail-open rend isMaster sans identité (le
finding racine), la donnée sort. « Un mur n'est pas un coffre. » Le fix data-level (T2 :
scoper les handlers + inverser withOrgScope) reste INDISPENSABLE et non substituable par le
garde route.

## Verdict de sévérité — TRANCHÉ (lecture de table, Day 128)

**NON-emergency.** Alice / Acme HR passe par le chemin (2) OAuth scopé, PAS le chemin (4)
troué. Preuve (npx convex data, autorisé par Laurent) :
- `mcpTenants` (chemin 4) = un seul tenant `e2e-test` (compte de test). Aucune vraie cliente.
- `oauth_scope_profiles` : profils Alice (`alice-acme-hr`, `acme-hr`, personas Zoé/Milo)
  avec namespaceReadPrefixes ÉTROITS (`orchestrator/alice`, `orchestrator/victor`,
  `project/alice`/`project/acme-hr`, `global`) — jamais `["*"]` (seul `master` l'a).
Les guards de tools.ts s'appliquent sur ce chemin → Alice est bornée à ses namespaces.
Les 2 trous (chemin 4 sans oauthContext ; withOrgScope fail-open) restent de vraies dettes
de défense-en-profondeur à fermer, mais sans exposition cliente réelle aujourd'hui.

### Point de complétude à confirmer avec Laurent (finding Pi) — le prefix `global`

Les profils OAuth de Alice incluent `global` dans namespaceReadPrefixes (et parfois write).
`global` porte des facts fleet-wide : règles, identité Laurent, feedback interne. Une
cliente externe qui lit `global` voit donc de l'interne d'entreprise. **Est-ce
intentionnel ?** Ne pas trancher l'intention seul (no-fabricated-decisions) — à confirmer
avec Laurent. Si non intentionnel → retirer `global` du profil de Alice en T2/T3. Signalé
ici comme point de complétude, pas comme fuite cross-tenant (global n'est pas l'espace d'un
autre client).

## Bloquant T0 → RÉSOLU (voir verdict ci-dessus)

Question binaire ouverte : **le tenant MCP de Alice / Acme HR est-il provisionné sur le
backend partagé (compassionate-goldfinch-737) ou sur un déploiement Convex dédié ?**
Le seed (scripts/seed-mcp-tenant.ts) prend `--convex-url` en argument, sans défaut → valeur
inconnue depuis le code seul.
