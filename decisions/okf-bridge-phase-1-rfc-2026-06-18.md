# RFC — VP OKF Bridge Phase 1

**Status** : PROPOSED — pending Laurent ratification kickoff samedi 2026-06-20 09:00 Paris
**Date** : 2026-06-18 (Day 106)
**Pilot proposé** : Sigma (sigma-vps)
**Reviewers** : Pi + Laurent (ratification), Eta (schema audit + migration safety), Omega (compat VR cross-link `vr://`)
**Mission cible** : `vp-okf-bridge-phase-1` (status=plan jusqu'à GO Laurent)
**Refs amont** :
- briefing VP js74ptzjpahbx0et71cjt2bjrn88vn0s — kickoff Sigma 3 outils MCP + convention frontmatter + bonus pre-compact
- `analysis/okf-analysis-2026-06-17.md` (commit abdaeef, elpiarthera/ElPi-Corp) — spec OKF v0.1 verbatim
- `analysis/okf-impact-vantage-peers-2026-06-17.md` (commit df71e98) — impact concret VP architecture + 3 outils MCP cibles
- briefing js782r6bsbbs5tq353962pjh1x88v0q3 — VR Living Bible RFC (parallèle, indépendant)

**Cross-link mission parallèle** : `vantage-doc-forge` Phase 1 (pilot Hephaistos) utilisera la même convention OKF frontmatter pour ses templates `doc-binary` côté VR. Coordination dès kickoff samedi.

---

## 0. TL;DR

Phase 1 = **un seul outil MCP** côté VP : `export_okf_bundle` en mode **read-only**, scope **namespace=`project/elpi-corp`** + **3 types pilotes** (`memory-*`, `briefing-note`, `task`). Sortie = bundle OKF v0.1 conforme spec Google Cloud (frontmatter YAML + body markdown + cross-links résolus + `index.md` auto-généré + `log.md` chronologique). Critère done = Pi exporte ses memories `project/elpi-corp` → bundle parsable par parseur tiers OKF v0.1 + roundtrip-design ready Phase 2.

Phase 2 (`import_okf_bundle`) + Phase 3 (`sync_okf_repo`) + Phase 4 (productisation plugin) **hors scope** mission Phase 1.

---

## 1. Les 4 standards Laurent Day 105 (non-négociables)

Pi msg k97610qwm22a8x0w / Laurent verbatim 2026-06-18 :
> « ça doit être parfait pas 95% 100% » + « strict TDD » + « on ne ré-invente pas la roue! la bible doit être consulté! » + « et la doc! »

Application sur ce RFC + cascade mission Phase 1 :

### 1.1 Qualité 100% non-négociable (OKF v0.1 conformance)

Bundle exporté **doit être 100% parsable** par un parseur tiers OKF v0.1 conforme — zéro tolérance non-conformité spec Google Cloud. Roundtrip export → re-import (Phase 2) anticipé dans le design Phase 1 (`type`, `resource:`, cross-links absolus) doit garantir zéro perte fidélité. Validator obligatoire — choix `parseur tiers` ou validator maison documenté T0.

### 1.2 Strict TDD RULE #12 — ratio + path + commande

Cible ≥ 50 tests Phase 1. Catégories :
- **Conformance spec OKF v0.1** : frontmatter parsable, `type` non vide, champs réservés (`index.md` listing, `log.md` chronologique), extensibilité champs custom préservée
- **Cross-links résolus** : `[text](/path/to/concept.md)` absolus, validation chemin existant intra-bundle
- **`index.md` auto-généré** : listing dossier complet, racine porte `okf_version: "0.1"`
- **`log.md` chronologique** : groupé par date ISO 8601, plus récent en premier
- **Roundtrip parse-then-emit** : YAML frontmatter parsé puis ré-émis identique (byte-exact où possible)
- **Mapping VP → OKF** : 3 types pilotes × champs requis × edge cases (null/empty/unicode/markdown body 100kb)

Chaque task ship cite : `ratio X/Y + chemin tests + commande exec` (ex: `pnpm test convex/__tests__/okfExport.test.ts -> 52/52`).

### 1.3 Bible-consult RULE #26 — VR query avant scope

Résultat consultation `mcp__vantage-registry__search_all query="markdown frontmatter export bundle yaml"` + `query="convex query mutation export tarball"` (exécuté Day 106) :

| Composant VR | Réutilisable Phase 1 ? | Raison |
|---|---|---|
| `perello-dev-studio:dev-convex-function` (skill) | OUI | Pattern écriture mutations/actions Convex avec validators + indexes + auth checks |
| `perello-dev-studio:dev-convex-helpers` (skill) | OUI | customQuery/customMutation pour auth injection, Zod validation, joins |
| `convex-skills-wayne:convex-best-practices` (skill) | OUI | Function organization, query patterns, validation TypeScript |
| `perello-translation-studio:translate-file` (skill) | INSPIRATION | Pattern préservation frontmatter + MDX structure (transposable serializer) |
| Aucun skill `export-bundle` / `okf-emitter` / `markdown-serializer` | À CRÉER | Confirmé : pas de bundler markdown existant côté fleet |
| Aucun hook `enforce-okf-spec` ou validator OKF | À CRÉER | Spec OKF v0.1 → validator maison Phase 1 (parseur tiers candidat backup) |
| Convention frontmatter VP | INEXISTANTE | Pas de runbook `vp-okf-spec-v1` actuel — à publier en VR par T1 |

**Conclusion VR** : substrat Convex helpers réutilisable ; serializer OKF + validator + runbook spec = nouveaux artefacts Phase 1. Pas de ré-invention de Convex patterns ; ré-invention OKF serializer impossible (nouveau scope).

### 1.4 RULE #25 DOCS-CONTEXT-LOOP

Chaque PR Phase 1 update **dans le même commit** :
- `README.md` (mention tool `export_okf_bundle` v0.1 + lien runbook)
- `docs/okf-export.md` (nouvelle page : signature MCP + exemple bundle + parseur tiers)
- `CHANGELOG.md` (section [Unreleased] : tool added + spec OKF v0.1 reference)
- runbook VR `vp-okf-spec-v1` (convention frontmatter + mapping VP types)

Hook `enforce-pr-docs-sync` v1.0.0 (PR #35 Day 103, contentHash d60ba361...) gate actif sur ces PR.

---

## 2. Réponses aux 5 décisions ouvertes (proposales — Laurent tranche samedi)

| # | Décision | Proposition Sigma | Argument |
|---|---|---|---|
| 1 | Granularité unité sync git | **Batch 10 min** (proposal Pi initial) | Évite inondation git history (1 commit/mutation = 100+ commits/jour orchestrateur actif). Batch 10 min = fenêtre digest, audit lisible, latence acceptable continuité. NB: sync hors scope Phase 1 → décision applicable Phase 3 seulement, mais le design Phase 1 doit anticiper (timestamps `since` natif) |
| 2 | Format `resource:` | **URI custom `vp://`** | Indépendance dashboard URL (peut bouger, repo être renommé). `vp://memory/j576hr9s...` portable cross-environnement (Convex prod, dev, replay). Spec OKF v0.1 autorise toute URI ; `vp://` lisible humain + machine. Cohérent `vr://` (composants) + futur `vcrm://` |
| 3 | Sub-types composants | **Dans `type:` direct** | `type: memory-feedback` / `type: memory-reference` / `type: skill` / `type: hook` matchent flexibilité OKF (producteur choisit, consommateur tolère inconnu — spec §1.2). `tags:` reste pour catégorisation transverse (`tags: [pujol, uc2, friction]`). Sub-typing dans `type:` = flat namespace simple, parseur tiers heureux |
| 4 | `index.md` auto OU main-maintenu | **Auto-généré** | Déterministe, zéro drift humain, zéro coût maintenance. Cohérent friction Day 104 "20 vs 37" : main-maintenu = comptage humain stale. Auto = `export_okf_bundle` régénère `index.md` chaque export depuis Convex state |
| 5 | Tag `confidentiality:internal\|client\|public` obligatoire | **OUI Phase 3+ export externe** | Phase 1 read-only Sigma-local = pas requis (pas de fuite hors Convex). Dès Phase 3 (sync git public ou bundle livré client) = validator hook obligatoire avant emit. Default `confidentiality:internal` si absent. Bundle externe sans tag = REJET hook |

---

## 3. Phase 1 — Scope précis

### 3.1 Tool MCP cible

```
export_okf_bundle({
  namespace: "project/elpi-corp",      // Phase 1 PILOTE — verrouillé un namespace
  types: ["memory-feedback", "memory-reference", "memory-project",
          "memory-episode", "memory-user", "memory-audit",
          "briefing-note", "task"] | null (= all 3 type families),
  format: "tarball" | "tree",          // Phase 1 — pas de ndjson
  since: ISO 8601 | null               // optionnel, anticipation Phase 2 roundtrip + Phase 3 sync
}) -> { bundleUrl, size: number, fileCount: number, manifest: { types: {memoryCount, briefingCount, taskCount} } }
```

Implémentation : Convex `action` (file I/O pour tarball) appelle internal `query` par type → assemble en mémoire → écrit tarball via `Buffer` + `tar-stream` → upload Convex `_storage` → renvoie signed URL (TTL configurable, défaut court).

### 3.2 Mapping VP → OKF (3 types pilotes Phase 1)

Conforme spec OKF v0.1 §1.2 (champs réservés : `type`, `title?`, `description?`, `resource?`, `tags?`, `timestamp?` + extensibilité custom).

**`memory-*`** :
```yaml
---
type: memory-feedback        # ou memory-reference, memory-project, memory-episode, memory-user, memory-audit
title: "<derived from first line / description>"
description: "<255 chars max — premier paragraphe stripped>"
resource: "vp://memory/<convexId>"
tags: [<existing tags from Convex>, ...]
timestamp: "<ISO 8601 _creationTime or updatedAt>"
namespace: "project/elpi-corp"
createdBy: "<orchestrator>"
---

<body markdown verbatim from Convex content field>

# Related
<auto-emitted cross-links if content contains vp:// or [[name]] refs>
```

**`briefing-note`** :
```yaml
---
type: briefing-note
title: "<from Convex title>"
resource: "vp://briefing/<convexId>"
tags: [snapshot, <topic>, ...]
timestamp: "<ISO 8601>"
participants: [<from Convex participants array>]
topic: "<from Convex topic>"
---

<body markdown verbatim>
```

**`task`** :
```yaml
---
type: task
title: "<from Convex title>"
description: "<255 chars max>"
resource: "vp://task/<convexId>"
tags: [vp-task, <derived from missionId, status>, ...]
timestamp: "<ISO 8601 updatedAt>"
assignedTo: "<role>"
priority: "<urgent|high|medium|low>"
status: "<todo|in_progress|review|blocked|done>"
missionId: "<convexId or null>"
dependsOn: [<array of taskIds>]
createdBy: "<orchestrator>"
completionNote: "<if status==done, verbatim>"
---

<description body markdown verbatim>
```

### 3.3 Structure bundle output

```
project-elpi-corp-bundle/
├── index.md                              # auto-généré, frontmatter okf_version: "0.1"
├── log.md                                # auto-généré, chronologique par date ISO 8601
├── memories/
│   ├── index.md                          # auto-généré, listing
│   ├── <convexId-1>.md                   # frontmatter + body
│   └── <convexId-N>.md
├── briefing-notes/
│   ├── index.md
│   └── <convexId>.md
└── tasks/
    ├── index.md
    └── <convexId>.md
```

### 3.4 Cross-links résolution

- Body Convex peut contenir `[[memory-name]]` ou `vp://memory/<id>` → résolu en chemin relatif intra-bundle si target présent (`/memories/<convexId>.md`)
- Si target hors namespace ou hors types Phase 1 → préservé verbatim `vp://...` URI (parseur tiers ne casse pas — spec §1.5 tolère URI externe)

### 3.5 Critère done Phase 1

1. Pi appelle `export_okf_bundle namespace=project/elpi-corp types=null` → reçoit tarball signé
2. `tar -xzf bundle.tar.gz` → arborescence conforme §3.3
3. Parseur tiers (candidat : `okf-parser` open source si publié par Google Cloud, sinon validator maison T2) valide chaque `.md` frontmatter YAML + champ `type` non vide
4. Pi ouvre 5 fichiers random dans éditeur Markdown → contenu fidèle à Convex source
5. Hash du bundle reproductible (sortie déterministe sur input identique — pas de timestamps de génération dans le frontmatter Convex-derived, seulement Convex timestamps)

---

## 4. IRP task chain proposée — mission `vp-okf-bridge-phase-1`

| Task | Title | Owner | Brief résumé | Tests target |
|---|---|---|---|---|
| T0 | plan — design exporter architecture | sigma | Choix Convex action vs MCP tool wrapper, choix tar lib (tar-stream vs node-tar), spec validator (parseur tiers vs maison), Convex `_storage` quota check, signed URL TTL choix. Output : ADR /decisions/adr-okf-exporter-arch.md | N/A (design phase) |
| T1 | implement frontmatter serializer (`convex/okfSerializer.ts`) | sigma | Mapper VP → OKF per-type (memory-*, briefing-note, task). Zod schemas frontmatter. YAML emit via `yaml` lib (deterministic key order). Body markdown verbatim passthrough. | ≥ 15 tests serializer (each type × {happy path, null fields, unicode body, 100kb body, edge case empty arrays}) |
| T2 | implement validator OKF v0.1 (`convex/okfValidator.ts`) | sigma | Parse bundle entry → vérifier frontmatter YAML parsable + `type` non vide + cross-links absolus existent + `index.md` réservé sans frontmatter (sauf racine `okf_version`). Si parseur tiers publié → wrap ; sinon validator maison spec §1.5 verbatim. | ≥ 12 tests validator (conformance + non-conformance cases + champ extension custom préservation) |
| T3 | implement `export_okf_bundle` action + MCP tool (`convex/okfBundle.ts` + `mcp-server/src/tools/exportOkfBundle.ts`) | sigma | Convex action assemble entries (internal query par type) → serializer T1 → tar-stream → upload `_storage` → signed URL. MCP tool wrapper signature §3.1. Auth check createdBy=caller. | ≥ 10 tests action+tool (round-trip serialize/parse + tarball decompresse + signed URL access + auth refus cross-orch) |
| T4 | implement index.md + log.md auto-generators | sigma | `index.md` racine porte `okf_version: "0.1"` + table types comptés. `index.md` dossier liste entrées avec title + resource. `log.md` chronologique par jour ISO 8601 (depuis Convex `_creationTime`/`updatedAt`). | ≥ 8 tests index+log (génération + ordre chronologique + table comptes + edge cases bundle vide / 1 entry) |
| T5 | roundtrip-design test (anticipation Phase 2) | sigma | Test : serializer T1 produit YAML → re-parse YAML lib → ré-emit → byte-exact (déterministe). Anticipation import Phase 2 sans casser design Phase 1. | ≥ 8 tests roundtrip (each type, edge cases unicode, markdown body avec frontmatter-like sections) |
| T6 | DOCS-CONTEXT-LOOP — `README.md` + `docs/okf-export.md` + `CHANGELOG.md` + runbook VR `vp-okf-spec-v1` | sigma | Même commit que T3. RULE #25 enforcement. Runbook VR publié via `mcp__vantage-registry__upsert_runbook` ou commit content. | N/A (docs) |
| T7 | verify — Pi smoke + parseur tiers + 5 fichiers ouverts éditeur | sigma + pi | Critère done §3.5 (5 steps). Evidence : bundle URL + manifest + 5 path captures + validator output PASS. | N/A (acceptance) |
| T8 | ship PR vantage-peers + Eta APPROVED + Pi GO MERGE | sigma | Day 82 protocol v1.1.0 — Eta review HEAD SHA cite, ETA_APPROVED_TASK_ID + ETA_APPROVED_COMMIT_SHA pour npm publish (mcp-server bump). | N/A (ship) |

**Total tests target Phase 1 : ≥ 53 tests** (15 + 12 + 10 + 8 + 8 = 53 — dépasse cible 50 Laurent).

**Dépendances** : T0 ← T1 ← T2 ← T3 ← T4 ← T5 ← T6 ← T7 ← T8. Chain linéaire (pas de parallèle Phase 1 — chaque step lit l'output du précédent).

---

## 5. Hors scope explicite Phase 1

- `import_okf_bundle` (Phase 2)
- `sync_okf_repo` (Phase 3)
- Plugin public `@vantageos/vp-okf-bridge` (Phase 4)
- Tag `confidentiality:` validator hook (Phase 3 export externe)
- Visualizer SPA `vp-explorer.html` (Phase 3)
- Skill `/post-compact` (Phase 2 — dépend import)
- Migration `/pre-compact` actuel vers OKF bundle attaché (Phase 2)
- Adoption fleet (Phase 3)
- Types complets (diary-entry, fix-pattern, mission, episode, mandate, component) — Phase 2
- Namespace `global` + autres BU — Phase 2/3

---

## 6. Risques + mitigations Phase 1

| Risque | Sévérité | Mitigation |
|---|---|---|
| Convex action size limit (tarball en mémoire) | MOYEN | Streaming via tar-stream + chunking _storage upload. Cap bundle size 50 MB Phase 1 (alerte au-dessus, refus 100 MB+). Manifest signale truncated |
| Parseur tiers OKF v0.1 non publié par Google Cloud | MOYEN | Fallback validator maison T2 spec §1.5 verbatim. Backup ouvert : utiliser `js-yaml` + `gray-matter` pour parsing minimal |
| Sortie non-déterministe (timestamps de génération polluent hash) | FAIBLE | Frontmatter dérivé Convex `_creationTime`/`updatedAt` uniquement — pas de `generatedAt`. Test T5 byte-exact roundtrip |
| Cross-links circulaires entre entités | FAIBLE | Résolution paresseuse + cache visited set + cap profondeur 100. Test T3 |
| Auth bypass (orch A exporte memories orch B) | HAUT | Validator MCP tool : `caller_orchestrator` doit matcher `namespace` créateur OU être pilot du BU. Refus si mismatch. Test T3 |
| Convex `_storage` quota épuisé | FAIBLE | Quota Convex prod compassionate-goldfinch-737 vérifié T0 + TTL signed URL configurable pour purge auto |

---

## 7. Évolutions Phase 2+ anticipées dans le design Phase 1

Pour ne pas re-architecturer plus tard, Phase 1 prévoit :
- **Roundtrip-ready** : serializer émet YAML déterministe parseable par `import_okf_bundle` Phase 2 sans perte
- **`since` param** : déjà supporté Phase 1 même si pas exposé MCP — utilisé Phase 2 (diff-only) + Phase 3 (sync incrémental)
- **Manifest fileCount + size** : permet Phase 2 pre-flight dry-run + Phase 3 conflict detection
- **`vp://` URI canonical** : Phase 2 `import_okf_bundle` re-mappe `vp://` → Convex IDs (table lookup par resource), pas de regex fragile

---

## 8. Anti-patterns (NE PAS reproduire)

Per Pi msg k9767bg758fq74 :
- ❌ Timeline en jours (RULE #3) — pas d'estimates de durée
- ❌ Pré-valider les 5 décisions en présumant — Laurent tranche samedi, ce RFC **propose**
- ❌ Inclure Phase 2/3 scope dans mission Phase 1 — strict séparation, §5
- ❌ Skip docs (RULE #25) — T6 obligatoire dans le commit T3
- ❌ Skip TDD ≥ 50 tests (RULE #12) — §4 cible explicite 53 tests
- ❌ Réinventer roue Convex (RULE #26) — §1.3 tableau Bible-consult VR

---

## 9. Calendrier (jalons absolus, pas de durée)

- **Day 106 (aujourd'hui 2026-06-18)** : RFC commit + push + send_message Pi avec lien
- **Day 107-108** : Pi review RFC + Laurent éventuellement (async)
- **Day 109 (samedi 2026-06-20 09:00 Paris)** : kickoff calé GCal — Laurent tranche les 5 décisions + GO Phase 1 OU REVISE RFC
- **Si GO** : create_mission `vp-okf-bridge-phase-1` status=execute, Sigma démarre T0 sur l'instant
- **Si REVISE** : RFC v2 itération + re-kickoff async (pas de re-meeting calé)

---

## 10. Demandes de review

**Pi + Laurent (ratification)** :
- Les 5 propositions §2 alignées avec intent ?
- Scope Phase 1 §3 strict assez (3 types + 1 namespace + read-only) ?
- IRP chain §4 lisible / actionnable ?
- 4 standards Laurent §1 correctement intégrés ?

**Eta (audit migration)** :
- Convex action pattern §3.1 safe (pas de schema breaking sur tables existantes — additive zero) ?
- Pré-conditions sandbox build pass nécessaires sur les nouveaux fichiers `convex/okfSerializer.ts` + `convex/okfValidator.ts` + `convex/okfBundle.ts` ?
- Quotas Convex prod compassionate-goldfinch-737 (`_storage` 50MB cap) vérifiables avant ship ?

**Omega (compat VR)** :
- URI `vp://` cohérent avec convention VR existante (sinon proposer `vr://`-aligned format) ?
- Runbook VR `vp-okf-spec-v1` à publier via `mcp__vantage-registry__upsert_runbook` — owner ?

---

## 11. References

- OKF v0.1 spec — github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf
- briefing js74ptzjpahbx0et71cjt2bjrn88vn0s — kickoff Sigma
- briefing js782r6bsbbs5tq353962pjh1x88v0q3 — VR Living Bible parallèle
- analysis Pi `okf-analysis-2026-06-17.md` commit abdaeef
- analysis Pi `okf-impact-vantage-peers-2026-06-17.md` commit df71e98
- VP CLAUDE.md RULE #25 (DOCS-CONTEXT-LOOP), RULE #26 (Bible-consult), RULE #12 (TDD), RULE #19 (sandbox cleanup), RULE #23 (transport↔env ownership)
- Hook `enforce-pr-docs-sync` v1.0.0 contentHash d60ba361... (PR #35 Day 103)

---

*Document préparé par Sigma — VantagePeers — 2026-06-18 (Day 106)*
*Status : PROPOSED — pending Laurent ratification kickoff 2026-06-20 09:00 Paris*

friction_observed: Pi msg cascade Day 105-106 (5 messages, 2 corrections) — auto-typage marker `[STATUS]` vs `[INFO ONLY]` lourd à parser. Capitalize candidate : skill `dispatch-message` v3 pourrait pre-flight marker depuis intent (status update vs info-only vs action).
