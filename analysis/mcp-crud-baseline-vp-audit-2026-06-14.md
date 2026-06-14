# MCP CRUD Baseline — VantagePeers Audit Matrix

**Mission**: `k575kc1ryps0n8br95jw3q7d0x88m2v9` — MCP CRUD Baseline Standard
**Task**: T1 `k17fy3wvdp44qn6mbdym3hrcex88nd3j` — Audit VP matrice 18+ entités × 5 ops
**Standard**: doctrine memory `j57dhrmkzjerjtssnr0z9ba57n88n7q7` (5 ops obligatoires : get / list / search_by_keyword / search_by_semantic / create-or-upsert)
**Snapshot HEAD**: `acbb50330c55dd8a5fe54afdda398f54dc7c2f29` (npm vp-mcp@2.7.0 LIVE)
**Inventaire**: `awk '/server\.tool\(/{getline; print}' mcp-server/src/tools.ts` → 101 tools registered
**Schema source**: `convex/schema.ts` (38 defineTable, dont 18 customer-facing entités Laurent verbatim Day 101)

---

## 1. Matrice canonique — 18 entités customer-facing × 5 ops

Légende :
- ✅ EXPOSED — outil présent, satisfait l'op
- ❌ MISSING — entité supporte logiquement l'op mais aucun outil l'expose (gap à combler T2)
- ⚠️ DRIFT — outil existe mais nommage hors convention `_by_keyword`/`_by_semantic` (rename à scheduler T2)
- 🟦 N/A — op non applicable (justifier inline)

