# Agent-to-Agent Messaging: Competitive Landscape Research

**Date:** 2026-03-25
**Analyst:** Strategy Researcher (Claude)
**Scope:** Agent communication and messaging solutions relevant to VantageMemory positioning

---

## Executive Summary

- **No existing solution combines** cross-machine delivery, per-recipient read receipts, multi-instance routing, and persistent storage in a single lightweight MCP-compatible package.
- **claude-peers** is the closest direct predecessor — it works well within a single machine but is architecturally localhost-only with no path to cross-machine use.
- **CrewAI / AutoGen / LangGraph** address agent communication within a framework-scoped runtime; they are not general-purpose inter-agent messaging buses and require agents to share the same deployment environment.
- **OpenAI Swarm** is intentionally stateless and handles control flow, not persistent messaging.
- **Google A2A** is a protocol standard (like HTTP), not an implementation — it tells agents *how* to talk, but provides no hosted messaging layer.
- **VantageMemory's messaging layer** (Convex + receipt-indexed schema) is the only design found that delivers: cloud-persisted messages, per-instance delivery routing, read receipts with timestamps, polling that works from any network, and zero broker-process dependency.

---

## 1. Detailed Findings

### 1.1 claude-peers

**Source:** [Glama MCP server listing](https://glama.ai/mcp/servers/louislva/claude-peers-mcp)

**How it works:**
A broker daemon runs on `localhost:7899` backed by a single SQLite database file (default: `~/.claude-peers.db`). Each Claude Code session registers as an MCP server via stdio transport. Sessions poll the broker every second; inbound messages are pushed into the session via the `claude/channel` protocol, providing near-real-time local delivery. The broker auto-launches on first session start and reaps dead peers.

Available tools: `list_peers`, `send_message`, `set_summary`, `check_messages`.

**Architecture diagram (conceptual):**
```
[Claude session A] ──stdio──> [MCP server A] ──HTTP──> [Broker :7899 + SQLite]
[Claude session B] ──stdio──> [MCP server B] ──HTTP──> [Broker :7899 + SQLite]
```

**Assessment against key dimensions:**

| Dimension | claude-peers |
|---|---|
| Cross-machine support | **No.** Localhost-only by design. The broker binds to 127.0.0.1:7899 — no external exposure. |
| Read receipts | **No.** No receipt tracking mechanism found. |
| Multi-instance routing | **Partial.** Multiple sessions on the same machine, scoped by directory/repo. No cross-host instance concept. |
| Persistence | **Yes (local).** SQLite on the host machine. Lost if the machine is rebuilt. |
| Real-time vs polling | Near-real-time (1-second poll + push via claude/channel). |
| Auth / security | Requires Claude Code v2.1.80+ with claude.ai login; API-key auth unsupported. |
| Runtime dependency | Requires Bun. |

**Key limitation:** The broker process must be running on the same host as all communicating Claude instances. There is no relay or cloud relay path. Two Claude agents on different machines (e.g., pi-chromebook and pi-vps) cannot communicate via claude-peers without an SSH tunnel or VPN — neither of which is supported natively.

---

### 1.2 CrewAI — A2A Agent Delegation

**Sources:** [CrewAI A2A docs](https://docs.crewai.com/en/learn/a2a-agent-delegation), [Latenode review](https://latenode.com/blog/ai-frameworks-technical-infrastructure/crewai-framework/)

**How it works:**
CrewAI treats agent-to-agent communication as a **task delegation primitive** built on Google's A2A protocol. An agent configured in "client mode" can delegate tasks to remote agents (other CrewAI agents or any A2A-compliant agent) over HTTP(S)/JSONRPC/gRPC. Agents are discovered via Agent Cards published at `/.well-known/agent-card.json`. The delegating agent then polls for status or receives push callbacks.

Three update mechanisms:
1. **Streaming** — default, real-time updates via SSE.
2. **Polling** — configurable interval checks.
3. **Push notifications** — server posts results to a callback URL.

**Assessment:**

| Dimension | CrewAI |
|---|---|
| Cross-machine support | **Yes** — HTTP transport, agents are services with network endpoints. |
| Read receipts | **No explicit receipts.** `trust_remote_completion_status` flag controls whether results are accepted on completion signal, but no per-message delivery confirmation. |
| Multi-instance routing | **Not natively.** Agent Cards describe a single endpoint; multi-instance load balancing is left to the operator (e.g., put a load balancer in front). |
| Persistence | **No built-in.** Delegated task results are transient HTTP responses; CrewAI itself has no message store. |
| Real-time vs polling | Both supported (configurable). |
| Framework coupling | Tightly coupled to CrewAI's Crew/Task model. Not a general message bus. |

**Key limitation:** CrewAI is a *workflow orchestration* framework, not a messaging layer. Communication is request/response around task delegation, not a pub/sub or inbox model. If an agent is offline when the task completes, the result is lost unless the developer adds their own persistence.

---

### 1.3 Microsoft AutoGen — GroupChat and Distributed Runtime

**Sources:** [AutoGen GroupChat docs](https://microsoft.github.io/autogen/stable//user-guide/core-user-guide/design-patterns/group-chat.html), [Microsoft Research AutoGen](https://www.microsoft.com/en-us/research/project/autogen/), [AutoGen v0.4 overview](https://mgx.dev/insights/autogen-a-comprehensive-review-of-microsofts-multi-agent-conversational-framework-for-llms/)

**How it works:**
AutoGen's core communication model is **message passing within a runtime**. Two patterns:

1. **Direct messaging** — explicit send to a named agent within the runtime.
2. **Broadcast (pub/sub)** — publish to a topic; all subscribed agents receive it.

AutoGen v0.4 introduced an event-driven, asynchronous architecture (`DistributedAgentRuntime`) that can span multiple processes or machines. The GroupChat pattern adds a `GroupChatManager` that selects the next speaker and dispatches `RequestToSpeak` messages.

**Assessment:**

| Dimension | AutoGen |
|---|---|
| Cross-machine support | **Yes (v0.4+)** via `DistributedAgentRuntime`, but requires shared infrastructure (gRPC channel, message broker). Not trivial to set up. |
| Read receipts | **No.** Message delivery is fire-and-forget within the runtime. No per-recipient acknowledgment layer. |
| Multi-instance routing | **Partial.** Agents can run in separate processes; routing relies on the runtime's pub/sub subscription model. |
| Persistence | **No built-in message store.** State persistence (checkpointing) is a separate concern. Messages in flight are in-process. |
| Real-time vs polling | Real-time (async event-driven in v0.4). |
| Framework coupling | Strong coupling to AutoGen's agent model. |

**Key limitation:** AutoGen's distributed runtime requires agents to share a coordinated runtime infrastructure (a message broker or gRPC channel). It is not an "any agent can reach any other agent" model — the runtime must be explicitly provisioned and shared. Also, a known security vulnerability (Contagious Recursive Blocking Attacks / CORBA) can propagate blocking messages across the entire agent network.

---

### 1.4 LangGraph — Shared State Graph Communication

**Sources:** [LangGraph multi-agent guide](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/), [bix-tech A2A guide](https://bix-tech.com/agent-to-agent-communication-with-langgraph-protocol-based-workflows-a-practical-guide/), [MarkTechPost production design](https://www.marktechpost.com/2026/03/01/how-to-design-a-production-grade-multi-agent-communication-system-using-langgraph-structured-message-bus-acp-logging-and-persistent-shared-state-architecture/)

**How it works:**
LangGraph does not have an explicit message-passing protocol. Agents communicate via **shared state mutations** — each agent is a graph node that reads the current state object and writes updates to it. Control flow (which agent runs next) is determined by graph edges, which can be conditional.

For multi-agent handoffs, LangGraph Swarm uses `Command` objects that update the active agent pointer in shared state and pass context along. There is no envelope, no recipient address, and no inbox.

**Assessment:**

| Dimension | LangGraph |
|---|---|
| Cross-machine support | **Limited.** Requires LangGraph Cloud/Platform or custom deployment. Nodes can span different runtimes with MCP integration, but this is not out of the box. |
| Read receipts | **No concept.** Communication is state mutation, not message delivery. There is nothing to "read." |
| Multi-instance routing | **No.** The graph is a single DAG execution. Multiple instances of the same node cannot both be "in the graph" without custom graph logic. |
| Persistence | **Yes (with checkpointing).** LangGraph supports persistent checkpoints for time-travel debugging and resumability. Not the same as a message store. |
| Real-time vs polling | Real-time within a single graph execution. No async inbox. |
| Framework coupling | Extreme — communication *is* the graph structure. |

**Key limitation:** LangGraph's communication model is fundamentally inappropriate for persistent async messaging between agents that have independent lifecycles. It is a workflow execution engine where "agents" are steps, not autonomous long-running processes.

---

### 1.5 OpenAI Swarm (superseded by Agents SDK)

**Sources:** [GitHub openai/swarm](https://github.com/openai/swarm), [VentureBeat overview](https://venturebeat.com/ai/openais-swarm-ai-agent-framework-routines-and-handoffs), [Arize blog](https://arize.com/blog/swarm-openai-experimental-approach-to-multi-agent-systems/)

**How it works:**
Swarm is intentionally a **control-flow primitive**, not a messaging system. Two abstractions: Agents (LLM + instructions + tools) and Handoffs (a function that returns another Agent object). When an agent calls a `transfer_to_XXX` function, control and the conversation history are transferred to the target agent. No network hop occurs — all agents run in the same Python process loop.

Swarm was labelled experimental and has since been superseded by the **OpenAI Agents SDK**, which is production-ready but follows the same handoff model.

**Assessment:**

| Dimension | OpenAI Swarm / Agents SDK |
|---|---|
| Cross-machine support | **No.** Single-process, synchronous control flow. |
| Read receipts | **No.** No messaging layer exists. |
| Multi-instance routing | **No.** Stateless by design. |
| Persistence | **No.** Each run is ephemeral. |
| Real-time vs polling | Synchronous execution loop. |
| Framework coupling | Extreme — "messaging" is just Python function returns. |

**Key limitation:** Swarm/Agents SDK is a good mental model for describing agent role handoffs but is not a distributed communication system in any sense. It is an in-process orchestration pattern.

---

### 1.6 MCP-Based Messaging Solutions

**Sources:** [MCP spec](https://modelcontextprotocol.io/specification/2025-11-25), [Azure Web PubSub + MCP](https://techcommunity.microsoft.com/blog/appsonazureblog/building-real-time-ai-apps-with-model-context-protocol-mcp-and-azure-web-pubsub/4432791), [MCP 2026 A2A guide](https://www.elegantsoftwaresolutions.com/blog/mcp-2026-agent-to-agent-communication-guide), [Google Cloud Pub/Sub MCP](https://docs.cloud.google.com/pubsub/docs/use-pubsub-mcp)

**How MCP itself works:**
MCP is a **client-tool protocol**, not an agent-to-agent protocol. An MCP server exposes tools; an MCP client (Claude, Cursor, etc.) calls them. Transport is either stdio (local) or HTTP+SSE (remote). MCP has no built-in concept of "send a message to another agent" — it is always client→server.

**Emerging MCP-based messaging patterns (2025-2026):**
- **Azure Web PubSub + MCP**: A persistent WebSocket hub maintains connections; an MCP server dispatches messages to agents via the hub. Adds cross-machine real-time delivery, but requires Azure infrastructure and custom integration.
- **Google Cloud Pub/Sub MCP server**: Anthropic-compatible MCP server that wraps Google Pub/Sub. Agents can publish/subscribe to topics. Cross-machine by nature (cloud pub/sub). No built-in read receipts or per-recipient inbox model.
- **VantageMemory (this project)**: Convex-backed MCP server. See section 1.8.

**Assessment of generic MCP-based messaging:**

| Dimension | Generic MCP messaging |
|---|---|
| Cross-machine support | **Yes** (HTTP+SSE transport) if server is hosted. |
| Read receipts | **Depends entirely on implementation.** MCP provides no receipt primitive. |
| Multi-instance routing | **Depends.** Not in the protocol. Must be built on top. |
| Persistence | **Depends on backing store.** SQLite = local. Cloud DB = persistent. |
| Real-time vs polling | SSE provides real-time push; stdio requires polling. |

---

### 1.7 Google A2A Protocol

**Sources:** [Google A2A announcement](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/), [Auth0 MCP vs A2A](https://auth0.com/blog/mcp-vs-a2a/), [IBM A2A overview](https://www.ibm.com/think/topics/agent2agent-protocol)

**How it works:**
A2A is an **open protocol specification** (like HTTP), not an implementation. It defines how agents should expose themselves (Agent Cards at `/.well-known/agent.json`) and communicate (JSON-RPC 2.0 over HTTP). It handles task submission, streaming status, push notifications, and authentication (Bearer/API key). Announced April 2025 with 50+ launch partners.

**Key positioning vs MCP:** MCP = vertical (agent↔tools). A2A = horizontal (agent↔agent). They are complementary.

**Assessment:**

| Dimension | Google A2A Protocol |
|---|---|
| Cross-machine support | **Yes** — HTTP-native. |
| Read receipts | **No explicit receipts.** Task completion status is tracked, but no per-message delivery acknowledgment. |
| Multi-instance routing | **No native concept.** An Agent Card describes one endpoint; load balancing is external. |
| Persistence | **Not specified.** Implementers provide their own storage. |
| Real-time vs polling | Both supported (SSE streaming or polling). |
| What it is NOT | A2A is a protocol, not a hosted messaging service. You still need to build or host the infrastructure. |

---

### 1.8 Custom Solutions: Redis Pub/Sub, Message Queues

**Sources:** [Redis Pub/Sub docs](https://redis.io/docs/latest/develop/pubsub/), [Redis Streams vs Pub/Sub comparison](https://dev.to/lovestaco/choosing-the-right-messaging-tool-redis-streams-redis-pubsub-kafka-and-more-577a), [LinkedIn multi-agent case study](https://www.infoq.com/news/2025/09/linkedin-multi-agent/)

**Redis Pub/Sub:**
- Fire-and-forget — if a subscriber is offline, the message is lost permanently.
- No persistence, no acknowledgments, no per-recipient inbox.
- Very high throughput, very low latency.
- Not appropriate for agents that may be intermittently online.

**Redis Streams:**
- Persistent (messages survive subscriber downtime).
- Consumer groups enable per-consumer delivery tracking.
- No built-in read receipts (you implement acknowledgment by advancing the consumer offset).
- Cross-machine: Yes (Redis server is network-accessible).
- Popular for microservice event streaming; overkill for small agent teams.

**Kafka:**
- Industrial-strength persistent pub/sub with consumer group offset tracking.
- Cross-machine: Yes.
- Significant operational overhead (ZooKeeper/KRaft cluster, schema registry, etc.).
- Not practical for a small team of 3 orchestrator agents.

**LinkedIn's approach (2025):**
LinkedIn extended its existing messaging infrastructure as an agent orchestration layer, repurposing internal Kafka topics and consumer groups. Demonstrates that enterprise teams reuse existing messaging systems rather than building new ones — but this is only viable when those systems already exist and are maintained.

---

### 1.9 VantageMemory Messaging Layer (this project)

**Source:** `/root/coding/vantage-memory/convex/messages.ts`, `/root/coding/vantage-memory/convex/schema.ts`

**How it works:**
Messages are stored in Convex cloud (`messages` table). Each send creates one `messages` row and one `messageReceipts` row per recipient. The receipt row carries: `recipient` (role), `recipientInstanceId` (specific machine instance), and `readAt` (timestamp, null until read).

Delivery routing logic (from `messages.ts`):
- Channel `"broadcast"` → all orchestrators except sender.
- Channel `"pi-vps"` (contains hyphen) → instance-level delivery to that specific machine.
- Channel `"pi"` → role-level delivery to all `pi` instances.
- When an instance checks messages, it gets: messages addressed to its `recipientInstanceId` PLUS role-level messages with no `recipientInstanceId` set (i.e., the agent did not target a specific instance).

**Assessment:**

| Dimension | VantageMemory |
|---|---|
| Cross-machine support | **Yes.** Convex is cloud-hosted. Any agent with the deployment URL and auth token can send/receive. No broker process required on any machine. |
| Read receipts | **Yes.** Per-recipient `readAt` timestamp in `messageReceipts`. Query for `readAt === undefined` to find unread. |
| Multi-instance routing | **Yes.** Two-tier routing: role-level (all `pi` instances) and instance-level (`pi-vps` only). A message to `"pi-vps"` is only visible to that machine. |
| Persistence | **Yes (cloud).** Convex persists all messages. Survives machine reboots, rebuilds, network outages. |
| Real-time vs polling | **Polling** (MCP context has no push channel). `checkNewMessages` is a Convex query called on demand. Convex supports reactive subscriptions natively if the client can hold a WebSocket. |
| Auth | Convex deployment-level auth (OIDC / deploy key). |
| Schema coupling | Only requires Convex deployment URL + auth. No framework, no runtime daemon, no shared host. |

---

## 2. Comparison Table

| Feature | claude-peers | CrewAI | AutoGen | LangGraph | Swarm | Google A2A | Redis Streams | VantageMemory |
|---|---|---|---|---|---|---|---|---|
| **Cross-machine** | No | Yes | Yes (v0.4+, complex) | Limited | No | Yes (protocol) | Yes | Yes |
| **Read receipts** | No | No | No | No | No | No | Partial (offset) | Yes (per-recipient, timestamped) |
| **Multi-instance routing** | No | No | Partial | No | No | No (protocol only) | Manual | Yes (role + instance tier) |
| **Persistence** | Local SQLite | No | No | Checkpoints only | No | Not specified | Yes | Yes (cloud) |
| **Real-time** | ~1s poll | SSE/push/poll | Async events | Within execution | Sync | SSE/poll | Yes | Poll (WebSocket optional) |
| **Framework coupling** | Claude Code only | CrewAI crew model | AutoGen runtime | LangGraph graph | OpenAI SDK | Open standard | None | MCP + Convex |
| **Setup complexity** | Low (localhost) | High (services + A2A cards) | High (distributed runtime) | High (graph infra) | Low (in-process) | High (implement spec) | Medium (Redis server) | Low (Convex deploy key) |
| **Broker/infra required** | localhost:7899 daemon | HTTP services per agent | gRPC/broker shared runtime | LangGraph Cloud or custom | None | HTTP server per agent | Redis server | Convex (managed) |
| **Offline delivery** | No | No | No | No | No | No | Yes | Yes |
| **MCP-compatible** | Yes | No | No | No | No | No | No | Yes |

---

## 3. Key Insights

**Insight 1 — The "local only" gap is real and unaddressed**
claude-peers is the only MCP-native peer messaging solution found. It is well-designed for its scope but has a hard architectural ceiling: everything must share localhost. The moment agents run on different machines (a very common deployment pattern — chromebook + VPS, or developer machine + cloud worker), claude-peers provides zero value. No other solution fills this gap at the MCP layer.

**Insight 2 — Framework solutions are not messaging buses**
CrewAI, AutoGen, LangGraph, and Swarm each solve a specific orchestration problem within their own runtime. None of them provide a general-purpose "send a message to an agent on another machine and confirm it was received" primitive. They assume agents share a deployment context. VantageMemory explicitly does not — it serves heterogeneous agents across machines.

**Insight 3 — Google A2A is a protocol, not a product**
A2A defines *how* agents should talk but provides no hosted relay, no inbox, and no receipt semantics. Implementing A2A requires standing up HTTP services for every agent, implementing Agent Cards, and building your own delivery confirmation. It is a specification burden, not a solution.

**Insight 4 — Read receipts are genuinely absent from the landscape**
No surveyed solution — including Redis Streams, which has consumer offset tracking — provides per-recipient, per-message read confirmation with timestamps. Redis consumer groups give you "has this consumer group consumed this message" but not "did agent pi-vps specifically read message X at time T." VantageMemory's `messageReceipts.readAt` is a differentiator.

**Insight 5 — Multi-instance routing is an unsolved problem**
The concept of "role pi running on three machines simultaneously, but this message is only for pi-vps" does not exist in any surveyed framework. CrewAI A2A requires a separate Agent Card per instance. AutoGen requires separate subscriptions per agent process. VantageMemory's two-tier routing (role-level vs instance-level) addresses this natively.

---

## 4. Strategic Recommendations

**Recommendation 1 — Document VantageMemory as the direct successor to claude-peers (High priority)**
The positioning is clean: "claude-peers, but cross-machine and with receipts." The audience is Claude Code power users who have already hit the localhost ceiling. Write a concrete migration note showing the API equivalence: `send_message` / `check_messages` / `list_peers` map 1:1.

**Recommendation 2 — Do not position against CrewAI/AutoGen/LangGraph (Low priority)**
These are framework-level solutions for different use cases. Positioning VantageMemory against them creates confusion — they are not competitors. The competitive frame is: "for agents that don't share a runtime and don't want to adopt a heavy framework."

**Recommendation 3 — Add WebSocket / reactive delivery as a future capability (Medium priority)**
The one genuine gap in VantageMemory vs Redis Streams is that Convex requires polling in the MCP context. Convex supports reactive subscriptions natively (WebSocket). If a future VantageMemory server version holds a persistent Convex subscription and pushes to the MCP client via SSE, this gap closes entirely.

**Recommendation 4 — Monitor Google A2A adoption as a potential integration target (Low-medium priority)**
As A2A becomes a de facto standard, VantageMemory's messaging layer could serve as an A2A-compatible relay: agents that implement A2A could use VantageMemory as the persistence/receipt layer for their messages, rather than building their own. This is a 12-18 month horizon play.

**Recommendation 5 — Emphasize "offline delivery" explicitly in positioning (High priority)**
Redis Streams is the only other solution that delivers messages to agents that were offline when the message was sent. However, Redis requires a managed server. Convex is fully managed. The "your agent was offline, messages waited for it" use case is a concrete, relatable story that no other MCP-native solution can tell.

---

## 5. Appendix — Sources

- [claude-peers on Glama MCP](https://glama.ai/mcp/servers/louislva/claude-peers-mcp)
- [CrewAI A2A Agent Delegation docs](https://docs.crewai.com/en/learn/a2a-agent-delegation)
- [CrewAI Framework 2025 Review — Latenode](https://latenode.com/blog/ai-frameworks-technical-infrastructure/crewai-framework/)
- [AutoGen GroupChat patterns](https://microsoft.github.io/autogen/0.2/docs/tutorial/conversation-patterns/)
- [AutoGen stable docs](https://microsoft.github.io/autogen/stable//index.html)
- [AutoGen — Microsoft Research](https://www.microsoft.com/en-us/research/project/autogen/)
- [LangGraph multi-agent orchestration — Latenode](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/)
- [LangGraph production-grade message bus design — MarkTechPost](https://www.marktechpost.com/2026/03/01/how-to-design-a-production-grade-multi-agent-communication-system-using-langgraph-structured-message-bus-acp-logging-and-persistent-shared-state-architecture/)
- [OpenAI Swarm GitHub](https://github.com/openai/swarm)
- [OpenAI Swarm — VentureBeat](https://venturebeat.com/ai/openais-swarm-ai-agent-framework-routines-and-handoffs)
- [OpenAI Swarm — Arize AI](https://arize.com/blog/swarm-openai-experimental-approach-to-multi-agent-systems/)
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Azure Web PubSub + MCP — Microsoft](https://techcommunity.microsoft.com/blog/appsonazureblog/building-real-time-ai-apps-with-model-context-protocol-mcp-and-azure-web-pubsub/4432791)
- [Google Cloud Pub/Sub MCP server](https://docs.cloud.google.com/pubsub/docs/use-pubsub-mcp)
- [Google A2A Protocol announcement](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [MCP vs A2A — Auth0](https://auth0.com/blog/mcp-vs-a2a/)
- [A2A vs MCP — IBM](https://www.ibm.com/think/topics/agent2agent-protocol)
- [A2A + MCP protocol wars — Koyeb](https://www.koyeb.com/blog/a2a-and-mcp-start-of-the-ai-agent-protocol-wars)
- [Redis Pub/Sub documentation](https://redis.io/docs/latest/develop/pubsub/)
- [Redis Streams for microservice communication](https://redis.io/learn/howtos/solutions/microservices/interservice-communication)
- [Redis vs Kafka messaging comparison — DEV Community](https://dev.to/lovestaco/choosing-the-right-messaging-tool-redis-streams-redis-pubsub-kafka-and-more-577a)
- [LinkedIn multi-agent on existing messaging infra — InfoQ](https://www.infoq.com/news/2025/09/linkedin-multi-agent/)
- [AutoGen distributed multi-agent patterns — sparkco.ai](https://sparkco.ai/blog/deep-dive-into-autogen-multi-agent-patterns-2025)
- [A2A protocol survey paper — arXiv](https://arxiv.org/html/2505.02279v1)
