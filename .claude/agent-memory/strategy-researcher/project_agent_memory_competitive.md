---
name: Agent Memory Competitive Research — March 2026
description: Deep research findings on mem0, Zep, Letta, Supermemory, LangMem, Motorhead, Cognee — pricing, architecture, and gaps that validate VantageMemory's differentiation
type: project
---

Full analysis saved at /root/coding/vantage-memory/docs/research-agent-memory.md (2026-03-25).

Key validated facts for VantageMemory positioning:

**Pricing — All are expensive at production scale:**
- Mem0: $249/mo to unlock graph memory (core competitive feature); + hidden LLM extraction costs
- Zep: $475/mo Flex Plus; Community Edition deprecated April 2025 — forced cloud lock-in
- Letta: API plan $20/mo + $0.10/active agent/mo + tool execution fees
- Cognee on-prem: €1,970/mo
- Free tiers are pre-production only (Zep: 1K episodes/mo; Mem0: 10K memories)

**Architecture — All solve only memory retrieval:**
- None provide inter-agent messaging
- None provide task management
- None provide multi-agent memory consistency guarantees
- Multi-agent coordination left entirely to application developers

**Self-hosting deteriorating:**
- Zep Community Edition abandoned April 2025
- Mem0 graph features cloud-only
- Supermemory requires enterprise agreement for self-hosting
- Only Letta (full) and LangMem (MIT, LangGraph-only) offer unrestricted self-hosting

**Benchmark reality (LoCoMo, Feb 2026):**
- Best score: EverMemOS 92.3% (closed, requires cloud LLM)
- Zep ~85%, Letta ~83%, Mem0 ~66% (self-reported, disputed by Zep founder)
- Benchmark only tests fact retrieval — does NOT test multi-agent coordination, task recall, or consistency

**The unsolved problem (industry research evidence):**
- 36.9% of multi-agent failures caused by inter-agent misalignment (inconsistent shared state)
- 40-80% of multi-agent implementations derailed by poor coordination + memory management
- Multi-agent systems use 15x more tokens than single-agent due to redundant retrieval
- No product provides atomic memory updates, read-your-writes consistency, or lock semantics across agents

**VantageMemory differentiation (validated as unique):**
1. Memory + Messaging + Task Management in one system — no competitor combines all three
2. Native multi-agent coordination (channels, broadcast, receipts) — no competitor has this
3. Transparent pricing without hidden LLM extraction overhead

**Why:** Laurent asked for factual backing of the claim "all are imperfect and expensive." This research confirms it with specific numbers and structural gaps.
**How to apply:** Use these findings in positioning documents, investor materials, and feature prioritization decisions. The "no messaging + no task management" gap is the strongest differentiated narrative.
