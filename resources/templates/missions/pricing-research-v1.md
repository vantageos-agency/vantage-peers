---
name: pricing-research-v1
description: Mission template pour recherche pricing reproductible avec gate approval competitors + Firecrawl deep scrape. Extends mission-generic-v1.
applies_to: [all-bus]
version: 1.1.0
created: 2026-05-07
extends: mission-generic-v1
---

# Mission — Pricing Research v1.1
Owner: pi
Parent: mission-generic-v1

## Tasks structure

T1 — Capture contexte produit (orchestrateur direct, _context.md)
T2 — Recherche personas (strategy-researcher bg sonnet, personas.md, parallèle)
T3 — Competitive landscape (2 phases avec gate)
   T3.1 Candidates list (strategy-researcher bg sonnet, competitive-candidates.md, parallèle)
   GATE APPROVAL Laurent
   T3.2 Deep scrape Firecrawl (strategy-researcher bg sonnet, competitive.md + competitive-comparison-table.md + competitive-blog-data.json)
T4 — Psychological pricing (strategy-researcher bg sonnet, psychological.md, parallèle)
T5 — Anchor pricing (strategy-researcher bg sonnet, anchors.md, parallèle)
T6 — Synthèse + recommandation (orchestrateur direct, synthesis.md)
T7 — Briefing note VantagePeers (orchestrateur direct, create_briefing_note)
T-REPORT FINAL — send_message canal pi-chromebook,laurent avec recommandation finale

## Rules

- T2/T3.1/T4/T5 toujours dispatchés en parallèle
- T3.2 GATE APPROVAL Laurent obligatoire avant deep scrape
- Sources web obligatoires (pas de prix inventés)
- Firecrawl pour T3.2 deep scrape (mcp__firecrawl__firecrawl_scrape)
- Output competitive multi-format : full + landing table + blog JSON
- Artifacts dans decisions/pricing-research/<product-slug>/
- 1 briefing note finale systématique
- Recommandation = 1 principal + 1 plan B
- Update périodique 6-12 mois

## Output structure

decisions/pricing-research/<product-slug>/
├── _context.md
├── personas.md
├── competitive-candidates.md (gate approval requis)
├── competitive.md (full data Firecrawl)
├── competitive-comparison-table.md (landing simplifié)
├── competitive-blog-data.json (data articles "Notre app vs X")
├── psychological.md
├── anchors.md
└── synthesis.md

Plus : 1 briefing note VantagePeers liée.

## Sellable as

Part de perello-pricing-research plugin v1.1 — process reproductible recherche pricing avec gate competitors + Firecrawl + output landing/blog réutilisable.