| # | Entity | Table Convex | 1. get_\<entity\>(id) | 2. list_\<entity\>s(filters) | 3. search_by_keyword | 4. search_by_semantic | 5. create / upsert | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | task | tasks | ✅ `get_task` | ✅ `list_tasks`, `list_tasks_by_mission` | ❌ MISSING | 🟦 N/A (no vectorIndex on tasks) | ✅ `create_task` | gap search_kw critique : audience la plus grosse (Eta T13 close-issue scan), nécessite BM25 sur title+description |
| 2 | memory | memories | ✅ `get_memory` | ✅ `list_memories` | ⚠️ DRIFT — `text_search` (rename → `search_memories_by_keyword`) | ⚠️ DRIFT — `recall` (rename → `search_memories_by_semantic`) | ✅ `store_memory` | seule entité avec les 5 ops déjà couvertes ; **convention non respectée**, rename obligatoire T2. Bonus : `hybrid_search` (RRF fusion) garder en cross-cutting. |
| 3 | message | messages | ✅ `get_message` | ✅ `list_messages`, `list_broadcast_status` | ❌ MISSING | 🟦 N/A (no vectorIndex, messages éphémères) | ✅ `send_message` | gap search_kw : audit post-incident sur subject/content déjà demandé (messages-history skill) |
| 4 | briefing_note | briefingNotes | ✅ `get_briefing_note` | ✅ `list_briefing_notes` | ❌ MISSING | ❌ MISSING (table candidate vectorIndex — corpus narratif, déjà demandé par briefing-recall skill) | ✅ `create_briefing_note` + `update_briefing_note` | search_sem à valider : Laurent peut vouloir "find briefings about X decision" en sémantique. T2 décision binaire add vectorIndex ou N/A justifié. |
| 5 | mission | missions | ✅ `get_mission` | ✅ `list_missions` | ❌ MISSING | 🟦 N/A (titles courts, key→value) | ✅ `create_mission` | gap search_kw : "find mission about hotfix" courant |
| 6 | mandate | mandates | ✅ `get_mandate` | ✅ `list_mandates` | ❌ MISSING | 🟦 N/A | ✅ `create_mandate` (+ `accept`, `update`, `settle`) | gap search_kw nice-to-have |
| 7 | episode | (memories type=episode) | 🟦 N/A séparé — via `get_memory` + filter | 🟦 N/A séparé — via `list_memories` + filter | ✅ via memories `text_search` (héritage) | ✅ via memories `recall` (héritage) | ✅ `store_episode` | episodes sont des memories spécialisées 8-Sins ; T2 décider si surface canonique `get_episode`/`list_episodes` wrappers ergonomiques OU rester sur memory + filtre type=episode. **Recommendation**: ajouter wrappers — cohérent avec la doctrine "5 ops per entity" même pour sous-types. |
| 8 | fix_pattern | fixPatterns | ✅ `get_fix_pattern` | ✅ `list_fix_patterns` | ⚠️ DRIFT — `search_fix_patterns` (rename → `search_fix_patterns_by_keyword`) | ❌ MISSING (corpus narratif "what fixed bug X" — vectorIndex candidate) | ✅ `create_fix_pattern` | rename + add semantic search à scheduler T2 |
| 9 | component | components | ✅ `get_component` | ✅ `list_components` | ⚠️ DRIFT — `search_components` (rename → `search_components_by_keyword`) | ❌ MISSING (description/brief textuels — vectorIndex candidate) | ✅ `register_component` (+ `update`, `delete`) | rename + add semantic |
| 10 | repo_mapping | githubRepoMapping | ✅ `get_repo_mapping` | ✅ `list_repo_mappings` | ❌ MISSING | 🟦 N/A (clé→valeur structuré) | ✅ `register_repo_mapping`, `add_repo_mapping`, `remove`, `delete` | search_kw justifiable N/A : 20-30 entrées max, list+filter suffit |
| 11 | bu | businessUnits | ✅ `get_bu` | ✅ `list_bus` | ❌ MISSING | 🟦 N/A | ✅ `create_bu`, `update_bu`, `delete_bu` | search_kw N/A : ~10 BU max, list suffit |
| 12 | profile | profiles | ✅ `get_profile` | ✅ `list_peers` | ❌ MISSING | 🟦 N/A | ✅ `update_profile`, `set_summary`, `update_summary`, `whoami` | search_kw N/A : fleet roster ≤ 25 orchs, list suffit. Note: `whoami` est convenience getter pour self-profile. |
| 13 | deployment | monitoredDeployments | ❌ MISSING `get_deployment` | ❌ MISSING `list_deployments` | ❌ MISSING | 🟦 N/A | ✅ `add_deployment`, `register_deployment`, `remove_deployment`, `delete_deployment` | **gap critique** : write-only, lecture impossible côté MCP. Cron health checks 5min poll les deploys sans exposer la liste. T2 prio. |
| 14 | diary | diary | ✅ `get_diary` | ✅ `list_diaries` | ❌ MISSING | ❌ MISSING (corpus narratif EOD — vectorIndex candidate fort pour "what did sigma do on Day X") | ✅ `write_diary`, `create_diary` | search_sem prio T2 — diary-discover skill veut surface "recall diary about deploy" |
| 15 | error | errorLogs | ✅ `get_error` | ✅ `list_errors` | ❌ MISSING | 🟦 N/A | 🟦 N/A — système-créé (Convex error monitor), pas user-created | search_kw nice-to-have (stack trace grep) ; write justifié N/A |
| 16 | issue | issues | ✅ `get_issue` | ✅ `list_issues` + `issue_stats` (rollup) | ❌ MISSING | ❌ MISSING (corpus narratif "bug description X" — vectorIndex candidate) | ✅ `update_issue_status`, `verify_issue`, `link_commit_to_issue`, `link_issue_to_pattern` | pas de `create_issue` — issues GitHub webhook-créées. Convention "write satisfait par update" OK. |
| 17 | recurring_task | recurringTasks | ✅ `get_recurring_task` | ✅ `list_recurring_tasks` | ❌ MISSING | 🟦 N/A | ✅ `create_recurring_task`, `update`, `pause`, `resume`, `delete` | search_kw N/A : ≤ 30 entries fleet-wide |
| 18 | summary | (profiles.summary) | 🟦 N/A séparé — via `get_profile` | 🟦 N/A séparé — via `list_peers` | 🟦 N/A | 🟦 N/A | ✅ `set_summary`, `update_summary` | summary est sub-field de profile, pas table indépendante. Tous get/list/search via profile. |

