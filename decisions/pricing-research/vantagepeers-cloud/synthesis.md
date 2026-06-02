# Synthesis — VantagePeers Cloud Pricing Research

**Mission**: D62-Sigma-Pricing-Research-VP-Cloud (k5740rr49eg0aj4d0xeag64wm5868sxv)
**Pilot**: Sigma — VantageOS Team Infra
**Date**: 2026-05-07
**Source artifacts**: `decisions/pricing-research/vantagepeers-cloud/{_context,personas,competitive-candidates,psychological,anchors}.md` — 5 docs, 85+ sources cited
**Pending T3.2 enrichment**: Firecrawl deep scrape of approved top-8 (will append `competitive.md` + `competitive-comparison-table.md` + `competitive-blog-data.json` post-Laurent gate)

## TL;DR — Final recommendation

**Launch with 2 tracks Self-Hosted (free + €99/yr Pro Support, unchanged) + Cloud (3 tiers below).**

**Cloud tier grid (LAUNCH = annual + Lifetime founding only — no monthly):**

| Tier | Annual | Lifetime founding | Cap | Audience |
|------|--------|--------------------|-----|----------|
| **Solo** | €49/year ("launch price") | **€99 one-time** (2× annual) | **100 seats** | Solo dev/AI builder (P1), formateur (P2) |
| **Team** | €290/year (~5 seats flat) | **€590 one-time** (2× annual) | **25 seats** | Independent consultant (P3), small agency (P4), coaching team (P5) |
| **Enterprise** | Book a call | — | — | Custom contracts, SLA, security addenda |

**Rationale**: All four research axes converge on Solo €49 + Team €290 as legitimate launch pricing. Lifetime founding 2× annual respects Laurent's "no-brainer" frame (pay 2 years upfront, keep forever) and stays aggressively below market.

## Personas → tiers (from personas.md)

| Persona | Best tier | ARPU expectation |
|---------|-----------|-------------------|
| P1 Solo AI/Dev (Solo-Builder) | **Solo €49 / Lifetime €99** | Sub-impulse vs €400-700/day TJM. Acquisition-friction-free. **Primary Solo target.** |
| P2 Formateur/Trainer (Trainer) | Solo €49 → Team €290 if scaling cohort | Annual SaaS budget €1.2K-3.5K, GDPR-first messaging required |
| P3 Independent Consultant (Thomas) | **Team €290 / Lifetime €590** | $150-300/hr billing, multi-client isolation pain. **Primary Team target. Strongest path to Enterprise.** |
| P4 Small dev/marketing agency (3-10 seats) | Team €290 → Enterprise @ 10+ | Per-seat ~€58/yr beats Notion AI €120/seat |
| P5 Coaching team (2-5 coaches) | Team €290 | Longer discovery cycle, non-tech UX framing |

## Competitive landscape (top-8 candidates → B2 deep scrape pending)

mem0, Zep, supermemory.ai, Letta, Pinecone, Weaviate, Smithery.ai, Composio. Skip: ChromaDB Cloud, Qdrant Cloud, mcpmarket.com, LangSmith, Langfuse.

Key findings without B2 yet:
- 3 direct memory-API competitors (mem0/Zep/supermemory) all priced **monthly $19-249**. VP Cloud Solo €49/year ≈ €4/mo equivalent — aggressively below entry.
- MCP ecosystem norm (Composio $29/mo, Smithery freemium tiers) sits at $29-229/mo for indie/team. VP annual-only is differentiator.
- Letta = single product (formerly MemGPT). Treated as one B2 entry.

B2 deep scrape will produce features×tier matrix for landing comparison table + blog articles "VantagePeers vs <X>".

## Psychological pricing thresholds (from psychological.md)

