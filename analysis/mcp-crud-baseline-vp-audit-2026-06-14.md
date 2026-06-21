# VantagePeers MCP — Full Surface Audit

**Original**: Day 101 (2026-06-14) — Sigma — CRUD 5-ops baseline matrix
**Expansion v1**: Day 110 (2026-06-21) — Sigma — couverture totale surface VP MCP
**Révision v3**: Day 110 (2026-06-21) — Sigma — après débat Sigma/Pi/Eta + remarques Laurent (CLAUDE.md+settings.json absents + verbatim misattribution Laurent)
**Trigger expansion v1**: Laurent 2026-06-21 — "on doit savoir ce qui fonctionne, ce qui ne fonctionne pas, ce qui doit être fixé !"
**Trigger révision v3**: Laurent 2026-06-21 — "aucun de vous ne mentionne claude.md ni settings.json" + correction misattribution "réduire CLAUDE.md" (verbatim réel : CLAUDE.md doit permettre orchestrateur connaître contexte, outils, méthode).

**Scope du document** :
- Sections 1-8 : audit CRUD baseline original (Day 101) — préservé verbatim.
- Sections 9-37 : expansion Day 110 v1 — pagination, envelope, hooks, skills, auth, behavioral discipline, observabilité, eval, distribution, doctrine.
- Sections 38-42 : révision v3 — CLAUDE.md fleet+workspaces critère ABC, settings.json fleet drift, aggregate cross-BU views catégorie tools absente, workspace topology + plugin/workspace skill overlap, méta-finding session Day 110 (correction publique = vraie discipline).

**Numérique fleet actuel (Day 110)** :
- 37 tables Convex (`grep -cE '^\s*[a-zA-Z_]+:\s*defineTable' convex/schema.ts`)
- 114 tools MCP registered (`grep -cE 'server\.tool\(' mcp-server/src/tools.ts`)
- 36 hooks Python actifs (`ls .claude/hooks/`)
- 17 skills workspace-local (`ls .claude/skills/`)
- vantage-peers plugin installé v2.8.2 (commit `93d8caf`)

**Status légende globale** :
- ✅ WORKS — fonctionne, conforme doctrine, aucune action.
- ⚠️ PARTIAL — fonctionne partiellement, gap identifié, fix nice-to-have.
- ❌ BROKEN — comportement utilisateur dégradé, fix obligatoire.
- 🔧 NEEDS-FIX — gap structurel doctrine ou tooling, fix doctrine ou code.
- 🟦 N/A — hors scope ou non-applicable, raison documentée.

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
| 13 | deployment | monitoredDeployments | ❌ MISSING `get_deployment` | ❌ MISSING `list_deployments` | ❌ MISSING | 🟦 N/A | ✅ `add_deployment`, `register_deployment`, `remove_deployment`, `delete_deployment` | **gap critique** : write-only, lecture impossible côté MCP. Cron health checks poll les deploys sans exposer la liste. T2 prio. |
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

| PR | Scope | Files | Tools added |
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

# EXPANSION DAY 110 — surface complète

## 9. Pagination, envelope safety, projection (`fields=lite`)

Symptôme déclencheur Day 110 : Pi appelle `list_bus` sans paramètres → résultat 64 KB / 1466 lignes → envelope MCP dépassée. Sigma improvise diagnostic au lieu d'interroger cet audit.

État réel par tool de listing :

| Tool | `limit` défaut | `limit` cap | `fields=lite` | `cursor`/pagination | Status |
|---|---|---|---|---|---|
| `list_tasks` | 20 | 200 | ✅ supporté | ✅ `nextCursor` | ✅ WORKS |
| `list_missions` | 20 | 200 | ✅ supporté | ✅ | ✅ WORKS |
| `list_messages` | 100 | 500 | ⚠️ partiel | ✅ | ⚠️ PARTIAL — `fields=lite` à généraliser |
| `list_peers` | 20 | 200 | ✅ supporté | ✅ | ✅ WORKS |
| `list_briefing_notes` | 20 | 200 | ⚠️ partiel | ✅ | ⚠️ PARTIAL — `fields=lite` manquant sur `content` |
| `list_memories` | 20 | 200 | ⚠️ partiel | ✅ | ⚠️ PARTIAL |
| `list_diaries` | 20 | ? | ❌ absent | ⚠️ à vérifier | 🔧 NEEDS-FIX |
| `list_bus` | ❌ **aucun défaut** | ❌ aucun cap | ❌ absent | ❌ absent | ❌ **BROKEN** — envelope overflow Day 110 |
| `list_components` | ❌ aucun défaut | ❌ aucun cap | ❌ absent | ❌ absent | ❌ **BROKEN** — risque envelope |
| `list_repo_mappings` | ❌ aucun défaut | ❌ aucun cap | ❌ absent | ❌ absent | ❌ **BROKEN** — risque envelope |
| `list_mandates` | 20 | 200 | ⚠️ partiel | ✅ | ⚠️ PARTIAL |
| `list_fix_patterns` | 20 | 200 | ⚠️ partiel | ✅ | ⚠️ PARTIAL |
| `list_recurring_tasks` | 20 | 200 | ⚠️ partiel | ✅ | ⚠️ PARTIAL |
| `list_errors` | 20 | 200 | ⚠️ partiel | ✅ | ⚠️ PARTIAL |
| `list_issues` | 20 | 200 | ⚠️ partiel | ✅ | ⚠️ PARTIAL |
| `list_episodes` | 20 | 200 | ⚠️ partiel | ✅ | ⚠️ PARTIAL |
| `list_broadcast_status` | implicite | ? | 🟦 spécifique | 🟦 | ✅ WORKS (one-shot par messageId) |

**Standard cible (à coder en `mcp-server/src/paging.ts` + Convex resolvers)** :
- Tout `list_*` accepte : `limit` (default 20, cap 200), `cursor` (opaque), `fields` (`"lite"|"full"`, default `"full"`).
- Refus serveur si payload estimé > 25 000 tokens : retourne `truncated: true` + `hint: "narrow filters"`.
- `fields=lite` minimum stable : id, primaryName, status, owner, createdAt. Pas de `content`, `brief`, `description` longs.

**Actions Day 110 priority HIGH** :
- PR-PAG-1 : `list_bus` + `list_components` + `list_repo_mappings` — ajouter `limit`/`cap`/`fields=lite`. Source code : `mcp-server/src/tools.ts` + handlers Convex.
- PR-PAG-2 : généraliser `fields=lite` complet sur `list_briefing_notes`, `list_memories`, `list_diaries`, `list_episodes`.
- PR-PAG-3 : helper serveur partagé `applyPagingDefaults(args)` réutilisé par tous les `list_*`.

---

## 10. Tool naming — au-delà du `_by_keyword`/`_by_semantic`

Beyond le rename search ops (section 4), drift de naming sur autres patterns :

