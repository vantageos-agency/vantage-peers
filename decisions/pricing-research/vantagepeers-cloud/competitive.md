# Competitive Deep Scrape — VantagePeers Cloud
## Phase B2: Full Competitor Data

**Mission**: D62-Sigma-Pricing-Research-VP-Cloud (k5740rr49eg0aj4d0xeag64wm5868sxv)
**Analyst**: Sigma — VantageOS Team Infra
**Last scraped**: 2026-05-07
**Methodology**: WebFetch (Firecrawl MCP unavailable in environment; fallback to direct fetch with JS-rendered public pages) + WebSearch for cross-validation
**Competitors covered**: mem0, Zep, supermemory.ai, Letta, Pinecone, Weaviate, Smithery.ai, Composio

---

## 1. mem0

**URL**: https://mem0.ai | **Pricing**: https://mem0.ai/pricing  
**Last scraped**: 2026-05-07  
**Tagline**: "AI memory that persists across sessions and agents"  
**Category**: Managed memory API (agent-native)  
**Backing**: Y Combinator, $24M Series A  

### Tier Table

| Tier | Price | Period | Add Requests/mo | Retrieval Requests/mo | End Users | Support |
|------|-------|--------|-----------------|----------------------|-----------|---------|
| **Hobby** | $0 | Monthly | 10,000 | 1,000 | Unlimited | Community |
| **Starter** | $19 | Monthly | 50,000 | 5,000 | Unlimited | Community |
| **Pro** | $249 | Monthly | 500,000 | 50,000 | Unlimited | Private Slack |
| **Enterprise** | Flexible / Contact sales | Custom | Unlimited | Unlimited | Unlimited | Private Slack + SLA |

**Annual discount**: None publicly listed. Monthly-only billing.  
**Usage-based alternative**: Available for custom needs (contact required).  

### Feature × Tier Matrix

| Feature | Hobby | Starter | Pro | Enterprise |
|---------|-------|---------|-----|------------|
| Semantic search | ✅ | ✅ | ✅ | ✅ |
| Knowledge graph | ❌ | ❌ | ✅ | ✅ |
| Multi-project support | ❌ | ❌ | ✅ | ✅ |
| Advanced analytics | ❌ | ❌ | ✅ | ✅ |
| On-prem deployment | ❌ | ❌ | ❌ | ✅ |
| SSO | ❌ | ❌ | ❌ | ✅ |
| Audit logs | ❌ | ❌ | ❌ | ✅ |
| Custom integrations | ❌ | ❌ | ❌ | ✅ |
| SLA | ❌ | ❌ | ❌ | ✅ |
| SOC 2 / HIPAA | ❌ | ❌ | ✅ | ✅ |
| MCP server | ✅ | ✅ | ✅ | ✅ |
| Self-hostable (OSS) | ✅ | — | — | ✅ (on-prem) |

### Free Tier Analysis

Hobby tier: 10K add requests + 1K retrieval/month. No credit card required. Designed for dev/prototype use. Conversion path: developers hit limits at modest usage (10K adds ≈ ~330 adds/day) and are nudged to Starter $19/mo. No time limit — perpetual free tier.

