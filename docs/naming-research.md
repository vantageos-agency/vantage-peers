# VantageMemory — Product Naming Research

**Date:** 2026-03-25
**Scope:** Rename evaluation for the open-source multi-agent coordination platform (memory + messaging + tasks + diary) built for Claude Code via MCP.

---

## Executive Summary

- **"vantage-memory" is available on npm and vantagememory.* domains show no DNS records**, making the current name registerable — but the name undersells the product's full scope.
- The best-available names in the target conceptual space are **SwarmState** and **CortexSync** — both have clean npm availability, available .dev/.io domains, and communicate more of the full feature surface.
- The MCP multi-agent space is crowding fast (agent-nexus, agent-mesh, ruflo, claude-flow all exist); names that lean into "state" or "fabric" rather than "memory" or "hub" will differentiate more cleanly.
- Three candidates deserve serious consideration: **SwarmState**, **CortexSync**, and retaining **VantageMemory** with a subtitle strategy.

---

## Research Methodology

- npm registry API (`registry.npmjs.org`) — direct 404 = available, 200 = taken
- GitHub org/user URL resolution — 404 = handle available
- DNS resolution (`dig`) as proxy for domain registration — no A/NS/SOA record = likely available
- Web search for competitive context and existing brand associations

---

## Competitive Landscape Context

The multi-agent Claude Code tooling space has exploded in early 2026:

| Project | What it does | Relevance |
|---|---|---|
| **agent-nexus** (npm 1.0.9) | Multi-terminal Claude Code communication via SQLite + MCP | Direct competitor |
| **claude-flow** (npm) | Agent orchestration for Claude | Adjacent |
| **ruflo** | Full orchestration platform for Claude swarms | Adjacent |
| **mcp-memory-service** | Shared memory/knowledge graph for agent pipelines | Partial overlap |
| **Agent-MCP** (GitHub) | Multi-agent coordination framework via MCP | Adjacent |

**Key implication:** the name must signal "this is the coordination layer for a Claude Code agent swarm" — not just "a memory plugin."

---

## Candidate Evaluation

### Candidates Researched

| Name | npm slug | npm available? | GitHub org available? | .dev domain | .io domain | .com domain |
|---|---|---|---|---|---|---|
| VantageMemory | `vantage-memory` | YES (404) | YES (404) | Likely available | Likely available | Likely available |
| AgentBrain | `agent-brain` | NO (taken, v1.0.0) | — | — | — | — |
| HiveMind | `hivemind` | NO (taken, v0.1.2) | — | — | — | — |
| SwarmMemory | `swarm-memory` | YES (404) | — | — | — | — |
| PeerBrain | `peer-brain` | YES (404) | — | — | — | — |
| AgentSync | `agent-sync` | YES (404) | — | — | — | — |
| SharedMind | `shared-mind` | YES (404) | — | — | — | — |
| AgentHub | `agent-hub` | NO (taken, placeholder) | — | — | — | — |
| AgentMesh | `agent-mesh` | NO (taken, "Reserved") | NO (org exists) | TAKEN | TAKEN | — |
| AgentNexus | `agent-nexus` | NO (taken, v1.0.9, direct competitor) | — | — | — | — |
| MindWeave | `mindweave` | YES (404) | NO (user exists) | TAKEN | TAKEN | TAKEN |
| SwarmState | `swarm-state` | YES (404) | YES (404) | TAKEN (.dev) | Likely available (.io) | Likely available |
| CortexSync | `cortex-sync` | YES (404) | YES (404) | Likely available | Likely available | Likely available |
| SwarmLink | `swarm-link` | YES (404) | NO (user exists) | TAKEN | — | TAKEN |
| NeuroMesh | `neuromesh` | YES (404) | NO (org exists, inactive) | — | — | — |
| Noosphere | `noosphere` | NO (taken, AI creation engine) | — | — | — | — |
| Mnemosyne | `mnemosyne` | NO (taken, logging lib) | — | — | — | — |
| MindForge | `mindforge` | NO (taken, mindforge.ai client) | — | — | — | — |