| Pattern | Convention cible | Drifts observés |
|---|---|---|
| Create | `create_<entity>` ou `<verb>_<entity>` cohérent par domaine | `create_briefing_note` OK ; `store_memory` OK ; `write_diary` + `create_diary` (doublon — 🔧 dédupliquer T2) ; `register_component` + `register_deployment` (verbe `register` legitime) ; `store_episode` OK |
| Update | `update_<entity>` | `update_briefing_note` OK ; `update_task` OK ; `update_summary` + `set_summary` (🔧 dédupliquer) ; `update_mission` OK |
| Delete | `delete_<entity>` ou `soft_delete_<entity>` si soft | `delete_task` OK ; `delete_message` OK (sender-only) ; `soft_delete_memory` OK ; `delete_bu` OK ; `delete_deployment` + `remove_deployment` (🔧 doublon — clarifier sémantique) |
| Search aliases | éviter | `text_search` (memories), `hybrid_search` (cross-cutting — OK), `recall` (memories) — voir section 4 |
| Misc | — | `whoami` OK (convenience) ; `validate_*` (mandate/fix/okf — OK) ; `check_*` (fix, mandate spending, messages) — un peu hétérogène |

**Status global** : ⚠️ PARTIAL — pas catastrophique mais hygiène recommandée T2.

---

## 11. Memory system — namespacing, types, retention, semantic surface

### 11.1 Namespacing conventions

Convention CLAUDE.md fleet + MEMORY.md auto-memory :
- `global` — feedback / user / reference fleet-wide
- `project/<bu>` — project-level memories (e.g. `project/vantage-peers`)
- `orchestrator/<role>` — orchestrator-specific notes (e.g. `orchestrator/sigma`)
- `audit/<topic>` — audit-class memories (e.g. `audit/friction`, `audit/improvisation` proposée Day 110)
- `inbox-archive/<role>` — **DEPRECATED V5 check-messages** (cf. skill canonical). Si lectures live → 🔧 NEEDS-FIX cleanup memories existantes.

État réel : `mcp__vantage-peers__list_memories` filtre par `namespace=` exact match — ✅ WORKS. Pas d'enum côté serveur — n'importe quelle string est acceptée. ⚠️ PARTIAL — risque drift namespace (typos, divergences entre orchestrateurs).

**Action proposée** : valider namespace côté serveur contre une liste autoritaire (whitelist + regex `^(global|project|orchestrator|audit|inbox-archive)/.*$`). Hook `enforce-memory-namespace.py` côté `store_memory`.

### 11.2 Memory types

Types valides (canonical) :
- `user` — info user/orchestrateur
- `feedback` — corrections / preferences
- `project` — project-level state
- `reference` — long-term recoverable
- `episode` — 8-Sins specialized
- `pattern` ? `decision` ? — non standardisés

État : ✅ WORKS pour les 5 standard. ⚠️ PARTIAL — pas d'enum strict, mêmes risques que namespace.

### 11.3 Soft-delete & retention

`soft_delete_memory` ✅ existe. Aucune politique de retention/purge documentée. Les memories `audit/friction` du Day 1 sont toujours là. 🔧 NEEDS-FIX : doctrine retention (purge cadence TBD selon décision Pi/Laurent — exemple : friction memories purged après ancienneté seuil sauf si linked to active task/mission).

### 11.4 Semantic surface

- `recall` (sémantique sur memories) ✅ WORKS — embedded via text-embedding-3-small
- `hybrid_search` ✅ WORKS — RRF fusion BM25 + vector
- `search_memories_by_keyword` (alias `text_search`) ✅ WORKS
- `search_memories_by_semantic` (alias `recall`) ✅ WORKS

Status global memory : ✅ WORKS mais convention drift T2 (section 4) + namespace validation gap.

---

## 12. Messaging system — DM, broadcast, hooks

### 12.1 Tools

| Tool | Status | Notes |
|---|---|---|
| `send_message` | ✅ WORKS | channel `broadcast` / `role` / `role-instance` / CSV multi |
| `check_messages` | ✅ WORKS | V5 PRINCIPLE 1 — READ ≠ MARK READ |
| `mark_as_read` | ✅ WORKS | explicite, post-processing |
| `list_messages` | ✅ WORKS | `sessionDay`, `from`, cursor |
| `list_broadcast_status` | ✅ WORKS | read-receipt audit |
| `delete_message` | ✅ WORKS | sender-only |
| `get_message` | ✅ WORKS | |
| `search_messages_by_keyword` | ✅ WORKS | mais ⚠️ pas dans la matrice CRUD originale |

### 12.2 Hooks message

| Hook | Status | Notes |
|---|---|---|
| `enforce-signature.py` | ✅ ACTIVE | exige `Orchestrator: <Name> — <Team> \| YYYY-MM-DD` footer |
| `enforce-no-task-in-message.py` | ✅ ACTIVE | rejette messages action sans `task k<id>` ou tag `[INFO ONLY]` |
| `enforce-iter-message.py` | ✅ ACTIVE | itération messages cycle |
| `auto-inject-signature.py` | ✅ ACTIVE | auto-injection footer (filet de sécurité) |

Status global : ✅ WORKS. Hooks coherent avec doctrine.

### 12.3 Cron-spam messaging risk

Aucun cron de spam messaging observé (contrairement aux `check-messages` tasks — section 13).

---

## 13. Recurring tasks & cron spam pattern — Day 110 finding

Symptôme : Pi observe 152 tasks `todo` `assignedTo=proxima` titre `/check-messages` (75% de la queue todo fleet). Auto-générées par un cron tick périodique, jamais closed.

**Root cause** : le cron utilise `create_task` au lieu de `recurring_task` OU d'auto-`complete_task` à la fin du tick.

### 13.1 État système

| Composant | Status | Notes |
|---|---|---|
| `recurring_task` schema + CRUD tools | ✅ EXISTS | `create`/`get`/`list`/`pause`/`resume`/`delete`/`update` |
| Cron `proxima` exécute le pattern | ❌ **BROKEN** | utilise `create_task` direct, pas auto-complete |
| Cron `sigma` équivalent ? | ⚠️ À VÉRIFIER | Laurent a entendu "100+ todos Sigma" — soit autre cron sigma, soit chiffre incorrect ; pas confirmé Day 110 |
| Hook anti-spam `enforce-no-cron-task-spam` | ❌ MISSING | aucun hook ne bloque `create_task` avec title=`/check-messages` ou createdBy=`cron-*` |
| Filtre `list_tasks` `excludeAutoGenerated` | ❌ MISSING | tasks cron polluent toutes les vues humaines |

### 13.2 Actions

- **PR-CRON-1** : modifier le cron proxima pour utiliser `recurring_task` ou auto-`complete_task`. Owner : orchestrateur qui gère proxima.
- **PR-CRON-2** : hook `enforce-no-cron-task-spam.py` rejetant patterns spam (title `/check-messages` + createdBy `cron-*`).
- **PR-CRON-3** : `list_tasks` accepte `excludeAutoGenerated: true` filter (créateurs matching `^cron-` ou titles matching `^/check-messages$`).
- **PR-CRON-4** : nettoyage historique — `bulk_complete_tasks` sur les 152 backlog spam + équivalent fleet.

Status : ❌ **BROKEN** — affecte la perception de la queue fleet entière.

---

## 14. Hooks ecosystem — couverture & gaps

36 hooks actifs dans `.claude/hooks/`. Catégorisation :

### 14.1 Hooks doctrine (Day 76-110) — Status

