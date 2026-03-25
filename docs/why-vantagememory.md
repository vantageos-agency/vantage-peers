# Why VantagePeers Exists

Every agent memory product on the market solves the same problem: store facts, retrieve facts. A read/write API with embeddings on top. Some add a knowledge graph. Some charge $475 a month for the privilege.

None of them ask the harder question: once your agents can remember, how do they coordinate?

## The Problem No One Wants to Price Honestly

Agent memory in 2026 is fragmented, expensive, and less reliable than the marketing suggests.

The numbers:

- **Mem0 Pro**: $249/month. Graph memory -- the feature that justifies the price -- is gated behind this tier. Every `memory.add()` with graph enabled fires multiple LLM calls for entity extraction, deduplication, and conflict resolution. Those costs hit your OpenAI bill separately. The real price is $249 plus whatever your extraction volume demands.
- **Zep Flex Plus**: $475/month for 300,000 "episodes." An episode over 350 bytes bills in multiples. A heavy conversation thread burns credits faster than the pricing page admits. Overages run $125 per 100K episodes.
- **Cognee on-prem**: EUR 1,970/month before infrastructure costs.
- **Letta API**: $20/month base, plus $0.10 per active agent per month, plus $0.00015 per second of tool execution, plus your LLM costs. The sticker price and the real price live in different zip codes.

And the accuracy ceiling? The best publicly benchmarked system (EverMemOS) scores 92.3% on LoCoMo. That means roughly 1 in 12 recalled facts is wrong -- under optimal, single-agent, non-adversarial conditions.

Multi-agent memory consistency is worse. MongoDB and O'Reilly's 2025 research quantifies it: 36.9% of multi-agent failures trace to inter-agent misalignment. Agents operating on inconsistent views of shared state. Token costs balloon to 15x single-agent levels because agents re-retrieve information their peers already fetched.

Self-hosting is eroding. Zep deprecated its Community Edition in April 2025 -- frozen codebase, no support. Mem0's graph features require their cloud. Supermemory requires an enterprise agreement. The open-source door is closing across the industry while prices climb.

## The Missing Pieces

Strip away the marketing from every product in this space -- Mem0, Zep, Letta, Supermemory, Cognee, LangMem -- and you find the same architecture: a memory read/write API. Some with vectors. Some with graphs. All with the same blind spots.

None provide inter-agent messaging. Your agents cannot talk to each other through the memory layer. You bolt on Redis, SQS, or a Postgres table and hope the duct tape holds.

None provide task management. Task state gets encoded as memories (fragile) or lives in a separate database that doesn't integrate with memory retrieval.

None provide daily diaries or structured reflection. Agents don't learn from their days. They don't synthesize.

None handle cross-machine communication. claude-peers -- the closest thing to agent messaging in the MCP ecosystem -- binds to localhost:7899. Two agents on different machines cannot exchange a single message without an SSH tunnel.

The industry built the hippocampus and forgot the rest of the brain.

## Our Approach

VantagePeers is one system where the industry uses five.

**Convex cloud** as the backbone. Real-time serverless database with ACID transactions. No ops. No broker process. No Redis instance to babysit. Every agent with a deployment URL and auth token can read, write, message, and track work from anywhere.

**Vercel AI Gateway** for OpenAI embeddings. text-embedding-3-small at 1536 dimensions. No vendor lock-in -- swap the gateway URL and point at any OpenAI-compatible provider.

**MCP protocol** as the universal interface. 27 tools exposed via the Model Context Protocol. Works with any Claude Code instance. No framework adoption required. No CrewAI. No LangGraph. No AutoGen. Just tools.

**One backend** for memory, messaging, tasks, missions, diaries, and briefing notes. Eight database tables. One Convex deployment. The coordination layer is not an afterthought -- it is the architecture.

## What Makes VantagePeers Different

**Five memory types with semantic search.** Not key-value. Not flat text. Typed memories -- user, feedback, project, reference, episode -- each searchable by meaning via vector similarity, full-text BM25, or hybrid Reciprocal Rank Fusion.

**Graph relations between memories.** A memory can update, extend, supersede, or derive from another. Automatic versioning tracks which memory is current. The graph is not a separate $249/month feature. It is built in.

**Inter-agent messaging with read receipts.** Send to a channel, a role, a specific instance, or broadcast to all. Every message generates per-recipient receipts with timestamps. You know who read what and when. No other MCP-native solution -- and no agent memory product surveyed -- provides this.

**Cross-machine, multi-instance routing.** Two-tier delivery: role-level (all `pi` instances get the message) and instance-level (`pi-vps` only). An agent on your laptop and an agent on your VPS share the same inbox semantics without sharing a network. This is what claude-peers would be if it escaped localhost.

**Task management with dependencies and missions.** Create tasks, assign them, set priorities, define dependency chains. Group tasks into missions with lifecycle stages. Agents claim work, report completion with mandatory notes. The task board and the memory store are the same system.

**Episodic learning.** Structured records: context, goal, action, outcome, insight, severity. Agents don't just store facts -- they store lessons. Searchable by semantic similarity. The pattern that broke production last Tuesday surfaces automatically when a similar context appears.

**Daily diaries.** Each agent writes a diary entry per day: highlights, blockers, reflections. Institutional memory that compounds.

27 MCP tools. 8 database tables. One backend.

## Open Source, Free Forever

MIT license. The entire codebase. Not "open core" where the useful features live behind a paywall. Not "community edition" that gets deprecated when the Series A lands.

Self-hosted on your own Convex deployment. Free tier works for small teams. No per-query pricing. No episode multipliers. No hidden LLM extraction costs baked into your subscription.

The pricing model is transparent because the product is the code, not the margin.

Community-driven roadmap. File an issue. Open a PR. The features that get built are the features that get needed.

## The Bet

The agent memory market is consolidating around expensive, single-concern cloud APIs that solve retrieval and ignore coordination. VantagePeers bets on the opposite: that memory without messaging is a filing cabinet, that tasks without memory are a to-do list, and that agents that cannot talk to each other across machines are not a system.

They are toys pretending to be infrastructure.

We built the infrastructure.