---

## Top 5 Ranked Candidates

---

### 1. SwarmState — RECOMMENDED

**npm:** `swarm-state` — available
**GitHub:** `swarm-state` org — available (404)
**Domains:** `.io` and `.com` likely available; `.dev` is taken (existing product at swarmstate.dev)

**Concept:** Captures the full product — it's the shared *state* of an agent *swarm*. Memory, tasks, messages, and diary are all dimensions of swarm state. "State" as a noun also resonates with engineers: it's precise, architectural, not fluffy.

**Pros:**
- Communicates the full scope, not just memory
- Strong technical resonance — "state" is a meaningful engineering concept
- No major existing product at this name in the AI/MCP space
- Memorable and distinct from current competitors
- `swarm-state` is a clean npm scoped or unscoped package name

**Cons:**
- "Swarm" is increasingly used (LangGraph Swarm, Swarm Corporation, swarmlink.dev taken) — some noise in the space
- `.dev` domain is taken; would need `.io` or `.com`
- "State" alone could be confused with state management libraries (Redux, Zustand, etc.)

**Tagline idea:** "SwarmState — shared memory, tasks, and messaging for your Claude Code agent swarm."

---

### 2. CortexSync — STRONG ALTERNATIVE

**npm:** `cortex-sync` — available (404)
**GitHub:** `cortex-sync` org — available (404)
**Domains:** `.dev`, `.io`, `.com` all likely available; cortexsync.com has an A record (taken), but `cortex-sync.com/dev/io` are clean

**Concept:** "Cortex" evokes the brain/memory layer, "Sync" captures the real-time coordination (messaging, tasks). Together: the synchronized brain of a multi-agent system.

**Pros:**
- Both words carry full-scope meaning: cortex = persistent intelligence, sync = real-time coordination
- Clean availability across most domain variants (with hyphen or `.dev`)
- No notable conflict in the MCP/Claude tooling space
- The `cortex-sync` npm slug is clean and professional
- Easily shortened to "Cortex" in casual use

**Cons:**
- "Cortex" already appears in Cortex (the Grafana metrics product) — different space, but some name collision risk
- Less immediately obvious it's for agent swarms specifically
- The `.com` without hyphen (cortexsync.com) is taken

**Tagline idea:** "CortexSync — persistent memory, tasks, and messaging for multi-agent Claude Code."

---

### 3. VantageMemory (Current) — VIABLE WITH REFRAMING

**npm:** `vantage-memory` — available (404)
**GitHub:** `vantage-memory` and `vantagememory` — both available (404 on both)
**Domains:** `.com`, `.dev`, `.io` — all show no DNS records, likely fully available

**Concept:** "Vantage" implies a high-ground perspective — an agent operating from vantage has broader context. This is defensible as metaphor for the full platform (you have vantage because you have memory + tasks + messages).

**Pros:**
- No rename cost — existing codebase, CLAUDE.md, docs, habits all stay intact
- Best domain availability of any candidate (all three TLDs clean)
- "Vantage" is distinctive, not overloaded like "agent" or "swarm"
- The "memory" part, while incomplete, anchors the mental model for the first capability users encounter

**Cons:**
- "Memory" undersells the product — tasks, messaging, diary are core features
- First-time users will not understand the scope from the name alone
- SEO / search competition: "vantage" and "memory" are common words
- Does not signal "multi-agent coordination" at all

**Mitigation strategy:** Rename to **VantageMemory** as the brand, but position the product as "the coordination layer" in all copy. Subtitle: *"Memory, messaging, and tasks for Claude Code agent swarms."*

---

### 4. AgentSync — FUNCTIONAL BUT GENERIC

**npm:** `agent-sync` — available (404)
**GitHub:** check needed
**Domains:** not checked in detail

**Concept:** Direct, functional — agents that sync. Captures messaging and task coordination well.

**Pros:**
- Immediately understandable to developers
- Clean npm name available
- "Sync" signals real-time coordination