- **Solo €49/year** sits below the sub-€60 "no-friction self-serve" zone for B2B dev tools 2026. Validated.
- **Annual-only at launch** trades breadth for LTV (Paddle: up to 4× LTV vs monthly). Self-Hosted free tier is the natural trial path — mitigates the conversion penalty.
- **Team €290/year flat** = ~€58/seat at 5 seats. 2-8× below per-seat market norms (Notion AI, GitHub Copilot Business). Validated.
- **6× ratio Solo→Team** explained by 1→5 seat bundle. Comparable to Notion/Raycast bundle ratios.
- **Book a call Enterprise** = correct choice. Visitor-to-lead 0.7% expected at this segment.
- **Launch price badge** must include hard expiry date + stated future price (e.g. "€49/year, rising to €79 on YYYY-MM-DD"). Perpetual badges = dark pattern signal.

## Anchor pricing (from anchors.md)

VP Solo €49/year is the **lowest annual commit in the cluster** (next anchor: Plausible Starter €79/year). Clear €30/year headroom for v2 pricing (€49 launch → €79 GA). VP Team €290/year flat is **2-7× cheaper than per-seat equivalents** at 5 seats (e.g. Copilot Business 5 seats = €1,000/year). Tally €200/year flat-fee precedent validates the model.

12 anchors checked, **9/12 in USD** — VP EUR-primary is a European-trust differentiator.

## Launch frame integration (Pi Day 62 directive)

1. **Annual ONLY at launch** (no monthly until PMF).
2. **Aggressive launch pricing** — €49/€290 already 50-70% below market median per anchors + competitive findings.
3. **Lifetime founding tier** — 2× annual (€99 / €590), quantity-capped 100 Solo / 25 Team (per Pi Day 62 directive: "scarcity tangible + lifetime data on early adopters").
4. **Money-back guarantee 30 days** recommended (anchors finding) — reduces annual-commit friction.
5. **EUR-primary display** — already correct.
6. **Launch badge** must include hard expiry + stated future price ("rising to €79/year on [v2 launch date]").

## Plan B (fallback if Lifetime quantity-capped underperforms)

- Switch Lifetime to **60-day rolling window** (not quantity-capped) — generates urgency without inventory management.
- Tradeoff: less scarcity signal on landing, more flexibility on ops side.
- Rotate badge text: "Founding price valid until [date+60]."

## Open watch items (post-launch v2)

- If 2-4 seat teams emerge as a meaningful segment, add **€149/year "Small Team" tier** (up to 3 seats).
- Re-evaluate monthly tier after PMF signal (~6-12 months post-launch).
- If Lifetime caps fill <30 days, consider expanding by 50 seats or pricing v2 increase.

## Decisions register

| # | Decision | Source axis | Status |
|---|----------|-------------|--------|
| 1 | Solo €49/year (launch) | Personas + Anchors + Psychological | RECOMMENDED |
| 2 | Team €290/year flat (~5 seats) | Personas + Anchors + Psychological | RECOMMENDED |
| 3 | Enterprise Book-a-call | Anchors + Psychological | RECOMMENDED |
| 4 | Lifetime Solo €99 (2× annual), 100 seats cap | Pi Day 62 directive | RECOMMENDED |
| 5 | Lifetime Team €590 (2× annual), 25 seats cap | Pi Day 62 directive | RECOMMENDED |
| 6 | Annual ONLY (no monthly at launch) | Pi Day 62 directive + Psychological | RECOMMENDED |
| 7 | EUR-primary display | Anchors | RECOMMENDED |
| 8 | 30-day money-back guarantee | Anchors | RECOMMENDED |
| 9 | Launch price badge with hard expiry | Psychological | RECOMMENDED |
| 10 | Top-8 competitors for B2 deep scrape | Competitive Phase 1 | AWAITING LAURENT GATE |

## References

- Source briefing: `js7546k46zfmceckg6edk7ww1s869kws`
- Phase 1 artifacts: `decisions/pricing-research/vantagepeers-cloud/{personas,competitive-candidates,psychological,anchors}.md`
- Phase 2 artifacts (pending): `competitive.md` + `competitive-comparison-table.md` + `competitive-blog-data.json` (post-gate)
- Skill: `pricing-research v1.1.0` (VantageRegistry)
- Template: `pricing-research-v1 v1.1.0` (VantageRegistry)

Orchestrator: Sigma — VantageOS Team Infra | 2026-05-07
