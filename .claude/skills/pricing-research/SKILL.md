---
name: pricing-research
description: Process reproductible de recherche pricing pour tout produit/service ElPi Corp. 4 axes parallèles avec gate approval competitors. Subagent B = 2 phases (candidates list → approval Laurent → deep scrape Firecrawl). Output multi-format pour comparison table landing + articles blog "Notre app vs competitor".
metadata:
  version: "1.1.0"
license: Proprietary
---

# pricing-research v1.1

Process reproductible recherche pricing avec 4 axes parallèles + gate approval competitors.

## WORKFLOW

### Step 1 — Capture contexte produit
Créer `decisions/pricing-research/<product-slug>/_context.md`.

### Step 2 — Dispatch 4 subagents parallèle (strategy-researcher Sonnet bg)

**Subagent A — Personas** : 3-5 personas réelles avec douleurs + budget. Sources web obligatoires.

**Subagent B — Competitive (2 phases avec gate)** :
- Phase B1 : 8-15 candidats (nom + URL + positionnement). Output `competitive-candidates.md`.
- GATE APPROVAL Laurent : send_message Pi+Laurent avec liste, demande APPROVE/REVISE.
- Phase B2 (post-approval) : Firecrawl scrape pricing/features/comparison pages. Extraire features list + tiers + pricing per tier + matrice features×tier. Output multi-format : `competitive.md` (full) + `competitive-comparison-table.md` (landing) + `competitive-blog-data.json` (articles "Notre app vs X").

**Subagent C — Psychological pricing** : seuils B2B SaaS marché cible 2026, études récentes citées.

**Subagent D — Anchor pricing** : 8-12 produits SaaS comparables avec pricing 2026 exact.

### Step 3 — Gate competitors + audit
3a. Phase B1 termine en premier, bloque deep scrape jusqu'à approval Laurent.
3b. Orchestrateur send_message avec candidats list pour approval.
3c. Post-approval, dispatch Phase B2.
3d. A/C/D continuent en parallèle pendant le gate.
3e. Audit : tous les fichiers existent et substantiels (sources URLs réelles).

### Step 4 — Synthèse orchestrateur
`synthesis.md` avec personas retenues + concurrence positioning + seuils psy + anchors mentaux + recommandation pricing sourcée + plan B.

### Step 5 — Briefing note VantagePeers
`mcp__vantage-peers__create_briefing_note` topic=product avec content synthesis + decisions list.

### Step 6 — Output user-facing
Recommandation finale + plan B + artifacts paths + briefing-id, décision attendue APPROVE/REVISE/ARCHIVE.

## RULES

- 4 subagents toujours en parallèle
- Subagent B = 2 phases avec gate approval Laurent (pas de deep scrape sans approval)
- Sources obligatoires (pas de chiffres inventés)
- Firecrawl pour deep scrape concurrents (mcp__firecrawl__firecrawl_scrape format markdown)
- Output competitive multi-format : full data + comparison table + blog data JSON
- Artifacts persistants commit/push
- 1 briefing note finale systématique
- Recommandation = 1 principal + 1 plan B
- Process identique tous produits

## EXAMPLES

### Example 1 — VantagePeers Cloud pricing
/pricing-research vantagepeers-cloud → 4 subagents → gate B candidates → Laurent approve → Phase B2 deep scrape → synthesis → briefing → recommandation finale

### Example 2 — GPTPowerUps Cloud pricing
/pricing-research gptpowerups-cloud → même process, dossier dédié, briefing distinct

## SELLABLE AS

Skill core du plugin perello-pricing-research — process reproductible recherche pricing pour tout produit B2B SaaS / formations / prestations. v1.1 ajoute gate approval competitors + Firecrawl deep scrape + multi-format output (landing comparison + blog articles data).