**Cons:**
- Very generic — likely to conflict with future projects in an exploding space
- "agent-sync" reads like a utility package, not a platform
- Does not evoke the memory/persistence dimension
- Will be hard to rank for SEO given genericness

---

### 5. SharedMind — CREATIVE BUT NICHE

**npm:** `shared-mind` — available (404)
**GitHub:** check needed
**Domains:** not checked in detail

**Concept:** The collective intelligence of the agent swarm — every agent draws from and writes to the shared mind.

**Pros:**
- Evokes the full scope beautifully: shared state, shared knowledge, shared task queue
- Distinctive and memorable
- No major conflicts found

**Cons:**
- "Mind" is softer/less technical — may not resonate with engineers
- Potential confusion with human collaboration tools (Confluence, Notion, etc.)
- Does not immediately signal "Claude Code" or "MCP" or "multi-agent"

---

## Eliminated Candidates

| Name | Reason Eliminated |
|---|---|
| AgentBrain | npm taken (AI memory system, v1.0.0) |
| HiveMind | npm taken (distributed web platform, 2012) |
| AgentHub | npm taken (placeholder, reserved) |
| AgentMesh | npm taken ("Reserved" by Human4AI), GitHub org exists |
| AgentNexus | npm taken (direct competitor: multi-terminal Claude Code via MCP) |
| MindWeave | GitHub user exists; .com/.dev/.io all taken; mindweave.space is active AI product |
| SwarmLink | GitHub user exists; swarmlink.dev and swarmlink.com both taken |
| NeuroMesh | GitHub org exists (inactive but present) |
| Noosphere | npm taken (AI creation engine) |
| Mnemosyne | npm taken (Node.js logging library) |
| MindForge | npm taken (mindforge.ai TypeScript client) |
| CortexSync (.com) | cortexsync.com has A record (taken) — use hyphenated or .dev/.io variant |

---

## Final Recommendation

**Primary recommendation: SwarmState**

The name wins on concept fit (state of a swarm = full product scope), clean npm availability (`swarm-state`), and GitHub org availability. The only friction is that swarmstate.dev is taken — registering `swarmstate.io` or `swarmstate.com` resolves this cleanly.

**If you want to preserve zero rename cost: stay with VantageMemory** — all domains and the npm name are clean. Invest in subtitle and positioning to communicate full scope. The "memory" word becomes a feature highlight rather than a limitation.

**Avoid:** anything with "agent" in the name — the space is saturating and agent-nexus already owns the closest conceptual territory.

---

## Availability Summary Matrix

| Candidate | npm slug | npm | GitHub org | .dev | .io | .com |
|---|---|---|---|---|---|---|
| **SwarmState** | `swarm-state` | Available | Available | TAKEN | Available | Available |
| **CortexSync** | `cortex-sync` | Available | Available | Available | Available | TAKEN (.com no hyphen) |
| **VantageMemory** | `vantage-memory` | Available | Available | Available | Available | Available |
| **AgentSync** | `agent-sync` | Available | Unknown | Unknown | Unknown | Unknown |
| **SharedMind** | `shared-mind` | Available | Unknown | Unknown | Unknown | Unknown |

Legend: Available = no DNS / 404 confirmed. TAKEN = DNS record or HTTP 200 confirmed. Unknown = not checked.

---

## Sources

- [npm Registry API](https://registry.npmjs.org/) — direct package lookups
- [agent-nexus on npm](https://www.npmjs.com/package/agent-nexus) — direct competitor reference
- [Shipyard: Multi-agent orchestration for Claude Code in 2026](https://shipyard.build/blog/claude-code-multi-agent/)
- [GitHub: mcp-memory-service](https://github.com/doobidoo/mcp-memory-service)
- [GitHub: Agent-MCP](https://github.com/rinadelph/Agent-MCP)
- [GitHub: ruflo](https://github.com/ruvnet/ruflo)
- [mindweave.space](https://www.mindweave.space/) — existing AI product at that brand
- DNS resolution via `dig` for all domain checks (2026-03-25)