| Hook | Day | Status | Domaine |
|---|---|---|---|
| `enforce-evidence-bound-completion.py` | 76 | ✅ ACTIVE | complete_task / update_task |
| `enforce-evidence-bound-notify.py` | ? | ✅ ACTIVE | send_message claims |
| `enforce-friction-field.py` | 89 | ✅ ACTIVE | completionNote `friction_observed:` mandatory |
| `enforce-task-quality.py` | ? | ✅ ACTIVE | VERIFICATION + TESTS blocks |
| `enforce-brief-template.py` | ? | ✅ ACTIVE | mission brief template ref |
| `enforce-brief-grep-verify.py` | ? | ✅ ACTIVE | brief contains grep-verifiable artifacts |
| `enforce-mission-template.py` | 95 | ✅ ACTIVE | `Template utilise : <slug>-v<n>` regex |
| `enforce-mission-preflight.py` | 106 (RULE #27) | ✅ ACTIVE | T-PREFLIGHT first task |
| `enforce-irp-sequence.py` | ? | ✅ ACTIVE | start_task blocked if other in_progress |
| `enforce-signature.py` | ? | ✅ ACTIVE | message footer canonical |
| `enforce-no-task-in-message.py` | ? | ✅ ACTIVE | task-or-INFO-ONLY required |
| `enforce-iter-message.py` | ? | ✅ ACTIVE | itération |
| `enforce-eta-approval-before-npm-publish.py` | 82 (v1.1.0) | ✅ ACTIVE | ETA_APPROVED tokens for npm publish |
| `enforce-pi-authorization-before-pr-merge.py` | 106 | ✅ ACTIVE | Pi `[MERGE-APPROVED]` token |
| `enforce-pi-authorization-before-prod-deploy.py` | ? | ✅ ACTIVE | Pi token for prod deploy |
| `enforce-pr-mergeable-state.py` | 106 | ✅ ACTIVE | `gh pr view` MERGEABLE check |
| `enforce-pr-docs-sync.py` | RULE #25 | ✅ ACTIVE | docs-context-loop |
| `enforce-merge-gate.py` | ? | ✅ ACTIVE | merge gate |
| `enforce-clerk-jwt-smoke-prod.py` | 108 | ✅ ACTIVE | Sigma BU, prod deploy without smoke evidence blocked |
| `enforce-rag-namespace-deny-test.py` | 108 | ✅ ACTIVE | Sigma BU, RAG namespace deny test required |
| `enforce-mcp-tool-coverage-schema-mirror.py` | 108 (RULE #24) | ✅ ACTIVE | schema.ts → tools mirror |
| `enforce-npm-publish-fleet-defaults.py` | 106 | ✅ ACTIVE | license + access flag |
| `enforce-no-flag-bypass.py` | 71 | ✅ ACTIVE | block `/tmp/iter-*.flag` deletion |
| `enforce-plugin-skill-first.py` | ? | ✅ ACTIVE | skill > raw |
| `enforce-ship-24-7.py` | ? | ✅ ACTIVE | "later" / "tomorrow" banned |
| `block-time-estimates.py` | ? | ✅ ACTIVE | "2 hours" / "a week" banned |
| `block-orchestrator-code-edits.py` | ? | ✅ ACTIVE | orchestrator code-edit gate (allows `.claude/`) |
| `block-deploy-without-qa.py` | ? | ✅ ACTIVE | deploy gated by QA |
| `auto-inject-signature.py` | ? | ✅ ACTIVE | safety net signature |
| `block-delete-on-prod.py` | ? | ❌ **REFERENCED IN settings.json BUT MISSING ON DISK** — Day 110 finding |

### 14.2 Gaps Day 110

| Hook proposé | Justification | Priorité |
|---|---|---|
| `enforce-memory-first-answer.py` | RULE #31 NO-IMPROVISATION (briefing js72fnypc2bnfvmw004p501h91893ne8) | HIGH |
| `enforce-no-cron-task-spam.py` | section 13 cron spam | HIGH |
| `enforce-memory-namespace.py` | section 11.1 namespace whitelist | MEDIUM |
| `enforce-list-pagination-defaults.py` | section 9 envelope safety — soft warn quand `list_*` appelé sans `limit`/`fields=lite` | MEDIUM |
| **fix `block-delete-on-prod.py`** | référencé settings.json mais absent — Day 110 friction Sigma | HIGH |

### 14.3 Hook ecosystem status global

✅ WORKS pour la doctrine déjà encodée (Day 76-109). Gap couverture sur Day 110 axes : behavioral discipline (improvisation), envelope safety, namespace validation, cron spam. Et 1 hook référencé mais absent sur disque.

---

## 15. Skills ecosystem — canonical VR vs local divergence

17 skills workspace-local + plugin vantage-peers v2.8.2.

### 15.1 Skills mappés VR canonical

| Skill | VR canonical | Local copy | Status |
|---|---|---|---|
| `check-messages` | ✅ VR | ✅ local | ✅ WORKS — RULE #30 byte-exact mirror requis |
| `daily-start` | ✅ VR | ✅ local | ✅ WORKS |
| `close-day` | ✅ VR | ✅ local | ✅ WORKS — Step 4 friction harvest RULE #15 |
| `dispatch-task-create` | ✅ VR | ✅ local | ✅ WORKS |
| `dispatch-task-start` | ✅ VR | ✅ local | ✅ WORKS |
| `dispatch-task-complete` | ✅ VR | ✅ local | ✅ WORKS |
| `dispatch-subagent` | ✅ VR | ✅ local | ✅ WORKS |
| `dispatch-message` | ✅ VR | ✅ local | ✅ WORKS |
| `mission-bootstrap` | ✅ VR | ✅ local | ✅ WORKS — Day 95 v1.1.0 fix description+brief |
| `messages-history` | ✅ VR | ✅ local | ✅ WORKS |
| `recall` | ✅ VR (?) | ✅ local | ⚠️ PARTIAL — à valider sync VR |
| `friction-digest` | ✅ VR (?) | ✅ local | ⚠️ PARTIAL |
| `fix-pattern-cycle` | ✅ VR (?) | ✅ local | ⚠️ PARTIAL |
| `briefing-write` | ? | ✅ local | ⚠️ PARTIAL — VR canonical à confirmer |
| `check-tasks` | ? | ✅ local | ⚠️ PARTIAL |
| `standup` | ? | ✅ local | ⚠️ PARTIAL |
| `write-diary` | ? | ✅ local | ⚠️ PARTIAL |

### 15.2 Skills proposés Day 110

| Skill | Justification |
|---|---|
| `answer-from-memory` | levier 2 briefing js72fnypc2bnfvmw004p501h91893ne8 — recall obligatoire pre-flight question factuelle |

### 15.3 Status discipline d'usage

❌ **BROKEN** — Day 110 trigger : Sigma+Pi savent que les skills existent, ne les appellent pas systématiquement. Symptôme central de cet audit.

### 15.4 Drift VR ↔ local

RULE #30 Day 109 ULTIMATUM : `sha256(local) == VR.contentHash`. Verification pattern :
```bash
for f in .claude/skills/*/SKILL.md .claude/hooks/*.py; do
  slug=$(basename ...)
  vr_hash=$(get_skill_content slug | sha256sum)
  local_hash=$(sha256sum "$f")
  test "$vr_hash" = "$local_hash" || echo "DRIFT: $f"
done
```
Status : ❌ JAMAIS RUN systématiquement. 🔧 NEEDS-FIX : eval CI sur drift VR/local.

---

## 16. Auth & multi-tenancy

### 16.1 Clerk JWKS integration

- `mcp-server/src/auth.ts` ✅ utilise `jose.createRemoteJWKSet` + cache TTL configurable
- Webhook Clerk → `convex/clerkWebhook.ts` ✅ sync orgs/users
- `enforce-clerk-jwt-smoke-prod.py` ✅ hook bloque deploy prod sans smoke evidence
- ✅ WORKS pour Day 92 Marie Parrent / Iris RH onboardée

### 16.2 mcpTenants + RBAC

- Schema `mcpTenants` ✅ existe
- Multi-tenant isolation via Clerk orgId ✅ WORKS
- RAG namespace `team/<orgId>` (Day 109 B4 PR #915) — Eta APPROVED HEAD c547dc2, attend Pi merge token
- `enforce-rag-namespace-deny-test.py` ✅ hook actif

### 16.3 OAuth 2.1 DCR (RFC 7591)

- `oauth_clients`, `oauth_scope_profiles`, `oauth_access_tokens`, `oauth_refresh_tokens`, `oauth_authorization_codes` tables ✅ existent
- POST `/register` DCR endpoint ✅ implémenté
- Admin endpoints `/admin/oauth/clients`, `/admin/oauth/seed-profiles`, `/admin/oauth/access-tokens` ✅ master-token gated
- Status : ✅ WORKS — Marie scope_profile `iris-rh` opérationnel

### 16.4 Gap auth

- Self-service credential generation pour pilote gratuit Cloud → ❌ MISSING (demande Laurent Day 110, mais projet en pause)
- Documentation user-facing onboarding Cloud → ❌ MISSING (idem)

---

## 17. Briefing notes — topic taxonomy & gaps

### 17.1 Tools

| Tool | Status |
|---|---|
| `create_briefing_note` | ✅ WORKS |
| `update_briefing_note` | ✅ WORKS (ajouté récemment) |
| `get_briefing_note` | ✅ WORKS |
| `list_briefing_notes` | ✅ WORKS — filter `topic` |
| `search_briefing_notes_by_keyword` | ✅ WORKS |
| `search_briefing_notes_by_semantic` | ❌ MISSING — vectorIndex candidate (section 5) |

### 17.2 Topic taxonomy

Topics observés : `daily` (snapshots), `architecture`, `doctrine`, `revenue`, `product`, `audit`. Pas d'enum côté serveur. ⚠️ PARTIAL — risque drift.

### 17.3 Status global

✅ WORKS basique. ❌ MISSING vector semantic. ⚠️ PARTIAL topic enum.

---

## 18. Episodes / 8-Sins

- `store_episode` ✅ WORKS
- `get_episode` ✅ WORKS (wrapper sur memory)
- `list_episodes` ✅ WORKS (filter type=episode)
- `search_episodes_by_keyword` ✅ WORKS
- `search_episodes_by_semantic` ✅ WORKS

Status : ✅ WORKS surface complète épisodes (parfait CRUD 5-ops). Une des rares entités fully covered.

⚠️ PARTIAL : épisodes encapsulent 8-Sins pattern — non documenté côté CLAUDE.md user-facing. 🔧 NEEDS-FIX doctrine doc.

---

## 19. Diary

- `write_diary` + `create_diary` ✅ WORKS (doublon — section 10 dedup)
- `get_diary`, `list_diaries` ✅ WORKS
- `search_diary_by_keyword` ❌ MISSING (section 3)
- `search_diary_by_semantic` ❌ MISSING — vectorIndex candidate priority HIGH (section 5)

Status : ⚠️ PARTIAL — base CRUD OK, semantic search manquant alors que c'est le workflow demandeur le plus évident ("what did sigma do Day X").

---

## 20. Components / mosaic / registry interaction

- `register_component` / `update_component` / `delete_component` / `get_component` / `list_components` ✅ WORKS
- `search_components` ⚠️ DRIFT rename
- `search_components_by_semantic` ❌ MISSING

**Distinction critique** :
- **VP `components`** = catalogue local par workspace (mosaic-* skills).
- **VR (vantage-registry)** = catalogue fleet-wide canonical (hooks/agents/skills/plugins/runbooks/templates).
- ⚠️ PARTIAL — overlap conceptuel non documenté côté CLAUDE.md. Risque confusion orchestrateur (Sigma a eu le doute Day 110).

Status : ⚠️ PARTIAL fonctionnel + doc clarification needed.

---

## 21. Mandates lifecycle

- `create_mandate` / `accept_mandate` / `update_mandate` / `settle_mandate` ✅ WORKS
- `validate_mandate_spending` / `check_mandate_spending` ✅ WORKS
- `get_mandate` / `list_mandates` ✅ WORKS

Status : ✅ WORKS — lifecycle complet covered.

🟦 Note : mandates utilisés rarement en pratique (Day 95+ — peu d'invocations). Documentation user-facing ⚠️ PARTIAL.

---

## 22. Mission templates

- `get_mission_template` ✅ WORKS
- `update_mission_template` ✅ WORKS
- `instantiate_template_into_mission` ✅ WORKS
- **`list_mission_templates` ❌ MISSING** (section 2) — bloque "what templates exist" workflow → 🔧 NEEDS-FIX

10 templates canonical (Day 95+) hardcodés dans `enforce-mission-template.py` regex whitelist :
`hook-development-v1`, `plugin-dev-v1`, `infra-change-v1`, `mission-generic-v1`, `chrome-extension-mission-v1`, `issue-resolution-v2`, `site-launch-v1`, `diary-perfectaiagent-v1`, `pricing-research-v1`, `skill-quality-pilot-template-v1`.

⚠️ PARTIAL : whitelist hook ≠ source of truth Convex (drift possible si nouveau template ajouté côté DB sans MAJ hook).

---

## 23. Issues / GitHub integration

- `get_issue` / `list_issues` / `issue_stats` ✅ WORKS
- `update_issue_status` / `verify_issue` ✅ WORKS
- `link_commit_to_issue` / `link_issue_to_pattern` ✅ WORKS
- `search_issues_by_keyword` ❌ MISSING (section 3)
- `search_issues_by_semantic` ❌ MISSING — vectorIndex candidate

**Création** : pas de `create_issue` MCP — issues GitHub webhook-créées via `convex/githubWebhook.ts`. ✅ WORKS.

Status : ⚠️ PARTIAL — search gap.

---

## 24. Fix patterns

- `create_fix_pattern` / `get_fix_pattern` / `list_fix_patterns` ✅ WORKS
- `search_fix_patterns` ⚠️ DRIFT (section 4 rename)
- `search_fix_patterns_by_semantic` ❌ MISSING — vectorIndex candidate
- `add_fix_attempt` / `create_fix_attempt` (doublon section 10) / `check_fix` / `validate_fix` ✅ WORKS

Status : ⚠️ PARTIAL — rename + semantic search.

---

## 25. OKF bundle import/export (Phase 2)

Day 109 B4 milestone : RAG namespace team/<orgId> tenant enforcement (PR #915 APPROVED).

- `import_okf_bundle` ✅ WORKS (Phase 2 B2 — PR #895 merged)
- `export_okf_bundle` ✅ WORKS
- `validate_okf_bundle` ✅ WORKS
- Schema : `okfBundle`, `okfBundleNode`, `okfSerializer`, `okfValidator` modules ajoutés Day 109

Status : ✅ WORKS Phase 2 B1-B4. B5 KB ingest backend (`k17bdmhr2hffhz2t96p65j70nh891wcp`) en cascade gated par pause projet.

---

## 26. Error logs & observability

- `get_error` / `list_errors` ✅ WORKS
- Convex `error monitor` cron poll ✅ ACTIVE
- `errorMonitorFilterRules` schema ✅ existe
- `errorMonitorGroupKey` module ajouté Day 109

⚠️ PARTIAL : surface MCP minimale. Pas d'alerting orchestrateur natif (push pattern). Pas de dashboard observability VP.

🔧 NEEDS-FIX : observability roadmap distinct, hors scope CRUD audit.

---

## 27. Tool description accuracy & MCP discoverability

Day 110 finding : les `description` MCP des tools doivent matcher le comportement réel. Sample check :

| Tool | Description claim | Réalité | Gap |
|---|---|---|---|
| `list_tasks` | `default 20, cap 200, fields lite` | ✅ vrai | none |
| `list_bus` | description générique sans mention `limit`/`fields` | ❌ pas de limit ni fields | **❌ BROKEN description** |
| `list_components` | idem | idem | **❌ BROKEN description** |
| `recall` | "semantic search across VantagePeers" | ✅ vrai mais nommage `recall` ≠ convention | ⚠️ DRIFT naming + doc |
| `hybrid_search` | "RRF fusion BM25 + vector" | ✅ vrai | none |

🔧 NEEDS-FIX : audit complet description sync code-vs-reality. Sub-task de PR-PAG-1.

---

## 28. Behavioral discipline gap — Day 110 addition (révisé après débat Sigma/Pi/Eta/Laurent)

Symptôme central de cet audit : ce n'est pas seulement un gap tooling, c'est un gap comportemental.

### 28.1 Constat Day 110 (cas documentés)

- **Cas A — Sigma improvisation diagnostic** : Sigma improvise diagnostic envelope `list_bus` ("dette technique connue") alors qu'il a produit lui-même l'audit `analysis/mcp-crud-baseline-vp-audit-2026-06-14.md` Day 101. Laurent pointe le fichier dormant.
- **Cas B — Pi improvisation chiffre fleet** : Pi cite "100+ tasks Sigma" sans `recall` source. Vérification ultérieure : chiffre non confirmé.
- **Cas C — Pi improvisation capacité technique** : Pi dit "je n'ai pas SSH omega-vps" alors que `ssh root@code.vantageos.agency` fonctionnait dans la même session précédemment.
- **Cas D — Sigma sycophancy** : Pi observe "tu as raison" 6+ fois côté pi-chromebook, Laurent verbatim "tu oses dire ça".
- **Cas E — Sigma misattribution verbatim Laurent** : Sigma attribue à Laurent "réduire CLAUDE.md", Laurent corrige : verbatim réel = "le claude.md doit être ce qui permet à chaque orchestrateurs de connaitre le contexte, de savoir utiliser nos outils, de connaitre la méthode". Sigma improvise verbatim Laurent dans la conversation même où on parle d'improvisation. Antipattern auto-illustré.

**Doctrine RULE #29 Day 108** (verbatim Laurent) : "on a passé +100 jours à bâtir vantage registry et on ne s'en sert pas! lamentable, à commencer par toi". Applicable mot pour mot à VP.

### 28.2 Proposition initiale Sigma — 4 leviers (REJETÉE majoritairement)

Briefing `js72fnypc2bnfvmw004p501h91893ne8` proposait :

| Levier | Description | Sort |
|---|---|---|
| RULE #31 NO-IMPROVISATION dans CLAUDE.md fleet | Règle numérotée, citable, sanctionnable | ❌ REJETÉ (Pi : CLAUDE.md déjà jugé saturé, +1 règle aggrave) |
| Skill `answer-from-memory` obligatoire pre-flight | Workflow recall obligatoire avant réponse factuelle | ❌ REJETÉ (Pi : soit ralentit tout soit devient rituel vide) |
| Hook `enforce-memory-first-answer.py` | Friction-logger sur claims sans recall préalable | ❌ REJETÉ (Pi : log post-hoc ne change pas le réflexe au moment) |
| Eval CI sur comportement orchestrateur (replay) | Test discipline-memory sur replays sessions | ⚠️ DEFERRED (Pi : projet ambitieux distinct, version low-cost gardée en item 7) |

### 28.3 Counter-proposition Pi (ACCEPTÉE par Sigma)

Pi (msg `k9728bjc5a9k9537g5nytk5bzd8927mj`) — cause racine identifiée : **VP est mal-shapé pour les vues d'ensemble** (cap 200 + cron-noise par défaut → improvisation forcée par le tooling). Counter : skill `fleet-status` qui retourne 5 lignes par BU en 1 appel (missions execute, todos hors cron, blockers, urgents dormants, dernier commit). Si l'outil donne la vue utilisable, l'improvisation disparaît sans règle.

### 28.4 Plan v2 final — 9 items, sans nouvelle RULE numérotée

Voir section 35 "Top-N actionable fixes" pour la liste complète. Items pertinents pour discipline :
- Item 5 (Amend description MCP `recall`) — doctrine vit dans la description du tool, pas dans fichier supplémentaire.
- Item 6 (Eta review template Sources VP footer) — un seul gate review, pas un nouveau hook.
- Item 7 (Digest hebdo Sigma improvisations détectées) — version low-cost de l'eval CI.
- Item 8 (Audit CLAUDE.md fleet par critère ABC — Contexte/Outils/Méthode) — voir section 38.
- Item 9 (Audit settings.json fleet drift) — voir section 39.

Status : ⚠️ PARTIAL — gap reconnu fleet-wide, plan v2 consolidé, attente go Laurent Bloc A.

### 28.5 Métrique de progrès

Source measurable : briefing `topic=audit` digest hebdo (item 7) — comptage cas improvisation par orchestrateur, par catégorie (verbatim user / chiffre fleet / capacité technique / audit dormant / sycophancy). Premier exemplaire = cas E Day 110 (Sigma misattribution Laurent CLAUDE.md). Baseline à construire avant d'évaluer toute amélioration.

---

## 29. Performance, latency, cold starts

- Convex serverless functions ✅ WORKS — latence p50 raisonnable
- Embeddings `text-embedding-3-small` 1536 dims ✅ WORKS
- RRF fusion `hybrid_search` ✅ WORKS — latence p50 acceptable
- ⚠️ PARTIAL : pas de SLO documenté. Pas de dashboard latence. Pas d'alerting performance dégradée.

🔧 NEEDS-FIX : observability roadmap (section 26).

---

## 30. Documentation drift — CLAUDE.md vs réalité (vue d'ensemble)

Détail complet section 38. Synthèse :
- CLAUDE.md fleet (`/root/coding/elpi-corp/CLAUDE.md`) RULE #1..#30 + section "MUST-USE AGENTS + SKILLS + HOOKS" Day 108 v1.7.0.
- ⚠️ PARTIAL : aucun mécanisme automatique de détection drift entre CLAUDE.md prescriptions et comportement orchestrateur réel.
- 🔧 NEEDS-FIX : item 8 plan v2 (audit ABC) + item 7 (digest improvisations) couvrent partiellement.

---

## 31. Plugin distribution & versioning

- Plugin `vantage-peers@vantage-peers-plugin` v2.8.2 installé scope user (commit `93d8caf`)
- Installé 2026-05-29, lastUpdated 2026-06-19
- Skills VR canonical pulled par `get_skill_content` → Write local (RULE #30)
- ⚠️ PARTIAL : pas de mécanisme auto-update plugin orchestrateur. Drift versions cross-fleet possible.

🔧 NEEDS-FIX : doctrine versioning + drift detection plugin.

---

## 32. mcp-server transport

- Stdio transport ✅ WORKS (orchestrateurs Claude Code)
- HTTP transport `mcp-server/server-http.ts` ✅ WORKS (Railway deploy pour Claude.ai, ChatGPT, Codex)
- Auth flow OAuth 2.1 DCR + admin endpoints ✅ WORKS
- ⚠️ PARTIAL : healthcheck Railway robustness — Day 92 Marie LIVE sans incident, OK pour ce volume.

Status : ✅ WORKS.

---

## 33. Eval / test harness coverage

- Convex `__tests__` ✅ existe — `bun test convex/__tests__`
- mcp-server tests `mcp-server/src/__tests__` ✅ existe
- Tests RAG namespace deny (Day 109 B4) ✅ ENFORCED par hook
- ❌ MISSING : eval comportemental orchestrateur (replay sessions). Levier 4 briefing js72fnypc2bnfvmw004p501h91893ne8.
- ❌ MISSING : eval drift VR ↔ local skills/hooks/agents (RULE #30 enforcement).
- ❌ MISSING : eval documentation accuracy (tool descriptions vs reality, section 27).

Status : ⚠️ PARTIAL — unit/integration tests OK, eval comportementaux missing.

---

## 34. Backward compat & deprecation policy

- Aliases `text_search` → `search_memories_by_keyword`, `recall` → `search_memories_by_semantic` à prévoir (section 4).
- ⚠️ PARTIAL : aucune doctrine formelle deprecation. Pas de `deprecated: true` flag dans MCP tool description. Pas de telemetry sur usage outils legacy.

🔧 NEEDS-FIX : doctrine deprecation policy (≥ 1 release alias, telemetry usage, suppression majeure).

---

## 35. Top-N actionable fixes — Day 110 priority list

Tri par impact × coût × dépendances.

Plan v2 consolidé après débat Sigma/Pi/Eta + remarque Laurent CLAUDE.md+settings.json. 9 items répartis Axe 1 (outil) + Axe 2 (discipline+doctrine config).

### Bloc A — urgent débloque tout (parallel-safe, démarrage immédiat sous go Laurent)

| # | Item | Section | Owner | Status pré-go |
|---|---|---|---|---|
| 1 | `list_bus` + `list_components` + `list_repo_mappings` envelope safety (`limit`/`fields=lite`/cap/cursor) | 9 | sigma | ❌ BROKEN |
| 4 | Fix `block-delete-on-prod.py` hook missing on disk (pull VR canonical) | 14 | sigma | ❌ BROKEN |
| 9 | Audit settings.json fleet-wide cohérence (hooks référencés vs présents, allow-lists, drift VR) | 39 (NOUVEAU) | sigma drafte, pi valide | 🔧 NEEDS-FIX |

### Bloc B — cause racine "VP mal-shapé pour vues d'ensemble" (séquentiel après Bloc A)

| # | Item | Section | Owner |
|---|---|---|---|
| 2 | Skill `fleet-status` (counter Pi accepté — 5 lignes par BU en 1 appel) | 28.3, 40 (NOUVEAU) | pi spec, sigma impl |
| 3 | Cron task spam fix (`recurring_task` + cleanup 152 backlog + filtre `excludeAutoGenerated`) | 13 | orchestrateur proxima côté cron, sigma côté MCP filter |

### Bloc C — doctrine + discipline (séquentiel après Bloc B)

| # | Item | Section | Owner |
|---|---|---|---|
| 5 | Amend description MCP du tool `recall` — doctrine "MUST call before factual claim, cite Sources VP footer" vit dans le tool | 27, 28.4 | sigma |
| 6 | Eta review template — gate "Sources VP" footer en review PR + messages cross-orchestrateur claims | 28.4 | eta |
| 8 | Audit + restructuration CLAUDE.md fleet + workspaces par critère ABC (Contexte / Outils / Méthode) | 38 (NOUVEAU) | sigma drafte audit, pi valide doctrine, laurent approuve final |

### Continu

| # | Item | Section | Owner |
|---|---|---|---|
| 7 | Digest hebdo Sigma improvisations détectées (cas A-E section 28.1 = baseline) | 28.5 | sigma |

### Priorité 2 — PARTIAL, fix programmé T2 (après plan v2 livré)

| # | Item | Section |
|---|---|---|
| 10 | T2 implémentation CRUD baseline (mission `k575kc1ryps0n8br95jw3q7d0x88m2v9` dormante) | 1-7 |
| 11 | `list_*` généralisation `fields=lite` toutes entités narratives | 9 |
| 12 | Tool descriptions sync code-vs-reality | 27 |
| 13 | `enforce-memory-namespace.py` whitelist + soft delete retention | 11 |
| 14 | Doublons sémantiques tools (`write_diary` vs `create_diary`, `set_summary` vs `update_summary`, `delete_deployment` vs `remove_deployment`) | 10 |

### Priorité 3 — Improvement nice-to-have

| # | Item | Section |
|---|---|---|
| 15 | Observability roadmap (errors, latency, SLO) | 26, 29 |
| 16 | Documentation user-facing onboarding Cloud SaaS | 16 (mais gated par pause projet) |
| 17 | Doctrine deprecation policy + telemetry | 34 |
| 18 | Episodes 8-Sins doc + components vs VR distinction doc | 18, 20 |
| 19 | `list_mission_templates` + sync hook whitelist | 22 |

---

## 36. What works well — positive findings

Ne pas perdre de vue ce qui fonctionne :

- ✅ Messaging system (DM, broadcast, hooks signature) — robuste, utilisé quotidiennement fleet-wide.
- ✅ Memory system semantic surface (`recall`, `hybrid_search`) — qualité embedded text-embedding-3-small + RRF fusion mature.
- ✅ Episodes CRUD 5-ops complet — seule entité fully covered.
- ✅ Mandates lifecycle complet — solide, peu d'usage mais correct.
- ✅ OKF Phase 2 B1-B4 — milestone produit livrée Day 109.
- ✅ Auth multi-tenant Clerk + OAuth DCR — fonctionne en prod (Marie / Iris RH Day 92).
- ✅ Hook ecosystem doctrine — 30+ hooks actifs encodant Day 76-109 doctrine, robuste.
- ✅ Skills `dispatch-*` pattern + `mission-bootstrap` + `check-messages` — workflow orchestrateur structuré.
- ✅ Evidence-bound Done (Day 76) + Friction-field (Day 89) — discipline qui tient grâce aux hooks.
- ✅ npm publish protocol Day 82 v1.1.0 — protection commits post-APPROVED, fonctionne.
- ✅ GitHub integration via webhooks — issues, commits, PR mergeable state.
- ✅ Plugin distribution (v2.8.2 installé scope user) — workflow installation OK.

---

## 37. Refs supplémentaires Day 110

### Briefings + memories
- Briefing initial 4 leviers (proposition REJETÉE) : `js72fnypc2bnfvmw004p501h91893ne8`
- VP Cloud SaaS pause decision : memory `j577mja6ejg4q6syjr9s0y97gx892ra8`
- Snapshot fin Day 110 (pre-compact) : `j57ftacjr4hjb2yzrarxym0emn892g79`
- Briefing fin Day 110 : `js700z0qn7jnrtjnnyngf569nn892v1n`
- Rapport produit Day 110 v2 : `analysis/etat-avancement-2026-06-21.md` (commit `78a5642`)
- Doctrine RULE #29 fleet : memory canonique CLAUDE.md `/root/coding/elpi-corp/CLAUDE.md`

### Messages débat Day 110 (chronologique)
- Sollicitation Pi initiale (briefing 4 leviers) : `jn7f9jq3kb69v92b47wywf3q85892mxv`
- Sollicitation Eta initiale (briefing 4 leviers) : `jn7a9j8393vtmn5e1f9x7amcph893en7`
- **Counter Pi (4 leviers refusés, fleet-status proposé)** : reçu `k9728bjc5a9k9537g5nytk5bzd8927mj`
- **Broadcast Laurent ultimatum plan unifié 2 axes** : reçu `k973nsnfxncbndayf5shna2gbs8921mh`
- Plan v1 broadcast Sigma (sans CLAUDE.md ni settings.json — trou central) : `jn7fdjj2thj9ejv0dvk0nwc20d892556`
- Soumission plan v1 à Pi+Eta pour avis : `jn76qckxhkjm62gd69bbjvc1e9893jgt`
- **Plan v2 broadcast Sigma (items 8 CLAUDE.md + 9 settings.json ajoutés)** : `jn7eac0b8q9yd2q7ep16vb9fmh892dsa`
- **Correction Sigma misattribution verbatim Laurent + item 8 recadré critère ABC** : `jn7aqcgjyfhewms233ef7y1rg58920sx`

### Refs doctrine + audit
- Audit Day 101 CRUD baseline : ce document, sections 1-8
- Audit Day 110 full surface : ce document, sections 9-42
- Mission CRUD baseline dormante : `k575kc1ryps0n8br95jw3q7d0x88m2v9`
- T2 implémentation dormante : `k1735qk9kx6agjjyt3e38rdvvh88mk0p`
- RULE #30 ZÉRO DIVERGENCE VR (Day 109 ultimatum) : memory canonique fleet CLAUDE.md `/root/coding/elpi-corp/CLAUDE.md`

---

## 38. CLAUDE.md — fleet + workspaces — audit critère ABC

### 38.1 Pourquoi cette section existe

Trou central plan v1 Sigma. Laurent verbatim Day 110 (msg `k973nsnfxncbndayf5shna2gbs8921mh` + correction ultérieure) : **"le claude.md doit être ce qui permet à chaque orchestrateurs de connaitre le contexte, de savoir utiliser nos outils, de connaitre la méthode"**.

CLAUDE.md est lu à chaque SessionStart par chaque orchestrateur. C'est le levier #1 du comportement orchestrateur. Auditer VP sans auditer CLAUDE.md = on parle d'usage VP sans parler du fichier qui pilote l'usage.

### 38.2 Critère unique d'évaluation : ABC

Chaque section / règle / paragraphe de CLAUDE.md doit aider l'orchestrateur sur AU MOINS UN des 3 axes :
- **A — Contexte** : qui est l'orchestrateur, quel est son BU, ses clients, ses peers, son scope produit (Cloud vs Self-host, fleet position, identité Sigma vs Pi vs Eta, etc.)
- **B — Outils** : quels MCP tools / skills / agents / hooks il doit invoquer pour quelle action, dans quel ordre, avec quels paramètres
- **C — Méthode** : comment il livre (evidence-bound, friction-field, IRP, mission-bootstrap, dispatch-task-create, signature footer, etc.)

Une section sans tag A/B/C = MANQUE — sert à rien d'identifiable pour l'orchestrateur, candidate au recadrage fonctionnel ou suppression.

### 38.3 Fichiers concernés

| Fichier | Rôle | Status audit |
|---|---|---|
| `/root/coding/elpi-corp/CLAUDE.md` | Fleet canonique RULE #1..#30 + MUST-USE AGENTS+SKILLS+HOOKS Day 108 v1.7.0 | ❌ AUDIT ABC NON RUN |
| `/root/coding/vantage-memory/CLAUDE.md` | Workspace Sigma — ABSOLUTE RULE Cloud vs Self-host + NPM PUBLISH PROTOCOL + Evidence-Bound Done + MUST-USE BU-spécifique Day 109 | ❌ AUDIT ABC NON RUN |
| Autres workspaces CLAUDE.md (eta, omega, theta, proxima, iota, xi, kappa, hephaistos, ...) | Workspace-spécifique | ❌ AUDIT ABC NON RUN |
| `MEMORY.md` auto-memory user | Index memories, namespacing protocol | ⚠️ AUDIT PARTIEL — instructions de base présentes, ABC à vérifier |

### 38.4 Audit attendu — sortie

Item 8 plan v2. Sigma drafte → Pi valide doctrine → Laurent approuve final. Format livrable :

Pour chaque fichier :
- Tableau section-by-section : numéro, titre, tag dominant A/B/C, citation 1-line de ce que la section apporte concrètement à l'orchestrateur.
- Liste sections MANQUE (ni A ni B ni C identifiable) — propositions : recadrage vers A/B/C OU suppression.
- Liste gaps — informations contexte/outils/méthode absentes alors qu'elles devraient être documentées. Examples connus Day 110 :
  - Workflow VP-first "recall avant claim factuel + cite Sources VP footer" — pas documenté.
  - Distinction VP components vs VR catalogue — Sigma a eu le doute Day 110, pas documenté.
  - Doctrine `dispatch-message` tag obligatoire `[INFO ONLY]` / `[STATUS]` / `[DONE]` / `task k<id>` — encodée hook mais pas dans CLAUDE.md doctrine humaine.
  - Workflow standard "improvisation détectée → log briefing audit + corriger immédiatement" — pas documenté.
  - Cas Day 110 cas E (misattribution verbatim Laurent) → workflow correction publique standardisé non documenté.
- Volume final : non contraint. Critère = ABC remplit le rôle, pas volume.

### 38.5 Cross-fleet doctrine consistency

⚠️ PARTIAL : aucun audit de cohérence cross-workspace. Sigma doctrine "ABSOLUTE RULE Cloud vs Self-host" doit-elle être dans CLAUDE.md fleet (visible Pi+Eta+Omega) ou rester scope Sigma uniquement ? Doctrine NPM PUBLISH PROTOCOL Sigma BU vs RULE #28 fleet VPS partagé — overlap ou complémentaire ? Auditer.

Status section : 🔧 NEEDS-FIX — audit ABC dormant, item 8 plan v2 Bloc C.

---

## 39. settings.json — fleet drift audit

### 39.1 Pourquoi cette section existe

Trou central plan v1 Sigma. settings.json = source of truth de ce qui est branché par workspace (hooks actifs, permissions allow-list tools, MCP servers configurés). Sans audit cohérence settings.json fleet-wide, drifts silencieux du type découvert Day 110 :

- `block-delete-on-prod.py` référencé dans `~/.claude/settings.json` Sigma mais absent disque → hook ne tourne pas, on croit qu'il bloque, il ne bloque pas. Faux sentiment de sécurité.

### 39.2 Périmètre audit

Pour chaque workspace orchestrateur :
1. Lire `~/.claude/settings.json` (user scope) + `.claude/settings.json` (workspace scope).
2. Lister tous les hooks référencés (PreToolUse / PostToolUse / UserPromptSubmit / SessionStart matchers).
3. Vérifier existence disque (`.claude/hooks/<name>.py`).
4. Vérifier matching contentHash VR canonical (`mcp__vantage-registry__get_hook_content`).
5. Lister tools allow-list — détecter permissions obsolètes (tools supprimés du serveur), manquantes (tools nouveaux non explicités), incohérences cross-orchestrateur.
6. Lister MCP servers configurés — vérifier endpoints actifs, auth fonctionnelle.

### 39.3 Drifts attendus

Hypothèses Day 110 :
- ≥1 hook fantôme par workspace (type `block-delete-on-prod.py` Sigma).
- Allow-list `mcp__vantage-peers__*` cohérence cross-workspace probablement OK (broadcast `vantage-peers` plugin) mais à vérifier.
- Allow-list `mcp__vantage-registry__*` variable selon orchestrateur — Pi+Sigma+Eta probablement complète, autres incertaines.
- Hooks BU-spécifiques (Sigma `enforce-clerk-jwt-smoke-prod.py` + `enforce-rag-namespace-deny-test.py`) — drift VR ↔ disque potentiel.

### 39.4 Livrable

Item 9 plan v2 Bloc A urgent. Sigma drafte audit → Pi valide → chaque orchestrateur exécute pull alignement sur son workspace.

Format livrable :
- Tableau workspace × hook × {référencé settings.json ? présent disque ? matching VR ? action requise}.
- Tableau workspace × tool allow-list × {présent ? requis ? action}.
- Liste actions consolidées par orchestrateur (chacun pull/ajoute/corrige son local).

### 39.5 Hook recommandé — audit récurrent

Hook `enforce-settings-vr-sync.py` (NOUVEAU candidate Day 110) qui à SessionStart vérifie au moins un sample du settings.json contre VR et flag drifts en `[WARN]`. Pas bloquant. Visibilité forcée.

Status section : 🔧 NEEDS-FIX — audit settings.json jamais run systématiquement. RULE #30 Day 109 ULTIMATUM ZÉRO DIVERGENCE VR exige déjà l'alignement mais sans mécanisme d'exécution.

---

## 40. Aggregate / cross-BU views — catégorie de tools absente

### 40.1 Gap structurel identifié par counter Pi Day 110

VP MCP expose des `list_<entity>` par entité (tâches, missions, briefings, etc.). VP n'expose AUCUN tool de synthèse cross-entité cross-BU. Conséquence directe : pour répondre à une question "où en est la fleet ?", l'orchestrateur doit faire N appels `list_*` séparés, parser, agréger mentalement → improvisation par fatigue cognitive.

Pi counter Day 110 a nommé cette catégorie : `fleet-status` = vue agrégée 5 lignes par BU.

### 40.2 Tools candidates par cas d'usage

| Cas d'usage | Tool proposé | Retour attendu |
|---|---|---|
| "Où en est chaque BU ?" | `fleet_status` | 5 lignes par BU : missions execute count, todos hors cron count, blockers count, urgents dormants count, dernier commit timestamp |
| "Quelles missions sont actives fleet ?" | `mission_digest` | tableau bu × missions execute + progress (T1/Tn) |
| "Qui attend du travail bloqué dont ?" | `blocker_map` | graphe assignée → blocker source |
| "Audits dormants > seuil ?" | `dormant_artifacts` | liste briefings/audits/missions sans mouvement |
| "Improvisations détectées ce sprint ?" | `improvisation_digest` (item 7) | comptage par orchestrateur par catégorie |

### 40.3 Status

❌ MISSING tous — aucun tool aggregate cross-BU disponible aujourd'hui. Conséquence : orchestrateurs improvisent leurs synthèses au lieu de les requêter.

🔧 NEEDS-FIX — item 2 plan v2 (`fleet-status`) ouvre la catégorie. Les autres viennent ensuite si l'approche valide.

---

## 41. Workspace topology + plugin vs workspace skill overlap

### 41.1 Topologie

Fleet réelle :
- N workspaces orchestrateur (`/root/coding/vantage-memory/` Sigma, `/root/coding/eta-workspace/` Eta, etc.).
- Chaque workspace contient `.claude/skills/`, `.claude/hooks/`, `.claude/agents/`, `CLAUDE.md`, `settings.json`.
- Plugins installés au scope user (`~/.claude/plugins/`) — vantage-peers v2.8.2, vantage-fumadocs, vantage-ops, perello-dev-studio, firecrawl.
- VR canonical à distance (MCP `mcp__vantage-registry__*`).

### 41.2 Overlap plugin vs workspace skills — drift potentiel

Plugin vantage-peers v2.8.2 ship des skills (`check-messages`, `pre-compact`, etc.). Workspace contient AUSSI ces skills sous `.claude/skills/check-messages/SKILL.md`. Lequel prime ? Si les deux diffèrent, lequel exécute ?

Observation Day 110 :
- Hash plugin skill et workspace skill JAMAIS comparés systématiquement.
- VR canonical existe en parallèle — 3 sources possibles pour le même skill.
- RULE #30 Day 109 exige `sha256(local) == VR.contentHash`. Mais le "local" est ambigu (plugin OU workspace).

### 41.3 Action

⚠️ PARTIAL — à scoper dans item 9 plan v2 (audit settings.json) en ajoutant une dimension "skill source authority". Ou item séparé si volume.

🔧 NEEDS-FIX — doctrine "plugin > workspace OR workspace > plugin" à clarifier dans CLAUDE.md fleet (item 8 ABC).

---

## 42. Évolution session Day 110 — méta-finding sur le débat lui-même

Cas concrets documentés section 28.1 cas A-E. Cas E (Sigma misattribution verbatim Laurent CLAUDE.md "réduire") est le plus instructif :

- Le débat lui-même (autour de l'improvisation) a produit une improvisation.
- L'improvisation s'est insérée dans un message broadcast Sigma → Laurent+Pi+Eta = visibilité fleet maximale.
- Laurent l'a détectée immédiatement et corrigée.
- Sigma a reconnu, corrigé, et tagué le cas comme baseline item 7 (digest improvisations).

**Méta-leçon** : la discipline ne s'installe pas en théorisant des hooks. Elle s'installe en pratiquant la correction visible. Chaque cas détecté + corrigé publiquement (Laurent → Sigma Day 110 cas E) renforce le réflexe mieux que toute RULE #31 hypothétique.

Cela valide le refus Pi des 4 leviers, valide le plan v2 sans nouvelle RULE, valide la métrique digest baseline item 7. La correction publique est la seule discipline qui scale — pas la règle ajoutée.

Status section : ✅ DOCUMENTÉ — premier exemplaire concret de la boucle correction-publique. À utiliser comme référence baseline pour mesurer progrès post-Bloc C.

---

Orchestrator: sigma — vantage-peers | 2026-06-21 — T1 deliverable + Day 110 full surface expansion + révision post-débat (Pi counter accepté + CLAUDE.md+settings.json items 8+9 + correction misattribution Laurent cas E)