---

## 2. Entités auxiliaires hors-18

| Entity | Table | Statut | Notes |
|---|---|---|---|
| mission_template | missionTemplates | ✅ `get_mission_template` ; ❌ MISSING `list_mission_templates` ; ❌ MISSING search_kw ; 🟦 search_sem N/A ; ✅ `update_mission_template`, `instantiate_template_into_mission` | gap list — bloque "what templates exist" workflow |
| fix_attempt | fixAttempts | 🟦 sous-record de fix_pattern — get/list N/A via parent ; ✅ `add_fix_attempt`, `create_fix_attempt`, `check_fix`, `validate_fix` | logique sub-doc, exposition séparée non requise |
| oauth_* (clients/tokens/codes/audit) | oauth_* tables | 🟦 N/A — internal infra, non customer-facing MCP | hors scope baseline |
| mcpTenants | mcpTenants | 🟦 N/A — multi-tenant infra | hors scope |
| errorMonitorFilterRules | errorMonitorFilterRules | 🟦 N/A — internal config | hors scope |

---

## 3. Gaps totaux par opération

| Op | EXPOSED | MISSING | DRIFT (rename) | N/A documenté | Total entités scope |
|---|---|---|---|---|---|
| 1. get_\<entity\>(id) | 14 | 1 (deployment) | 0 | 3 (episode, summary, fix_attempt en sous-record) | 18 + 2 aux |
| 2. list_\<entity\>s | 14 | 2 (deployment, mission_templates) | 0 | 2 (episode, summary) | 18 + 2 aux |
| 3. search_by_keyword | 1 (memories drift) | 13 | 3 (memories `text_search`, fix_patterns `search_fix_patterns`, components `search_components`) | 7 (repo_mapping, bu, profile, deployment, recurring_task, summary, episode) | 18 + 2 aux |
| 4. search_by_semantic | 1 (memories drift) | 5 (briefing_note, fix_pattern, component, diary, issue — corpus narratifs candidats vectorIndex) | 1 (memories `recall`) | 13 (entités structurées non vectorisables) | 18 + 2 aux |
| 5. create / upsert | 17 | 0 (error N/A système-créé) | 0 | 1 (error système, summary update only) | 18 + 2 aux |

**Total gap count à combler T2** : 13 search_by_keyword + 5 search_by_semantic + 1 get_deployment + 2 list (deployment + mission_templates) + 4 renames = **25 actions** sur l'audit, avant épisode wrappers (recommandation +2 actions : get_episode + list_episodes).

---

## 4. Convention drift — renaming requis (T2)

Convention canonique (doctrine T0 reminder) : pour chaque entité, les outils de recherche DOIVENT s'appeler `search_<entity>s_by_keyword` et `search_<entity>s_by_semantic` — le suffixe `_by_keyword` / `_by_semantic` est obligatoire pour rendre le split visible côté client MCP.

Tous les renames préservent l'outil existant en alias rétro-compat ≥ 1 release, puis suppression à la majeure suivante :

| Outil legacy | Nouveau nom canonique | Justification |
|---|---|---|
| `text_search` | `search_memories_by_keyword` | conformité doctrine convention |
| `recall` | `search_memories_by_semantic` | idem ; `recall` reste alias temporaire pour compat skills existants |
| `search_fix_patterns` | `search_fix_patterns_by_keyword` | suffixe explicite |
| `search_components` | `search_components_by_keyword` | suffixe explicite |

`hybrid_search` (RRF fusion BM25 + semantic) reste cross-cutting : ne renomme pas, mais à scheduler éventuel `hybrid_search_<entity>` futur.