**OpenMemory MCP**: mem0 also ships a separate free, local-first, self-hosted MCP memory server (https://mem0.ai/blog/introducing-openmemory-mcp). Competes directly with VantagePeers Self-Hosted.

### Notes / Observations

1. **Pricing architecture is ops-heavy, not seat-based.** Developers must budget based on agent call volume, making monthly bills unpredictable. VantagePeers annual flat pricing is a direct positioning advantage.
2. **Knowledge graph gated at $249/mo Pro.** Competitors (Zep) include graph at all paid tiers. Significant value gap at $19/mo tier.
3. **No annual billing.** At $249/mo, Pro = $2,988/year. VantagePeers Cloud Solo at €49/year is 98% cheaper for single-user MCP-native use cases.
4. **Series A $24M** (2024) with Y Combinator backing. Well-funded but commercialisation is API-infrastructure oriented — not MCP-first.
5. **Startup Program** (up to $5M funding → 3 months Pro free + priority support) targets developer-tool builders; indirect competitor for VantagePeers' dev-persona.

### Sources

- https://mem0.ai/pricing (scraped 2026-05-07)
- https://mem0.ai (homepage, scraped 2026-05-07)
- https://dev.to/anajuliabit/mem0-vs-zep-vs-langmem-vs-memoclaw-ai-agent-memory-comparison-2026-1l1k
- https://vectorize.io/articles/mem0-vs-zep
- https://mem0.ai/blog/introducing-openmemory-mcp

---

## 2. Zep

**URL**: https://www.getzep.com | **Pricing**: https://www.getzep.com/pricing/  
**Last scraped**: 2026-05-07  
**Tagline**: "Agents fail without the right context. Getting it right is hard. We fixed it."  
**Category**: Context engineering & agent memory platform  
**Architecture**: Temporal knowledge graph (Graphiti engine)  

### Tier Table

| Tier | Price | Period | Credits/mo | Overage | Projects | Rate Limit | API Logs |
|------|-------|--------|------------|---------|---------|------------|---------|
| **Free** | $0 | Monthly | 1,000 | None | 2 | Variable (low priority) | — |
| **Flex** | $125 | Monthly | 50,000 | $25 / 10K credits | 5 | 600 req/min | 1 day |
| **Flex Plus** | $375 | Monthly | 200,000 | $75 / 40K credits | 10 | 1,000 req/min | 7 days |
| **Enterprise** | Contact sales | Custom | Custom | Negotiated | Unlimited | Guaranteed SLA | 30+ days |

**Credit model**: Episodes ≤350 bytes = 1 credit; each additional 350 bytes = +1 credit. Webhook invocations = 0.125 credits each.  
**Auto-topup**: Flex at 20% threshold; 30-day rollover. Flex Plus: 60-day rollover.  
**Annual discount**: Not publicly listed — monthly-only.  

### Feature × Tier Matrix

| Feature | Free | Flex | Flex Plus | Enterprise |
|---------|------|------|-----------|------------|
| Temporal knowledge graph | ✅ | ✅ | ✅ | ✅ |
| GraphRAG retrieval | ✅ | ✅ | ✅ | ✅ |
| Entity resolution | ✅ | ✅ | ✅ | ✅ |
| Fact invalidation (temporal) | ✅ | ✅ | ✅ | ✅ |
| Custom entity types | 5 | 10 | 20 | Unlimited |
| Custom edge types | 5 | 10 | 20 | Unlimited |
| Custom extraction instructions | ❌ | ❌ | ✅ | ✅ |
| Webhooks | ❌ | ❌ | ✅ | ✅ |
| Analytics | ❌ | ❌ | ✅ | ✅ |
| SOC 2 Type II | ❌ | ✅ | ✅ | ✅ |
| HIPAA BAA | ❌ | ❌ | ❌ | ✅ |
| BYOK / BYOM / BYOC | ❌ | ❌ | ❌ | ✅ |
| Audit logs | ❌ | ❌ | ❌ | ✅ |
| MCP server | ✅ | ✅ | ✅ | ✅ |
| Self-hostable (Graphiti OSS) | ✅ (raw) | — | — | ✅ (BYOC) |

### Free Tier Analysis

1,000 credits/month = very limited for real usage (1,000 small episodes). No rollover, no auto-topup. Positioned as proof-of-concept only. Conversion path: developers exhausting 1K credits quickly upgrade to Flex $125/mo. High friction for price-sensitive devs — Zep explicitly deprecated open-source self-hosted CE, forcing cloud adoption.

### Notes / Observations

1. **Credit system complexity** is a buyer friction point. Developers cannot easily predict monthly costs without instrumenting episode byte sizes. Flat annual pricing (VantagePeers) is a direct simplicity differentiator.
2. **Temporal graph is Zep's moat** — no other competitor in this list offers first-class time-validity on facts. But it's overkill for most VantagePeers target personas (solo devs, trainers, coaches).
3. **$125/mo Flex** = $1,500/year minimum. VantagePeers Solo €49/year is 97% cheaper with MCP-native persistent memory for comparable single-user workflows.
4. **Deprecated self-hosted CE** — Zep removed the community self-hosted edition, signaling full-cloud pivot. Creates resentment in dev community — positioning opportunity for VantagePeers.
5. **LongMemEval benchmark**: Zep scores 63.8% vs mem0 49.0% — superior recall accuracy at equivalent price points.

### Sources

- https://www.getzep.com/pricing/ (scraped 2026-05-07)
- https://www.getzep.com (homepage, scraped 2026-05-07)
- https://vectorize.io/articles/mem0-vs-zep
- https://dev.to/anajuliabit/mem0-vs-zep-vs-langmem-vs-memoclaw-ai-agent-memory-comparison-2026-1l1k
- https://atlan.com/know/zep-vs-mem0/

---

## 3. supermemory.ai

**URL**: https://supermemory.ai | **Pricing**: https://supermemory.ai/pricing/  
**Last scraped**: 2026-05-07  
**Tagline**: "The memory layer for AI agents"  
**Category**: Managed memory API + MCP server + developer plugins  
**Notable**: Explicit Claude Code + Cursor integration; MCP server card published  

### Tier Table

| Tier | Price | Period | Tokens/mo | Search Queries/mo | Storage | Users |
|------|-------|--------|-----------|------------------|---------|-------|
| **FREE** | $0 | Monthly | 1,000,000 | 10,000 | Unlimited | Unlimited |
| **PRO** | $19 | Monthly | 3,000,000 | 100,000 | Unlimited | Unlimited |
| **SCALE** | $399 | Monthly | 80,000,000 | 20,000,000 | Unlimited | Unlimited |
| **ENTERPRISE** | Contact sales | Custom | Unlimited | Unlimited | Unlimited | Unlimited |

**Overage rates (Pro/Scale)**: $0.01 per 1,000 tokens; $0.10 per 1,000 queries beyond plan limits.  
**Annual discount**: Not publicly listed — monthly-only billing.  
**Startup program**: $1,000 credits over 6 months with dedicated support.  

### Feature × Tier Matrix

| Feature | FREE | PRO | SCALE | ENTERPRISE |
|---------|------|-----|-------|------------|
| Unlimited storage | ✅ | ✅ | ✅ | ✅ |
| Unlimited users | ✅ | ✅ | ✅ | ✅ |
| Multi-modal extraction | ✅ | ✅ | ✅ | ✅ |
| Codex plugin | ✅ | ✅ | ✅ | ✅ |
| Claude Code plugin | ❌ | ✅ | ✅ | ✅ |
| Cursor plugin | ❌ | ✅ | ✅ | ✅ |
| OpenCode plugin | ❌ | ✅ | ✅ | ✅ |
| Gmail connector | ❌ | ❌ | ✅ | ✅ |
| S3 connector | ❌ | ❌ | ✅ | ✅ |
| Web Crawler connector | ❌ | ❌ | ✅ | ✅ |
| Custom integrations | ❌ | ❌ | ❌ | ✅ |
| SSO | ❌ | ❌ | ❌ | ✅ |
| Forward-deployed engineer | ❌ | ❌ | ❌ | ✅ |
| Priority support | ❌ | ✅ | ❌ | — |
| Dedicated support | ❌ | ❌ | ✅ | ✅ |
| Memory graph (semantic) | ✅ | ✅ | ✅ | ✅ |
| Hybrid search (vector + BM25) | ✅ | ✅ | ✅ | ✅ |
| MCP server | ✅ | ✅ | ✅ | ✅ |

### Free Tier Analysis

1M tokens/month + 10K searches is generous for personal/dev use. No seat cap. Claude Code plugin locked to paid (Pro $19/mo) — notable friction for VantagePeers' exact target user (Claude Code devs). Conversion path: Claude Code user hits free tier and immediately needs $19/mo to unlock the plugin.

### Notes / Observations

1. **Most direct MCP competitor**. supermemory.ai explicitly targets Claude Code users at $19/mo. VantagePeers Cloud Solo at €49/year (≈€4.08/month equivalent) is 79% cheaper annually for the same user persona.
2. **Token + query model** is usage-based, creating potential bill anxiety at scale. VantagePeers flat pricing is simpler.
3. **Claude Code plugin locked at paid tier ($19/mo)** — confirms that MCP/Claude Code is a paid-tier value driver, not a free differentiator, in the market.
4. **No annual billing.** $19/mo = $228/year. VantagePeers €49/year is a strong price anchor against supermemory.
5. **Data residency**: Privacy policy covers GDPR/CCPA but no explicit EU-only hosting option. VP EUR-primary is a differentiation point for EU personas.

### Sources

- https://supermemory.ai/pricing/ (scraped 2026-05-07)
- https://supermemory.ai (homepage, scraped 2026-05-07)
- https://supermemory.ai/privacy-policy
- https://betterstack.com/community/guides/ai/memory-with-supermemory/

---

## 4. Letta (formerly MemGPT)

**URL**: https://www.letta.com | **Pricing**: https://www.letta.com/pricing  
**Docs pricing**: https://docs.letta.com/guides/cloud/plans/  
**Last scraped**: 2026-05-07  
**Tagline**: "Memory-first agents that continually learn"  
**Category**: Stateful agent framework + cloud hosting  
**Origin**: MemGPT research project, UC Berkeley; $10M Series A  

### Tier Table (Personal Plans — Letta Code / chat.letta.com)

| Tier | Price | Period | Agents | Model Access | Letta Auto Limit |
|------|-------|--------|--------|-------------|-----------------|
| **Pro** | $20 | Monthly | Up to 20 | Open-weights models + PAYG frontier | Base |
| **Max Lite** | $100 | Monthly | Up to 50 | All frontier model providers (quota) | 5× |
| **Max** | $200 | Monthly | Up to 50 | Frontier models (increased quota) | 20× |

**Personal use only.** Max plan explicitly restricted to personal use; teams must use API Plan.

### API Plan (Organizations / Teams)

| Component | Rate |
|-----------|------|
| Base fee | $20/month |
| Active agent fee | $0.10/active agent/month |
| Tool execution (server-side) | $0.00015/second |
| LLM usage | PAYG at provider token rates |
| Built-in tools | Free (except web search/fetch) |
| Remote MCP tools | Free |
| Client-side tools | Free |

**Enterprise**: Custom pricing — volume discounts, RBAC, SAML/OIDC SSO, dedicated support.  
**Annual discount**: None publicly listed — monthly-only.  
**Free tier**: None for API Platform. Personal plan has no free tier listed.  
**BYOK**: Supported on all plans.  

### Feature × Tier Matrix

| Feature | Pro ($20) | Max Lite ($100) | Max ($200) | API Plan ($20 base) |
|---------|-----------|-----------------|------------|---------------------|
| Stateful agents | ✅ (20 max) | ✅ (50 max) | ✅ (50 max) | ✅ (unlimited) |
| Memory palace visualization | ✅ | ✅ | ✅ | ✅ |
| Dream agents (background learning) | ✅ | ✅ | ✅ | ✅ |
| Model portability (transfer memory) | ✅ | ✅ | ✅ | ✅ |
| Letta Auto (AI reasoning) | Base | 5× | 20× | PAYG |
| Open-weights models | ✅ | ✅ | ✅ | PAYG |
| Frontier models (GPT-4o, Claude, etc.) | PAYG | Quota | Increased quota | PAYG |
| Remote MCP tool execution | Free | Free | Free | Free |
| Server-side tool execution | Credits | Credits | Credits | $0.00015/sec |
| Multi-user / team workspaces | ❌ | ❌ | ❌ | ✅ (API Plan) |
| RBAC / SAML SSO | ❌ | ❌ | ❌ | Enterprise only |
| Early feature access | ❌ | ❌ | ✅ | — |
| SLA | ❌ | ❌ | ❌ | Enterprise only |

### Free Tier Analysis

No public free tier for Letta Cloud. Self-hosted (open source) is the free entry path — Letta's GitHub repo is fully open. This mirrors VantagePeers Self-Hosted model. Conversion path: self-host → hit friction (ops burden) → upgrade to $20/mo API plan.

### Notes / Observations

1. **Framework layer, not just memory layer.** Letta bundles agent execution framework + memory. VantagePeers is memory/context only (MCP-native). Different jobs-to-be-done; indirect overlap.
2. **No free cloud tier** creates a harder cold-start vs. competitors. API Plan $20/mo base + $0.10/active agent means a 10-agent dev workflow costs $21/mo minimum + LLM usage.
3. **Model portability** is genuinely unique: transfer agent memories across LLM providers. No competitor (including VantagePeers) offers this.
4. **MCP is free** (remote MCP tool execution incurs no charges on any plan) — a positive signal for MCP ecosystem adoption pricing norm.
5. **"Personal use only" restriction** on Max plans is a red flag for teams — forced onto API Plan which has unpredictable billing.

### Sources

- https://www.letta.com/pricing (scraped 2026-05-07)
- https://docs.letta.com/guides/cloud/plans/ (scraped 2026-05-07)
- https://docs.letta.com/guides/build-with-letta/pricing/ (scraped 2026-05-07)
- https://www.letta.com (homepage, scraped 2026-05-07)
- https://www.hpcwire.com/bigdatawire/this-just-in/letta-emerges-from-stealth-with-10m-to-build-ai-agents-with-advanced-memory/

---

## 5. Pinecone

**URL**: https://www.pinecone.io | **Pricing**: https://www.pinecone.io/pricing/  
**Last scraped**: 2026-05-07  
**Tagline**: "Build Knowledgeable AI"  
**Category**: Managed vector database (serverless)  
**Backing**: Enterprise-grade; SOC 2, HIPAA, GDPR, ISO 27001  

### Tier Table

| Tier | Price | Period | Storage | Write Units/mo | Read Units/mo | Support |
|------|-------|--------|---------|---------------|--------------|---------|
| **Starter** | $0 | Monthly | 2 GB | 2,000,000 | 1,000,000 | Discord community |
| **Builder** | $20 flat | Monthly | 10 GB | 5,000,000 | 2,000,000 | Included + optional SLA add-ons |
| **Standard** | $50 minimum | Monthly (PAYG) | Unlimited ($0.33/GB) | PAYG: $4–$4.50/M | PAYG: $16–$18/M | Standard support |
| **Enterprise** | $500 minimum | Monthly (PAYG) | Unlimited ($0.33/GB) | PAYG: $6–$6.75/M | PAYG: $24–$27/M | Pro support included |

**Additional costs**:
- Storage: $0.33/GB/month (Standard+)
- Backups: $0.10/GB/month
- HIPAA add-on: $190/month (Standard tier)
- Import from object storage: $1/GB

**Standard 3-week trial**: $300 credits included.  
**Annual discount**: Not publicly listed — monthly billing.  
**Cloud availability**: AWS, GCP, Azure, AWS Marketplace.  

### Feature × Tier Matrix

| Feature | Starter | Builder | Standard | Enterprise |
|---------|---------|---------|----------|------------|
| Serverless vector search | ✅ | ✅ | ✅ | ✅ |
| Namespace isolation | ✅ | ✅ | ✅ | ✅ |
| Multiple projects | ❌ | ✅ | ✅ | ✅ |
| Prometheus/Datadog monitoring | ❌ | ✅ | ✅ | ✅ |
| Dedicated Read Nodes | ❌ | ❌ | Optional | ✅ |
| SAML SSO | ❌ | ❌ | Optional | ✅ |
| Backup/restore | ❌ | ❌ | ✅ | ✅ |
| Private networking | ❌ | ❌ | ❌ | ✅ |
| Customer managed encryption | ❌ | ❌ | ❌ | ✅ |
| Audit logs | ❌ | ❌ | ❌ | ✅ |
| HIPAA compliance | ❌ | ❌ | Add-on ($190/mo) | ✅ (built-in) |
| 99.95% uptime SLA | ❌ | ❌ | ❌ | ✅ |
| MCP / Claude Code plugin | ✅ | ✅ | ✅ | ✅ |
| BYOC | ❌ | ❌ | ❌ | ✅ |

### Free Tier Analysis

Starter: 2GB / 2M writes / 1M reads — functional for dev use. No time limit. Conversion path: growing apps hit storage limit and move to Standard ($50/mo minimum). Claude Code plugin: `claude plugin install pinecone` available at all tiers.

### Notes / Observations

1. **Not a direct competitor** — Pinecone is a vector database infrastructure layer. Developers must build their own memory layer on top. VantagePeers provides the memory-management semantics Pinecone lacks (session context, task tracking, MCP protocol).
2. **Pricing is engineer-budget territory** ($50–$500+/month minimum). VantagePeers Solo at €49/year targets a different buyer (individual dev, no infrastructure budget).
3. **Claude plugin** (`claude plugin install pinecone`) shows Pinecone is competing for Claude Code dev mindshare. Important ecosystem signal.
4. **HIPAA as a $190/mo add-on** on Standard — expensive compliance tax that Enterprise includes. Relevant for healthcare-adjacent agent deployments.

### Sources

- https://www.pinecone.io/pricing/ (scraped 2026-05-07)
- https://www.pinecone.io (homepage, scraped 2026-05-07)

---

## 6. Weaviate Cloud

**URL**: https://weaviate.io | **Pricing**: https://weaviate.io/pricing  
**Last scraped**: 2026-05-07  
**Tagline**: "The AI database developers love"  
**Category**: AI-native vector database (managed cloud)  
**Community**: 50,000+ AI builders  

### Tier Table

| Tier | Starting Price | Period | Deployment | Uptime SLA | Support |
|------|---------------|--------|------------|-----------|---------|
| **Free Trial** | $0 | 14-day, then PAYG | Shared cloud sandbox | None stated | Forum only |
| **Flex** | $45 | Monthly (PAYG, no commitment) | Shared cloud | 99.5% | Email (next business day) |
| **Premium** | $400 | Monthly (prepaid contract) | Shared or dedicated | 99.5–99.95% | 1-hr Severity 1 response |
| **Enterprise** | Contact sales | Custom contract | Dedicated + BYOC | 99.95%+ | TAM + phone + Slack |

### Usage-Based Pricing (Flex rates)

| Dimension | Flex Rate | Premium Rate |
|-----------|-----------|--------------|
| Vector Dimensions | $0.0139/1M dims | $0.00975/1M dims |
| Storage | $0.255/GiB | $0.31875/GiB |
| Backup | $0.0264/GiB | $0.033/GiB |

**Embeddings add-on**:
- Arctic-Embed-M-V1.5: $0.025/1M tokens
- Arctic-Embed-M-V2.0: $0.040/1M tokens
- ModernVBERT: $0.065/1M tokens

**Query Agent add-on**:
- Free Trial: 250 requests/month
- Flex: 30,000 requests/month included
- Premium: Unlimited requests
- Standalone: $30/month for 4,000 requests

**Data transfer**: Currently free (promotional period).  
**Annual discount**: None publicly listed — monthly billing.  
**Cloud providers**: GCP (Flex/Free); GCP + AWS + Azure (Premium).  

### Feature × Tier Matrix

| Feature | Free Trial | Flex | Premium |
|---------|-----------|------|---------|
| Hybrid search (dense + BM25) | ✅ | ✅ | ✅ |
| Dynamic indexing | ✅ | ✅ | ✅ |
| Compression (vector) | ✅ | ✅ | ✅ |
| Multi-tenancy | ✅ | ✅ | ✅ |
| Replication | ❌ | ✅ | ✅ |
| RBAC | ✅ | ✅ | ✅ |
| SSO/SAML | ❌ | ❌ | ✅ |
| Custom IdP | ❌ | ❌ | ✅ |
| PrivateLink | ❌ | ❌ | ✅ |
| Encrypted volumes | ❌ | ❌ | ✅ |
| HIPAA compliance | ❌ | ❌ | ✅ |
| Database Agents (built-in) | ✅ (limited) | ✅ | ✅ |
| Query Agent (NL→Query) | 250 req/mo | 30K req/mo | Unlimited |
| Dedicated cluster | ❌ | ❌ | ✅ |
| Technical Account Manager | ❌ | ❌ | ✅ |

### Free Tier Analysis

14-day sandbox trial — NOT a perpetual free tier. After 14 days, cluster converts to PAYG Flex (minimum $45/mo). This is a trial, not a freemium model. Conversion pressure higher than competitors with perpetual free tiers.

### Notes / Observations

1. **Infrastructure layer, not memory management.** Like Pinecone, Weaviate requires developers to implement their own memory abstraction. VantagePeers provides the application-layer semantics Weaviate lacks.
2. **$45/mo Flex minimum** — no truly perpetual free tier. Enterprise-leaning pricing profile. Not competing for the VantagePeers solo dev persona.
3. **"Database Agents"** feature (Query, Transformation, Personalization Agent types) shows vector DB vendors are moving up the stack toward agent-native offerings. Medium-term competitive signal.
4. **Premium $400/mo** = $4,800/year. Targets teams/enterprises, not indie devs.
5. **Data residency**: AWS + Azure + GCP regions with Premium. EU data residency achievable. Not explicitly marketed as EU-primary.

### Sources

- https://weaviate.io/pricing (scraped 2026-05-07)
- https://weaviate.io (homepage, scraped 2026-05-07)

---

## 7. Smithery.ai

**URL**: https://smithery.ai | **Pricing**: https://smithery.ai/pricing  
**Last scraped**: 2026-05-07  
**Tagline**: "Turn scattered context into skills for AI"  
**Category**: MCP server marketplace + managed hosting  
**Scale**: 7,000+ MCP servers hosted; major vendor integrations (Amplitude, Asana, Box, Salesforce)  

### Business Model

Smithery's pricing data is **not fully public** as of 2026-05-07. The pricing page (smithery.ai/pricing) returned 429/403 errors on direct scrape. Based on aggregated third-party sources:

| Component | Pricing |
|-----------|---------|
| Server listing | Free |
| Server discovery/browsing | Free |
| Server installation (local) | Free |
| Hosted MCP server execution | Usage-based (rates not publicly disclosed) |
| Vendor tiers | Hobby / Pro / Custom (exact prices not public) |
| Creator monetization | None — developers do not earn revenue share |

**No public monthly price for any vendor tier confirmed.** Smithery.ai pricing page was inaccessible (429 Too Many Requests during scrape period). Third-party analysis confirms freemium discovery model with usage-based hosting.

### Feature Breakdown (from public sources)

- **Discovery layer**: Free browse + install from 7,000+ server catalog
- **Hosted execution**: Smithery runs MCP servers on its infrastructure (no local install required)
- **Auth model**: Ephemeral token handling — config data not retained long-term
- **Usage tracking**: Call counts logged for hosted servers
- **Skills model**: "Turn scattered context into skills for AI" — aggregates MCP capabilities across servers
- **No revenue share for developers**: Developers list servers for free but do not receive payments

### Notes / Observations

1. **Blocker: No confirmed public pricing.** Smithery.ai pricing page inaccessible during scrape. All pricing data from third-party sources. Mark as "freemium with undisclosed hosted pricing" for comparison table.
2. **Not a memory competitor.** Smithery is a marketplace/distribution layer — VantagePeers could be listed on Smithery as a distributed MCP server, making it a potential distribution channel rather than a direct competitor.
3. **Ecosystem signal**: 7,000+ servers at scale validates the MCP marketplace model. Pricing being opaque suggests Smithery is still pre-monetization or pre-public for hosted tiers.
4. **No creator revenue share** is a notable gap vs. competitors (e.g., MCPize offers 80% revenue share). This limits developer incentive to build premium servers on Smithery.

### Sources

- https://smithery.ai (homepage — 403 on pricing page during scrape, 2026-05-07)
- https://mcpize.com/alternatives/smithery
- https://toolradar.com/blog/mcp-gateway
- https://workos.com/blog/smithery-ai
- https://composio.dev/blog/smithery-alternative
- https://smithery.ai/pricing (429 — included for reference)

---

## 8. Composio

**URL**: https://composio.dev | **Pricing**: https://composio.dev/pricing  
**Last scraped**: 2026-05-07  
**Tagline**: "Your agent decides what to do. We handle the rest."  
**Category**: Agent integration platform / MCP action layer  
**Backing**: $29M raised (noted in Phase B1 research)  

### Tier Table

| Tier | Price | Period | Tool Calls/mo | Overage Rate | Support |
|------|-------|--------|---------------|-------------|---------|
| **Free** | $0 | Monthly | 20,000 | None (rate-limited) | Community |
| **Starter** ("Ridiculously Cheap") | $29 | Monthly | 200,000 | $0.299/1K calls | Email |
| **Professional** ("Serious Business") | $229 | Monthly | 2,000,000 | $0.249/1K calls | Slack (1K+ users) |
| **Enterprise** | Contact sales | Custom | Custom | Custom | Dedicated SLA |

**Annual discount**: Not publicly listed — monthly-only billing.  
**Enterprise features**: Custom user accounts, dedicated SLA, SOC-2 compliance, custom API volume, VPC/on-premises deployment.  

### Feature × Tier Matrix

| Feature | Free | Starter | Professional | Enterprise |
|---------|------|---------|-------------|------------|
| 500+ app integrations | ✅ | ✅ | ✅ | ✅ |
| MCP client support (Claude Code, Cursor) | ✅ | ✅ | ✅ | ✅ |
| Managed OAuth | ✅ | ✅ | ✅ | ✅ |
| Sandboxed execution | ✅ | ✅ | ✅ | ✅ |
| Smart tool resolution | ✅ | ✅ | ✅ | ✅ |
| Bidirectional triggers | ✅ | ✅ | ✅ | ✅ |
| Email support | ❌ | ✅ | ✅ | ✅ |
| Slack support | ❌ | ❌ | ✅ (1K+ users) | ✅ |
| SOC-2 compliance | ❌ | ❌ | ❌ | ✅ |
| VPC / on-prem | ❌ | ❌ | ❌ | ✅ |
| Custom user accounts | ❌ | ❌ | ❌ | ✅ |
| Dedicated SLA | ❌ | ❌ | ❌ | ✅ |

### Free Tier Analysis

20K tool calls/month free — functional for light prototyping. No time limit. Conversion path: agents performing real work (e.g., Gmail, Slack, GitHub integrations) exhaust 20K calls quickly; upgrade to Starter $29/mo. MCP support is available at all tiers.

### Notes / Observations

1. **Different job-to-be-done.** Composio is an action/integration layer (connect agents to 500+ apps). VantagePeers is a memory/context layer. They complement rather than directly compete — a VantagePeers user could also use Composio.
2. **$29/mo Starter** is the market-setting price for "first paid tier in MCP-native dev tools" — consistent with supermemory.ai ($19/mo) and Letta API ($20/mo). Validates sub-€50/year is aggressive positioning for VantagePeers annual flat.
3. **No annual billing** across all competitors sampled — monthly billing is the universal norm. VantagePeers annual-only is unique and risk-bearing but supported by psychological research (axis C).
4. **MCP at all tiers** — Composio doesn't gate MCP behind paid tiers, validating that MCP-as-standard (not premium) is the emerging ecosystem norm.
5. **SOC-2 and VPC behind Enterprise** — same pattern as Pinecone, Weaviate, Zep. Compliance costs are industry-wide gated at enterprise tier.

### Sources

- https://composio.dev/pricing (scraped 2026-05-07)
- https://composio.dev (homepage, scraped 2026-05-07)
- https://toolradar.com/blog/mcp-gateway
- https://composio.dev/blog/smithery-alternative

---

## Cross-Competitor Summary

### Pricing model norms across 8 competitors

| Norm | # of 8 competitors | Notes |
|------|-------------------|-------|
| Monthly-only billing | 8/8 | 100% — VantagePeers annual-only is unique in this set |
| Public free tier (perpetual) | 5/8 | mem0, Zep, supermemory, Pinecone, Composio |
| Trial-only free (not perpetual) | 1/8 | Weaviate (14-day trial) |
| No public free tier | 2/8 | Letta, Smithery |
| First paid tier under $30/mo | 5/8 | mem0 $19, supermemory $19, Letta $20, Composio $29, Pinecone $20 |
| First paid tier $100+/mo | 3/8 | Zep $125, Weaviate $45, Letta Max Lite $100 |
| Annual pricing available | 0/8 | None in the set offer annual billing publicly |
| MCP support at free tier | 5/8 | mem0, Zep, supermemory, Pinecone, Composio |
| EU data residency option | 2/8 | Weaviate (Premium), Pinecone (AWS EU regions) |
| EUR-primary pricing | 0/8 | All price in USD |

### Annual cost equivalent comparison (single user, lowest paid tier)

| Competitor | Lowest paid tier | Monthly | Annual equiv (USD) | Annual equiv (EUR ~0.92) |
|------------|-----------------|---------|-------------------|--------------------------|
| mem0 | Starter | $19/mo | $228/year | ≈€210/yr |
| Zep | Flex | $125/mo | $1,500/year | ≈€1,380/yr |
| supermemory.ai | Pro | $19/mo | $228/year | ≈€210/yr |
| Letta | Pro | $20/mo | $240/year | ≈€221/yr |
| Pinecone | Builder | $20/mo | $240/year | ≈€221/yr |
| Weaviate | Flex | $45/mo | $540/year | ≈€497/yr |
| Smithery | No confirmed paid tier | — | — | — |
| Composio | Starter | $29/mo | $348/year | ≈€320/yr |
| **VantagePeers Cloud** | **Solo** | **≈€4.08/mo equiv** | **€49/year** | **€49/year** |

*EUR conversion at $1 = €0.92 (May 2026 approximate)*

---

*Report compiled: 2026-05-07 | Mission D62 Phase B2 | Analyst: Sigma*
