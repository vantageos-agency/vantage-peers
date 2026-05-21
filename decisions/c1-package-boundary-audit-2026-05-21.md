---
type: ADR-audit
project: vantage-memory
ticket: k176zmpqvz4vgjbbas5gj2kdqd875c1y (C1 — Extraire @vantage/data-lake + @vantage/agent-protocol)
mission: k5715137sdn52b5dgm8s5tpzhx8751en (vantage-immo-fondations-v1)
date: 2026-05-21 (Day 77)
author: sigma
status: audit complete — awaits Pi/Xi GO before extraction code begins
upstream_advice: briefing js7dpf9m4swgb6sjarfgybq9ch874rh1
---

# C1 — Audit cross-table coupling avant extraction Components

Étape 1 non-négociable du plan d'attaque (cf briefing js7dpf9m4swgb6sjarfgybq9ch874rh1).
Inventaire read-only sur `convex/schema.ts` (881 lignes, 32 tables) + handlers + crons + http + mcp-server.

## 1. Mapping tables → buckets (32 tables)

### @vantage/data-lake (Component cible)
- `memories`

(L'embedding storage natif vit dans le Component `@convex-dev/rag` — déjà isolé, pas concerné par C1.)

### @vantage/agent-protocol (Component cible)
- `tasks`
- `missions`
- `messages`
- `messageReceipts`
- `briefingNotes`
- `diary`
- `profiles`
- `peers` (si table dédiée — sinon dérivé de `profiles`)
- `recurringTasks`
- `taskDependencies`
- `missionTemplates`

### VantagePeers core (consumer des 2 Components)
- IRP : `issues`, `fixPatterns`, `fixAttempts`, `errorLogs`, `errorMonitorFilterRules`, `issueStats`
- Marketplace : `licenses`, `mandates`, `mcpTenants`, `client_org_mapping`
- Registry applicatif : `components`, `businessUnits`, `monitoredDeployments`, `githubRepoMapping`
- OAuth : `oauth_clients`, `oauth_authorization_codes`, `oauth_access_tokens`, `oauth_refresh_tokens`, `oauth_scope_profiles`, `oauthClients`, `oauthTokens`

## 2. Cross-bucket foreign-keys identifiés

| From | Field | To | Boundary | Sévérité |
|---|---|---|---|---|
| `briefingNotes` | `linkedMemoryIds[]` | `memories` | **agent-protocol → data-lake** | moyenne (validation seulement) |
| `errorLogs` | `irpMissionId` | `missions` | **vp-core → agent-protocol** | HAUTE (auto-IRP cascade) |
| `mandates` | `linkedTaskIds[]` | `tasks` | **vp-core → agent-protocol** | moyenne |
| `issues` | (indirect) | `tasks`, `missions` | **vp-core → agent-protocol** | HAUTE (sync linkedTaskIds) |
| `tasks` | `missionId` | `missions` | agent-protocol interne | OK |
| `tasks` | `dependsOn[]` | `tasks` | agent-protocol interne | OK |

## 3. Cross-bucket handlers (queries jointes)

- `convex/http.ts` (≈ lignes 108-236) : webhook GitHub `issue opened` → lit `githubRepoMapping` (vp-core), crée `mission` + N `tasks` (agent-protocol) en synchrone.
- `convex/errorMonitorAutoResolver.ts` : query `tasks` par `missionId`, cascade-close `missions` + `tasks`.
- `convex/tasks.ts` `complete_task` : patch `issues.linkedTaskIds` (vp-core) au passage.
- `convex/errorMonitor.ts` `linkIrpMissionByIssueNumber` : update `errorLogs.irpMissionId` après `missions.create`.

## 4. MCP server multiplexer — distribution outils

- Data-lake : ~6 outils (`store_memory`, `recall`, `text_search`, `hybrid_search`, `list_memories`, `soft_delete_memory`, `get_memory`, `store_episode`).
- Agent-protocol : ~41 outils (tasks 8, missions 5, messages 5, diary 5, profiles 3, recurringTasks 5, briefingNotes 5, missionTemplates 1, peers 1, summary 1, plus dépendances).
- VP-core : ~38 outils (mandates 5, issues 6, fixPatterns 5, errors 2, deployments 2, repos 3, businessUnits 4, components overlap).

Implication : le MCP server doit router `store_memory` → `dataLake.api.store_memory` etc. — refactor mécanique mais ~85 lignes de wrapping.

## 5. Crons crossing buckets

| Cron | Boundary |
|---|---|
| `process recurring tasks` (15min) | agent-protocol interne — OK |
| `error monitor` (5min) | **vp-core → agent-protocol** (crée missions+tasks) |
| `auto-resolve stale irp` (6h, ajout PR #504) | **vp-core → agent-protocol** (cascade-close) |
| `daily issue stats` (6h UTC) | vp-core interne — OK |
| `pr monitor` (hourly) | vp-core interne — OK |

## 6. HTTP endpoints crossing buckets

`convex/http.ts` est l'endpoint d'intégration le plus couplé :
- `issue opened` (l. 108-236) : `vp-core → agent-protocol` (création mission + tasks).
- `issue comment` (l. 278-400) : `vp-core → agent-protocol`.
- `pr merged` : crée task de deploy automatique (`vp-core → agent-protocol`).

Aucun endpoint http inverse (agent-protocol → vp-core). Le couplage est unidirectionnel : vp-core *appelle* agent-protocol.

## 7. Top-5 coupling hotspots → APIs publiques à concevoir

| # | Hotspot | API publique requise (côté Component) |
|---|---|---|
| 1 | `errorLogs.irpMissionId` cascade close | `agent-protocol.missions.closeWithCascade({missionId, reason})` |
| 2 | Webhook GitHub → mission+tasks creation | `agent-protocol.mission.createFromTemplate({templateName, params})` — appelée depuis http.ts vp-core |
| 3 | `tasks.complete` → `issues.linkedTaskIds` patch | événement publié par agent-protocol, écouté par vp-core (inversion contrôle) OU mutation explicite `vp-core.issues.notifyTaskComplete({issueId, taskId})` appelée depuis agent-protocol handler |
| 4 | `briefingNotes.linkedMemoryIds[]` validation | `data-lake.memories.validateIds({ids})` query côté agent-protocol |
| 5 | `mandates.linkedTaskIds[]` validation | `agent-protocol.tasks.validateIds({ids})` query côté vp-core |

## 8. Blocker architectural majeur identifié

`convex/http.ts` webhook handler crée synchrone mission+tasks depuis vp-core dans agent-protocol. Sans abstraction, l'extraction casse ce flow. Deux options :

- **Option A (recommandée)** : agent-protocol expose une mutation publique `mission.createFromTemplate({templateName, github_payload})` ; http.ts vp-core l'appelle. Aucune file d'attente, latence inchangée.
- **Option B** : événement asynchrone (errorLog created → publish event → agent-protocol subscriber). Plus propre mais ajoute latence + complexité, et Convex Components ne supportent pas nativement les events pub/sub (mécanisme à émuler avec scheduled mutations).

Option A est compatible Convex Components et préserve le contract.

## 9. Risques résiduels post-API design

- **Migration data** : les `irpMissionId` et `linkedTaskIds` existants doivent être préservés au passage Component. Pattern Day 76 reindex applicable (batch mutation, evidence-bound).
- **Cédric self-host upgrade** : Cédric vient de subir le bug aiClient (PR #505). Toute migration cassante = ticket. Mitigation : v1 du Component additif (anciennes tables conservées en parallèle pendant 1 release), migration scriptée.
- **Tests** : suite 281/281 doit tourner sur version split. Tests par Component + tests d'intégration côté VP core.

## 10. Décision

**Verdict audit Sigma** : extraction faisable. 5 APIs publiques à concevoir (§7). Blocker http.ts levable par option A.

**Pré-requis avant code** :
1. Pi/Xi review de cet ADR + arbitrage option A vs B sur le hotspot http.ts.
2. ADR follow-up : APIs publiques signatures détaillées.
3. Ordre d'exécution : data-lake first (1 table, 1 boundary §7 #4) → agent-protocol (11 tables, 4 boundaries §7 #1-#3, #5).

**STOP** : aucune ligne de code C1 écrite avant cette validation. Task k176zmpqvz4vgjbbas5gj2kdqd875c1y en in_progress, sous-étape "audit complete" terminée. Reste : design APIs + scaffold Components, à dispatch dev-convex-expert après GO Pi/Xi.

---

*Sigma — VantageOS Team | 2026-05-21 Day 77*