---

## 5. VectorIndex candidates (search_by_semantic à activer T2)

Tables corpus narratif où semantic search a une valeur immédiate :

| Table | Champ candidat | Workflow demandeur |
|---|---|---|
| briefingNotes | content | briefing-recall skill ("find decisions about X") |
| fixPatterns | description + rootCause | fix-pattern-cycle skill ("what fixed bug X") |
| components | description + brief | component-discover skill ("find skill about X") |
| diary | content | diary-discover skill ("what did sigma do on Day X") |
| issues | title + body | issue-triage skill ("find issue describing X") |

Recommandation T2 : choisir 2 priorités hautes (briefingNotes + diary) pour PR-1 ; reste en backlog.

---

## 6. Decisions ouvertes (escalation Pi / Eta)

1. **Episode wrappers** — créer `get_episode`/`list_episodes` comme façades sur memories type=episode, OU rester sur `get_memory`+filter ? Tilt recommendation : façades pour cohérence doctrine.
2. **VectorIndex add list** — quels corpus narratifs activer en T2 ? Recommendation : briefingNotes + diary first.
3. **Search_kw entités small-list** (bu, repo_mapping, profile, recurring_task) — N/A documenté ou activer pour symétrie ? Tilt : N/A documenté (5-30 entries, list suffit).
4. **Renaming hygiene** — `text_search` et `recall` ont une grosse base d'appel skills/CLAUDE.md fleet — accepter dual-emit ≥ 2 majeures avant deprecation ?

---

## 7. T2 PR plan (suggested split)

Le scope T2 est large — split en 4 PRs séquentielles pour gérer review + déploiement Convex :

| PR | Scope | Files | Estimated tools added |
|---|---|---|---|
| PR-A | Renames canoniques + alias retrocompat | tools.ts + convex/memories.ts + tests | 4 alias new + 0 net delta |
| PR-B | gap_deployment (`get_deployment` + `list_deployments`) + `list_mission_templates` | tools.ts + convex/monitoredDeployments.ts + convex/missionTemplates.ts + tests | 3 |
| PR-C | search_by_keyword cluster (13 entités MISSING en BM25 sur title/description) | tools.ts + convex helpers + tests | 13 |
| PR-D | vectorIndex + search_by_semantic (briefingNotes + diary first ; fix_patterns + components + issues en suiveur) | schema.ts vectorIndex + tools.ts + tests | 2 (PR-D1) + 3 (PR-D2) |

Mission-template-apply skill côté docs en T-DOC.

---

## 8. Refs

- Doctrine memory : `j57dhrmkzjerjtssnr0z9ba57n88n7q7` (namespace `global`, type `feedback`)
- CLAUDE.md fleet section : memory `j57a9h5r16g4b1yje6j2yqd4dd88nm5a` (namespace `global`, type `reference`)
- Mission : `k575kc1ryps0n8br95jw3q7d0x88m2v9`
- T0 doctrine : `k170zz0b71jy6fwgtmktpv90d188nge5`
- T1 audit (ce document) : `k17fy3wvdp44qn6mbdym3hrcex88nd3j`
- T2 implémentation : `k1735qk9kx6agjjyt3e38rdvvh88mk0p`
- npm vp-mcp@2.7.0 shasum `d95abb6852109004db939662706b3d72dbf8e4fc` (published Day 101 1148Z)
- Inventaire tools : `awk '/server\.tool\(/{getline; print}' mcp-server/src/tools.ts | grep -oE '"[a-z_]+"' | sort -u | wc -l` → 101 outils
- Inventaire entities : `grep -nE '^\s*[a-zA-Z_]+:\s*defineTable' convex/schema.ts` → 38 tables (18 customer-facing dans la matrice ci-dessus)

---

Orchestrator: Sigma — VantagePeers | 2026-06-14 — T1 deliverable
