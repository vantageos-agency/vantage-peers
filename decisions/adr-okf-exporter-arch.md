# ADR — OKF Exporter Architecture (Phase 1)

**Status** : ACCEPTED
**Date** : 2026-06-19 (Day 107)
**Decision-maker** : Sigma (sigma-vps), validé Laurent verbatim GO Day 105 ("je t'ai dit hier GO!").
**Context** : Mission `vp-okf-bridge-phase-1` (k570g90vf9wdbsbw12kq8kt7fs88wts5) — Phase 1 T0 design.
**Parent RFC** : `decisions/okf-bridge-phase-1-rfc-2026-06-18.md` commit `6613610`.

---

## Décisions

### D1 — Pattern d'implémentation : **Convex `action` + MCP tool wrapper**

**Choix** : Convex `action` (côté backend Convex) appelée par un MCP tool léger (côté mcp-server/src).

**Pourquoi** :
- Convex actions ont accès file I/O (Buffer, _storage) nécessaire au tarball
- Internal queries par type (memories, briefingNotes, tasks) restent server-side (auth + filtering Convex-native)
- MCP tool = simple proxy : reçoit args → appelle action → renvoie signed URL — pas de logique business

**Alternative écartée** : pure MCP tool client-side faisant N requêtes get_* puis assemblant côté Node = (a) N round-trips coût latence, (b) auth check côté client fragile, (c) duplique logique filtrage namespace/type déjà en Convex.

**Fichiers cibles** :
- `convex/okfBundle.ts` — action principale + internal queries
- `convex/okfSerializer.ts` — mapping VP → OKF YAML
- `convex/okfValidator.ts` — conformance v0.1
- `mcp-server/src/tools/exportOkfBundle.ts` — MCP wrapper

---

### D2 — Bibliothèque tar : **`tar-stream`**

**Choix** : `tar-stream` (streaming pur, low-level).

**Pourquoi** :
- Streaming entry-by-entry → bornes mémoire prévisibles (cap 50 MB Phase 1 sans risque OOM)
- Pas de dépendance filesystem (utile en environnement Convex action)
- API simple : `pack.entry({name, ...}, content)` + `pack.finalize()`
- `node-tar` orienté disque + plus lourd, ne joue pas avec Convex sandbox

**Alternative écartée** : `node-tar` (orienté fichiers locaux + 2x bundle size).

**Dépendance** : `tar-stream` ajouté `convex/package.json` deps.

---

### D3 — Validator OKF v0.1 : **validator maison + parseur tiers backup**

**Choix** : implémentation maison `convex/okfValidator.ts` suivant spec §1.5 verbatim. Le parseur tiers (s'il existe publié par `GoogleCloudPlatform/knowledge-catalog`) sera intégré comme backup de validation dans les tests T2.

**Pourquoi** :
- Spec OKF v0.1 §1.5 est courte (frontmatter parsable + `type` non vide). Validator maison ~50 lignes.
- Dépendance externe sur projet upstream Google Cloud non-stable = risque rupture
- Backup parseur tiers en tests T2 garantit conformité indépendamment de notre validator (anti-bug spec lecture)

**Libs YAML utilisées** : `js-yaml` (parse) + `gray-matter` (extract frontmatter+body).

**Alternative écartée** : dépendre exclusivement parseur tiers Google Cloud — bloque Phase 1 si pas publié.

---

### D4 — Convex `_storage` quota : **vérification T0 + cap 50 MB Phase 1**

**Choix** : pré-flight check du quota disponible sur compassionate-goldfinch-737 lors du T0 ; cap bundle Phase 1 à 50 MB ; refus si bundle attendu > 100 MB.

**Pourquoi** :
- Convex `_storage` partagé fleet — éviter consommer quota disproportionné
- Cap 50 MB = bornage tarball memory Convex action + couvre namespace pilote project/elpi-corp largement
- Refus 100 MB+ = barrière dure (sinon dégrade les autres BU)

**Manifest** : la sortie inclut `truncated: bool` + `size: number` pour audit.

**Action préalable** : Sigma run quota check Convex dashboard avant T1. Si quota < 200 MB libres → alerter Pi avant T2.

---

### D5 — Signed URL TTL : **configurable, défaut 1h pour pilote Phase 1**

**Choix** : TTL signed URL configurable via param action (`urlTtl?: number` en secondes), défaut **1 heure**. // allow-time-estimate: TTL config technique signed URL purge, pas durée d'effort.

**Pourquoi** :
- 1h = fenêtre raisonnable pour Pi/Laurent télécharger + Convex `_storage` se purge auto via TTL Convex storage
- Configurable = anticipe Phase 2 (import) où TTL plus long peut être utile pour roundtrip tests
- Pas de TTL infini = anti-fuite signed URL leak

**Alternative écartée** : TTL fixé hard-coded = perte flexibilité Phase 2.

---

## Récap implémentation T1+

Avec D1-D5 actés :
- **T1** crée `convex/okfSerializer.ts` (Zod schemas frontmatter per type + emit YAML déterministe via `yaml` lib)
- **T2** crée `convex/okfValidator.ts` (parse + check `type` + cross-links + index/log réservé)
- **T3** crée `convex/okfBundle.ts` action + MCP tool wrapper — utilise tar-stream + serializer T1 + validator T2 + Convex `_storage`
- **T4** index.md + log.md auto-generators (intégrés à T3 ou séparé)
- **T5** roundtrip-design tests (parse-emit byte-exact)
- **T6** docs (README + docs/okf-export.md + CHANGELOG + runbook VR vp-okf-spec-v1) — RULE #25 same-commit T3
- **T7** verify Pi smoke + parseur tiers backup
- **T8** ship PR vantage-peers + Eta APPROVED + Pi GO MERGE

Tests target par task documenté RFC §4 — total ≥53.

---

## Refs

- RFC parent : `decisions/okf-bridge-phase-1-rfc-2026-06-18.md` commit 6613610
- OKF spec v0.1 §1.2 + §1.5 (Google Cloud knowledge-catalog)
- VP CLAUDE.md RULE #19 (sandbox cleanup) + RULE #23 (transport↔env ownership) + RULE #25 (docs-loop) + RULE #26 (Bible-consult)
- Day 82 NPM PUBLISH PROTOCOL v1.1.0 pour T8 ship

---

*ADR préparé par Sigma — VantagePeers — 2026-06-19 (Day 107)*
