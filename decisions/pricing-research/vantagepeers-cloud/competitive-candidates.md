# Competitive Candidates — VantagePeers Cloud
## Phase B1: Discovery & Classification

**Mission**: D62-Sigma-Pricing-Research-VP-Cloud  
**Date**: 2026-05-07  
**Status**: GATE INPUT — awaiting Laurent APPROVE/REVISE before Phase B2 deep scrape  
**Analyst**: Sigma (strategy-researcher)

---

## Candidate List (13 candidates)

| # | Name | URL | Category | 1-Line Positioning | Pricing Band | Relevance (1-5) | Phase B2? |
|---|------|-----|----------|--------------------|--------------|-----------------|-----------|
| 1 | **mem0** | [mem0.ai](https://mem0.ai) · [pricing](https://mem0.ai/pricing) | Agent Memory / API | "The memory layer for AI apps" — managed API for persistent agent memory with vector + KV + graph storage | Free → $19/mo → $249/mo Pro → Enterprise | 5 | YES |
| 2 | **Zep** | [getzep.com](https://www.getzep.com) · [pricing](https://www.getzep.com/pricing/) | Agent Memory / Context Engineering | "Context engineering & agent memory platform for AI agents" — GraphRAG + memory, credit-based cloud | Free → $125/mo Flex → $375/mo Flex Plus → Enterprise | 5 | YES |
| 3 | **Letta** | [letta.com](https://www.letta.com) · [pricing](https://www.letta.com/pricing) | Agent Memory / Stateful Agents | "Build stateful agents with memory that learn and self-improve over time" — born from MemGPT (UC Berkeley) | Free self-host → $20/mo Pro → $200/mo Max → API plan $20/mo | 4 | YES |
| 4 | **supermemory.ai** | [supermemory.ai](https://supermemory.ai) · [pricing](https://supermemory.ai/pricing/) | Agent Memory / API + MCP | "Memory API for the AI era" — MCP server + memory API with browser extension and Claude Code integration | Free → $19/mo Pro → $399/mo Scale → Enterprise | 5 | YES |
| 5 | **Pinecone** | [pinecone.io](https://www.pinecone.io) · [pricing](https://www.pinecone.io/pricing/) | Vector Database / RAG | "The vector database to build knowledgeable AI" — serverless vector search, pays per read/write/storage unit | Free → ~$25/mo Starter → usage-based (10M vecs ≈ $70/mo) → Enterprise | 3 | YES |
| 6 | **Weaviate Cloud** | [weaviate.io](https://weaviate.io) · [pricing](https://weaviate.io/pricing) | Vector Database / AI-native | "AI-native vector database" — managed cloud with hybrid search (dense + BM25), multi-tenancy | Free 14-day trial → $25/1M dims/mo Serverless → Enterprise Dedicated | 3 | YES |
| 7 | **Chroma Cloud** | [trychroma.com](https://www.trychroma.com) · [pricing](https://www.trychroma.com/pricing) | Vector Database / Open-source hosted | "Open-source search infrastructure for AI" — object-storage-first, 10x lower cost positioning, SOC2 | Free (1M embeddings) → $100 credit tier → usage-based → Enterprise | 3 | NO — low overlap (pure vector infra, no MCP/memory layer) |
| 8 | **Qdrant Cloud** | [qdrant.tech](https://qdrant.tech) · [pricing](https://qdrant.tech/pricing/) | Vector Database / High-perf | "Vector search engine" — resource-based pricing (RAM/CPU/disk), strong write-heavy agent memory fit | Free (250K vecs) → $25-45/mo at 1M vecs → resource-based scale | 3 | NO — same reason as Chroma; pure infra, no agent orchestration layer |
| 9 | **Smithery.ai** | [smithery.ai](https://smithery.ai) · [pricing](https://smithery.ai/pricing) | MCP Server Marketplace / Hosting | "Turn scattered context into skills for AI" — discovery + hosted running of 7,300+ MCP servers | Free to list/browse → Hobby / Pro / Custom vendor tiers | 4 | YES |
| 10 | **mcpmarket.com** | [mcpmarket.com](https://mcpmarket.com) | MCP Server Registry / Directory | "Discover & install MCP servers for Cline" — directory/registry of 10,000+ MCP servers, one-click install | Free (directory/registry, no public paid tiers found) | 2 | NO — directory, not a memory/context SaaS; different business model |
| 11 | **LangSmith** | [langchain.com/langsmith](https://www.langchain.com/langsmith) | Agent Observability | "AI agent & LLM observability platform" — tracing, evals, prompt hub; per-seat model | Free dev → $39/mo/seat Plus → Enterprise custom | 2 | NO — observability, not memory/context storage; different purchase persona |
| 12 | **Langfuse** | [langfuse.com](https://langfuse.com) | Agent Observability / Open-source | "Open-source LLM engineering platform" — tracing, evals, prompt management; self-host or cloud | Free Hobby → $29/mo Core → $199/mo Pro → $2,499/mo Enterprise | 2 | NO — observability adjacent; competing for same dev budget but not same job-to-be-done |
| 13 | **Composio** | [composio.dev](https://composio.dev) | MCP Integration Platform / Tooling | "Connect agents to 500+ apps through a single managed MCP endpoint" — integration hub, not memory | Free 20K calls → $29/mo Standard → $229/mo Pro → Enterprise | 2 | NO — tool integrations/actions, not persistent memory or context storage |

---

## Candidate Notes

### Candidates added beyond Pi's initial list (with rationale)

- **Qdrant Cloud** — added: leading vector DB with explicit agent memory positioning and MCP wrapper; completes the "pure vector DB" tier alongside Pinecone/Weaviate
- **Chroma Cloud** — added: well-known open-source project launching managed cloud; relevant as budget alternative to Pinecone
- **LangSmith** — added: adjacent observability tool that competes for developer mindshare and budget in the agent tooling stack; helps understand buyer context
- **Langfuse** — added: open-source observability alternative to LangSmith; same rationale
- **Composio** — added: MCP-native integration platform that raised $29M; illustrates what else developers pay for in the MCP ecosystem

### Candidates from Pi's list assessed as not distinct

- **MemGPT** — not a separate product; Letta is the company and product that emerged from the MemGPT research project. Letta's docs refer to MemGPT as the underlying concept. Covered under Letta (#3).

### Candidates from Pi's list confirmed not in scope

- **mcpmarket.com** (#10) — directory/registry only; no recurring SaaS revenue model comparable to VantagePeers Cloud pricing structure. Retained for awareness, excluded from B2.

---

## Recommended Top 8 for Phase B2 Deep Scrape

| Priority | Name | Rationale |
|----------|------|-----------|
| 1 | **mem0** | Closest direct competitor — managed memory API + MCP server + pricing fully public; $19-249/mo range overlaps VantagePeers Cloud target |
| 2 | **Zep** | Direct competitor — GraphRAG + memory for agents, deprecated self-host to force cloud; pricing model (credits) contrasts with VantagePeers seat model |
| 3 | **supermemory.ai** | Direct competitor — explicit MCP integration + Claude Code focus matches VantagePeers use case exactly; $19/mo Pro is direct pricing anchor |
| 4 | **Letta** | Semi-direct — stateful agent memory + cloud hosting; $20/mo Pro and API plan are strong pricing anchors; different framing (agent framework vs. memory layer) |
| 5 | **Pinecone** | Adjacent / buyer comparison — developers evaluate Pinecone when building agent memory; understanding their pricing narrative helps position VantagePeers |
| 6 | **Weaviate Cloud** | Adjacent — enterprise-leaning vector DB cloud; useful for understanding mid/enterprise tier expectations |
| 7 | **Smithery.ai** | Ecosystem player — MCP server marketplace with vendor pricing tiers; relevant for distribution and pricing-by-MCP-capability framing |
| 8 | **Composio** | Ecosystem comparator — $29/mo Standard at 200K tool calls; shows what developers pay for MCP-native services at the indie/small-team level |

---

## Recommended Skip List (Phase B2)

| Name | Reason |
|------|--------|
| **ChromaDB Cloud** | Pure vector infra, no orchestration or memory layer; different buyer job-to-be-done |
| **Qdrant Cloud** | Same as above — strong infra product but not a memory/context management layer; overlaps with Pinecone coverage |
| **mcpmarket.com** | Directory/registry, not a SaaS with comparable pricing model |
| **LangSmith** | Observability, not memory storage; different purchase motion (traces vs. context persistence) |
| **Langfuse** | Same as LangSmith; the open-source self-host option also reduces direct comparability |
| **Composio** | Tool integrations, not persistent memory; retained in top-8 only as ecosystem comparator for MCP pricing norms |

---

## Open Questions for Laurent (Gate)

1. **Scope confirmation**: Should the deep scrape include pure vector DB SaaS (Pinecone, Weaviate) even though they require the buyer to build their own memory layer on top? Or focus exclusively on "out-of-box agent memory" products (mem0, Zep, Letta, supermemory)?

2. **MCP ecosystem pricing**: Smithery and Composio are included as MCP-ecosystem comparators, not direct competitors. Is this framing useful for the synthesis, or should Phase B2 stay tighter on memory-only products?

3. **Microsoft Foundry**: Azure's managed long-term memory store (mcp.ai.azure.com) was surfaced in research. It's enterprise-only and not directly comparable, but it signals where the hyperscalers are moving. Worth a lightweight mention in the final report?

4. **OpenMemory MCP** (by mem0): Free, local-first, self-hosted MCP memory tool. This is essentially mem0's open-source play that competes with VantagePeers Self-Hosted. Not added as a separate row because it's a product of mem0 (already #1), but may need a footnote in the competitive report.

5. **Annual vs. monthly pricing**: Most competitors price monthly. VantagePeers Cloud doctrine is annual-only. Phase B2 should surface whether any competitor has successfully executed annual-only pricing in the dev-tools segment, or whether this is a risk factor.

---

## Sources

- [mem0 Pricing Page](https://mem0.ai/pricing)
- [Zep Pricing Page](https://www.getzep.com/pricing/)
- [Letta Pricing Page](https://www.letta.com/pricing)
- [supermemory.ai Pricing](https://supermemory.ai/pricing/)
- [Pinecone Pricing](https://www.pinecone.io/pricing/)
- [Weaviate Cloud Pricing](https://weaviate.io/pricing)
- [ChromaDB Pricing](https://www.trychroma.com/pricing)
- [Qdrant Cloud Pricing](https://qdrant.tech/pricing/)
- [Smithery.ai Pricing](https://smithery.ai/pricing)
- [Composio Pricing (search result)](https://composio.dev)
- [Langfuse Pricing 2026 — CostBench](https://costbench.com/software/ai-observability/langfuse/)
- [LangSmith Pricing 2026 — CostBench](https://costbench.com/software/ai-observability/langsmith/)
- [Mem0 vs Zep vs Letta — Vectorize](https://vectorize.io/articles/mem0-vs-letta)
- [Best AI Agent Memory Systems 2026 — Vectorize](https://vectorize.io/articles/best-ai-agent-memory-systems)
- [Top 6 AI Agent Memory Frameworks 2026 — DEV Community](https://dev.to/nebulagg/top-6-ai-agent-memory-frameworks-for-devs-2026-1fef)
- [8 Best MCP Deployment Platforms — Prefect](https://www.prefect.io/resources/best-mcp-deployment-platforms-enterprise-2026)
- [Smithery AI overview — WorkOS](https://workos.com/blog/smithery-ai)
- [Mem0 Series A announcement](https://mem0.ai/series-a)
- [Letta $10M funding — BigDATAwire](https://www.hpcwire.com/bigdatawire/this-just-in/letta-emerges-from-stealth-with-10m-to-build-ai-agents-with-advanced-memory/)
- [OpenMemory MCP launch — mem0 blog](https://mem0.ai/blog/introducing-openmemory-mcp)
