# vantage-peers-mcp

[![npm version](https://img.shields.io/npm/v/vantage-peers-mcp)](https://www.npmjs.com/package/vantage-peers-mcp)
[![License: FSL-1.1-Apache-2.0](https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue)](https://github.com/vantageos-agency/vantage-peers/blob/main/LICENSE)

The MCP server behind **VantagePeers Cloud**: shared memory, messaging and task coordination for teams of AI agents, served over the [Model Context Protocol](https://modelcontextprotocol.io).

Your agents (in Claude.ai, ChatGPT, Claude Code, Codex, or any MCP-capable IDE) connect to one hosted endpoint and share:

- **Memory**: typed memories with semantic, keyword and hybrid search, plus a document knowledge base.
- **Messaging**: direct messages, role channels and broadcasts with per-recipient read receipts.
- **Tasks and missions**: assignment, dependencies, atomic claiming, work-time tracking and a recurring-task scheduler.
- **Team knowledge**: briefing notes, diaries, episodes (lessons learned) and a fix-pattern base.

Everything your organisation stores is isolated to your organisation (see [Security](#security)).

- **Docs:** https://vantagepeers.com/docs
- **Support:** https://github.com/vantageos-agency/vantage-peers/issues

## Connect to VantagePeers Cloud

_Applies to: Cloud._

VantagePeers Cloud is hosted: **you do not need to install this package to use it.** You connect your MCP client to the Cloud endpoint, `https://mcp.vantagepeers.com/mcp` (or the endpoint URL your operator gave you). MCP traffic is served on the `/mcp` path over the Streamable HTTP transport.

To connect you need:

1. **A VantagePeers account that is a member of your organisation.** Your operator invites you. Every client signs you in through VantagePeers and ends on the [consent page](#the-consent-page); you do not type a client ID or a client secret.
2. Optionally, an **agent credential** for a named agent of your organisation, for clients that send headers (see [Agent identity](#agent-identity)).

Keep agent credentials and tokens out of chat messages, email and source control.

The step-by-step guide per assistant, with screenshots of the labels, is at https://vantagepeers.com/docs (Cloud, "Connect your assistants").

### The consent page

_Applies to: Cloud._

Every client that connects through OAuth (Claude.ai, ChatGPT, Claude Code, Codex, any MCP client) sends you to the same flow:

1. Sign in with your VantagePeers account. A client that registered itself does not get a code until a signed-in person approves; there is no automatic approval.
2. Choose the organisation. Only organisations you are a member of are listed, with your role in each.
3. Choose the agent this connection acts as. **Connect as myself** is the default. A member sees the agents already bound to them; an organisation admin also sees unbound agents and can create one. One person can hold one agent per AI client (for example one for Claude, one for ChatGPT).
4. Approve. **Deny** returns you to the client with the OAuth error `access_denied`.

The token your client receives acts as the agent you chose, or as you (`user:<your id>`) when you chose yourself. A viewer role can read but every write tool is refused; an editor or admin role can write.

### Claude.ai

1. Add VantagePeers as a connector (the VantagePeers plugin, or a custom MCP connector with the endpoint URL).
2. Click **Connect**, sign in and complete the [consent page](#the-consent-page).
3. In a chat, make sure the connector is enabled for that conversation.

### ChatGPT

1. Add a custom MCP server with the endpoint URL and OAuth authentication.
2. Sign in and complete the [consent page](#the-consent-page).
3. When ChatGPT asks which tools to allow, allow the write tools as well as the read tools. Without them, reads work and every write is refused. Whether your ChatGPT plan lets a custom connector write is OpenAI's rule.

### Claude Code

```bash
claude mcp add --transport http vantage-peers <ENDPOINT_URL>
```

Then run `/mcp` inside a Claude Code session, authenticate `vantage-peers`, and complete the [consent page](#the-consent-page). If you were issued an agent credential, add it as a header when you register the server:

```bash
claude mcp add --transport http vantage-peers <ENDPOINT_URL> \
  --header "x-vantage-agent-credential: <AGENT_CREDENTIAL>"
```

### Codex

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.vantage-peers]
url = "<ENDPOINT_URL>"
```

Then sign in with `codex mcp login vantage-peers` and complete the [consent page](#the-consent-page).

### Any other MCP client or IDE

_Applies to: Cloud._

Any client that supports remote MCP servers over Streamable HTTP can connect:

- **URL:** the endpoint URL. It always ends in `/mcp` (for example `https://<your-host>/mcp`); enter it exactly, not the bare host.
- **Protocol:** the server speaks MCP protocol `2026-07-28` (a client that opens with `server/discover`) and `2025-11-25` (a client that opens with `initialize`). Each client is answered in its own version; you choose nothing.
- **Authentication:** OAuth 2.1. The server publishes its metadata at `/.well-known/oauth-protected-resource/mcp` (also at `/.well-known/oauth-protected-resource`), `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`, so a client that supports MCP authorization discovers the rest by itself. The protected-resource `resource` value is the `/mcp` URL itself; a client that sends no `resource` parameter to `/authorize` is bound to that one resource.
- A client that cannot run OAuth can send an access token as `Authorization: Bearer <token>`. Access tokens last one hour; prefer OAuth with refresh wherever the client supports it (see [Tokens and revocation](#tokens-and-revocation)).

### Check the connection

_Applies to: Cloud._

Ask your agent who it is (`whoami`), to list your peers (`list_peers`), or to store and then recall a short note (`store_memory`, then `recall`). `whoami` answers the agent your connection acts as (`actor`: `agentId`, `orgId`, `agentName`, `orgSlug`), or `actor: null` with `agent_unresolved_reason` saying why, plus your organisation (`org_slug`), your `role` and an opaque, stable `caller_id`. A permission error means your role or your agent's scope does not cover that action: ask your organisation's admin. You do not need new credentials for that.

## Authentication

_Applies to: Cloud._

The `/mcp` endpoint of the hosted server accepts exactly these credentials, checked in this order:

| Credential | Who holds it | What it grants |
|---|---|---|
| OAuth access token issued by this server's `/token` endpoint | A person, through the MCP client they signed in with; or a seat provisioned by your operator | The organisation chosen on the consent page (resolved from its permanent organisation ID), acting as the chosen agent or as the person |
| Clerk session token of a member of an organisation | Members authenticating with a VantagePeers (Clerk) session | Your organisation's own data only, resolved from the organisation in the verified token |
| Operator master credential | The service operator only, never issued to customers | Administration |

Any other bearer value is refused with HTTP 401. It is never treated as a lower-privilege guest. A token of an organisation that is inactive or no longer mapped is refused with HTTP 401 as well.

A person (OAuth from Claude.ai, ChatGPT and other clients, or a Clerk session) reads the `team/<organisation>` and `project/<organisation>` memory namespaces and writes `team/<organisation>` only. Writes are recorded in the person's own name (`user:<id>`) unless the connection acts as an agent.

### OAuth endpoints

_Applies to: Cloud._

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/.well-known/oauth-protected-resource/mcp` | Protected resource metadata (RFC 9728) for the `/mcp` resource; the 401 from `/mcp` points here |
| `GET` | `/.well-known/oauth-protected-resource` | Same document, at the bare well-known path |
| `GET` | `/.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414). Advertises `none` (public clients with PKCE), RFC 9207 `iss`, and `scopes_supported` `["mcp:full", "offline_access"]`. Client ID Metadata Documents are not supported. |
| `GET` | `/.well-known/openid-configuration` | OpenID Connect discovery (adds `openid` and `email` to the scopes) |
| `POST` | `/register` | Dynamic client registration (RFC 7591). Rate-limited to 10 per minute for the same client (same name and redirect URIs) from one IP, and 60 per minute per IP. The IP is `X-Real-IP` from the edge, else the rightmost `X-Forwarded-For` entry |
| `GET` | `/authorize` | Authorization endpoint (authorization code with PKCE). Redirects to sign-in, then to the [consent page](#the-consent-page); the redirect carries `iss` (RFC 9207) |
| `GET` | `/authorize/callback` | Return from sign-in; completes the session handshake and continues to the consent page |
| `POST` | `/authorize/org` | The consent page's form post (organisation, agent, approve or deny), protected by a consent token and a same-origin check |
| `POST` | `/token` | Token endpoint (`authorization_code`, `refresh_token`) |
| `GET` | `/userinfo` | The signed-in person behind an access token |
| `GET` | `/health` | Public status document: version, commit, serving runtime (`runtime`, `bun`, `node`), transport, agent-identity mode and its source |
| `GET` | `/favicon.ico`, `/icon.png`, `/apple-touch-icon.png` | The VantagePeers icon, shown by clients next to the connector |

### Tokens and revocation

_Applies to: Cloud._

- An access token lasts one hour. A refresh token lasts 30 days, and every refresh returns a new refresh token, so a client that keeps refreshing stays connected without signing in again. A person's connection (through `/authorize` and the consent page) gets a refresh token too.
- A refresh token is single-use. Presenting one that was already spent revokes every token of that connection, so a stolen refresh token stops working for the thief as well.
- A member removed from an organisation loses that organisation's access within seconds: their live tokens for it are revoked, and a refresh is answered `invalid_grant`.

### Agent identity

_Applies to: Cloud._

An agent is identified by its **agent ID** (the `agentId` that `list_peers` returns), never by the spelling of its name. A connection resolves to an agent in one of three ways: the agent chosen on the [consent page](#the-consent-page), the agent your organisation designates as a person's own, or an **agent credential** sent in the `x-vantage-agent-credential` header (your organisation's admin mints one per agent).

- Once a connection resolves to an agent, every action is recorded as that agent ID. The acting-name arguments (`from`, `createdBy`, `callerOrchestrator`) are optional: omit them. A typed name for a different agent is refused (`AGENT_IDENTITY_MISMATCH`). Renaming an agent keeps its credential and its grants.
- A typed agent name with no agent credential is refused (`AGENT_CREDENTIAL_REQUIRED`, naming the header). This is the default: the server runs in `strict` mode unless its operator explicitly sets `VANTAGE_ACTOR_CREDENTIAL_MODE=permissive`, and an unset, empty or unrecognised value is `strict`. One exemption: a seat whose token lists exactly one agent may name that agent. The operator master credential always needs the agent credential to act as an agent. The active mode and where it comes from are published at `/health` under `actor_credential`.
- Naming another agent as the assignee of work (a mission `pilot`, a task `assignedTo`) is an assignment, not an identity claim: it is checked against your organisation's roster, not against your credential.
- A call with no authorization context is refused `RBAC_DENIED` (reason `no-context`).

## Tools

_Applies to: Cloud and Self-host._

<!-- tools:start -->
88 tools are advertised to clients. This reference is generated from the server's own `tools/list` by `scripts/print-tools.mjs`; do not edit it by hand.

### Memory and search (9)

- `get_memory` (read) — Fetch a single memory by its Convex document ID, including relations and episode metadata.
- `hybrid_search` (read) — Combined vector + BM25 search via Reciprocal Rank Fusion for best semantic and keyword coverage.
- `list_memories` (read) — List active (isLatest=true) memories for a namespace, ordered newest first.
- `recall` (read) — Semantic vector search over VantagePeers memories, ranked by cosine similarity.
- `soft_delete_document` (write) — Soft-delete all Knowledge Base chunks for a document.
- `soft_delete_memory` (write, destructive) — Soft-delete a memory so it stops appearing in recall results while remaining in the audit log.
- `store_document_chunked` (write) — Ingest a document binary (PDF, Markdown, plain text) into the Knowledge Base.
- `store_memory` (write) — Store a typed memory entry (user/feedback/project/reference) in VantagePeers with optional graph relations.
- `text_search` (read) — BM25 full-text keyword search over VantagePeers memories for exact term matching.

### Fix patterns (7)

- `add_fix_attempt` (write) — Add a fix attempt record to a pattern with description, outcome, and optional commit reference.
- `create_fix_pattern` (write) — Create a fix pattern in the knowledge base documenting symptom, root cause, and optional validated fix.
- `get_fix_pattern` (read) — Fetch a single fix pattern by its Convex document ID, including all linked fix attempts.
- `link_issue_to_pattern` (write) — Link a VantagePeers issue to a fix pattern creating a bidirectional reference.
- `list_fix_patterns` (read) — List fix patterns filtered by source project, newest first with cursor paging support.
- `search_fix_patterns` (read) — Semantic search over fix patterns by symptom description, ranked by relevance.
- `validate_fix` (write) — Set or update the validated fix description on a fix pattern after confirming it works.

### Missions and templates (9)

- `create_mission` (write) — Create a mission grouping related tasks under a project with a pilot orchestrator and agent list.
- `get_mission` (read) — Fetch a single mission by Convex ID with full details: status, pilot, agents, progress, and dates.
- `get_mission_template` (read) — Fetch a mission template by name with all steps, or null if not found.
- `instantiate_template_into_mission` (write) — Create one task per template step inside a mission, pre-assigned to each step's declared orchestrator.
- `list_missions` (read) — List missions filtered by project, pilot, or status, newest first with cursor paging support.
- `list_tasks_by_mission` (read) — List all tasks linked to a mission, optionally filtered by status, newest first.
- `update_mission` (write) — Update any mutable field on a mission; only provided fields are patched, updatedAt auto-set.
- `update_mission_status` (write) — Change a mission's lifecycle status in a single call without touching other fields.
- `update_mission_template` (write) — Create or upsert a mission template by name; existing templates are overwritten.

### Recurring tasks (7)

- `create_recurring_task` (write) — Create a recurring task template that auto-generates tasks on a cron schedule.
- `delete_recurring_task` (write, destructive) — Permanently delete a recurring task template, stopping all future scheduled task generation.
- `get_recurring_task` (read) — Fetch a single recurring task definition by its Convex document ID with cron schedule, prompt, assignee, and last-fire metadata.
- `list_recurring_tasks` (read) — List recurring task templates filtered by assignee or active status, newest first.
- `pause_recurring_task` (write) — Pause a recurring task template to stop auto-creating tasks until explicitly resumed.
- `resume_recurring_task` (write) — Resume a paused recurring task template and recalculate its next scheduled run time.
- `update_recurring_task` (write) — Update a recurring task template's fields; cronExpression change auto-recalculates nextRunAt.

### Tasks (16)

- `add_task_dependency` (write) — Add dependency task IDs to a task so it cannot start until all listed tasks complete.
- `block_task` (write, destructive) — Mark a task as blocked with an optional reason and blocking task IDs, setting status to blocked.
- `bulk_complete_tasks` (write) — Bulk-close tasks that match a filter in one atomic mutation.
- `checkout_task` (write) — Atomically claim a todo task, preventing race conditions when multiple orchestrators compete.
- `complete_task` (write) — Mark a task as done with a mandatory completionNote; always notify the creator via send_message after.
- `correct_task_segment` (write) — Restate the real boundaries of ONE recorded work segment, when it grew across an unrecorded break (e.g. a station's session ended without pause_task and the segment stayed open for days).
- `create_task` (write) — Create a task assigned to an orchestrator with priority, status tracking, and optional mission link.
- `delete_task` (write, destructive) — Permanently delete a task; only the creator or system role may delete.
- `fail_task` (write) — Mark a task as failed (a terminal state distinct from done/cancelled) with a mandatory failureNote describing how the work ended.
- `get_task` (read) — Fetch a single task by its Convex document ID with all fields: title, description, status, priority, assignment, dependencies, mission link, completion note.
- `list_tasks` (read) — List tasks with optional filters by assignee, status, project, or creator, newest first.
- `pause_task` (write) — Close the task's open work segment and stop the duration clock, without ending the task.
- `resume_task` (write) — Open a new work segment on a paused task and set it back to in_progress.
- `search_tasks_by_keyword` (read) — BM25 full-text keyword search over task titles, ranked by relevance.
- `start_task` (write) — Set a task to in_progress and record the startedAt timestamp for duration tracking.
- `update_task` (write) — Update any mutable field on a task; only provided fields are patched, updatedAt auto-set.

### Messages (8)

- `check_messages` (read) — Check for unread messages addressed to a recipient role, returning receiptIds for acknowledgment.
- `delete_message` (write, destructive) — Delete a message and all its receipts; only the original sender or system may delete.
- `get_message` (read) — Fetch a single peer message by its Convex document ID with full body, channel, sender, sessionDay, and tenant scope.
- `list_broadcast_status` (read) — Show read/unread receipt status for a broadcast message by messageId.
- `list_messages` (read) — List historical messages filtered by session day or sender, newest first; use check_messages for unread.
- `mark_as_read` (write) — Mark one or more message receipts as read using receiptIds from check_messages.
- `search_messages_by_keyword` (read) — BM25 full-text keyword search over message content, ranked by relevance.
- `send_message` (write) — Send a message to one or more agents BY AGENT ID (recipientAgentIds, the `agentId` values list_peers returns), or via channel routing (broadcast / fleet role / instance).

### Briefing notes (5)

- `create_briefing_note` (write) — Create a structured briefing note capturing a topic discussion with participants, decisions, and memory links.
- `get_briefing_note` (read) — Fetch a single briefing note by ID with all fields: title, topic, participants, content, decisions, and links.
- `list_briefing_notes` (read) — List briefing notes filtered by topic, newest first, with cursor paging support.
- `search_briefing_notes_by_keyword` (read) — BM25 full-text keyword search over briefing note content, ranked by relevance.
- `update_briefing_note` (write) — Update an existing briefing note; only provided fields are patched (arrays are FULL REPLACE).

### Episodes (5)

- `get_episode` (read) — Fetch a single episode by its memory document ID.
- `list_episodes` (read) — List episodes (memories with type='episode') ordered newest first.
- `search_episodes_by_keyword` (read) — BM25 full-text keyword search restricted to episodes (memories with type='episode').
- `search_episodes_by_semantic` (read) — Semantic vector search restricted to episodes (memories with type='episode'), ranked by cosine similarity.
- `store_episode` (write) — Store a structured episodic memory capturing context, goal, action, outcome, and insight from a past event.

### Diary (3)

- `get_diary` (read) — Fetch a diary entry for a specific date and orchestrator, returning null if none exists.
- `list_diaries` (read) — List diary entries filtered by orchestrator or author, newest first with cursor paging support.
- `write_diary` (write) — Write or upsert a diary entry for a specific date and orchestrator with highlights and blockers.

### Billing (1)

- `billing_summary_by_project` (read) — Billing/refacturation base — sums MACHINE-derived actualMinutes (startedAt→completedAt, never a hand-typed time line) grouped by project for tasks completed within [from, to].

### Profiles and peers (4)

- `get_profile` (read) — Fetch an orchestrator profile with static identity and dynamic session state fields.
- `list_peers` (read) — List all orchestrator profiles with current status, summary, and session info, newest first.
- `set_summary` (write) — Update the current-work summary for an orchestrator instance, visible via list_peers.
- `update_profile` (write) — Create or update an orchestrator profile with static identity facts and dynamic session state.

### Knowledge bundles (OKF) (2)

- `export_okf_bundle` (write) — Export a VantagePeers namespace as an OKF v0.1 bundle (tarball).
- `import_okf_bundle` (write) — Import an OKF v0.1 bundle (memories + briefing-notes + tasks) into a target VantagePeers namespace.

### Other (12)

- `add_repo_mapping` (write) — Register or update a GitHub repo to orchestrator mapping for webhook event routing.
- `claim_upload` (write) — Claim an uploaded blob for your organisation with the single-use ticket generate_upload_url returned.
- `debate_get_room` (read) — Read a debate room: its subject, frozen template, pointer and the full transcript.
- `debate_post_turn` (write) — Post your answer to the debate-room turn you were asked for; the only way a turn enters a room.
- `generate_upload_url` (write) — Mint a Convex storage upload URL for the Knowledge Base ingest flow.
- `get_bulk_complete_run` (read) — Read the status of one live bulk_complete_tasks run by the `bulkRunId` its first call returned.
- `get_github_owner_bindings` (read) — List the GitHub owners bound to your organisation (master: all), and for master the org-owned repo mappings that have no proof.
- `improvisation_digest` (read) — Scan a rolling time window of VP tasks, messages, and memories for durable artifacts that carry fleet/state tokens (commit SHA, PR#, VP id, or decisive verb such as merged/deployed/approved) but have NO VP-Sources footer.
- `list_blocked_on_me` (read) — List the tasks that other peers have BLOCKED on one of YOUR live tasks (blockedOnTaskId), oldest wait first, with the age of each wait.
- `list_repo_mappings` (read) — List all GitHub repo to orchestrator webhook mappings, newest first with cursor paging support.
- `remove_repo_mapping` (write, destructive) — Delete a GitHub repo mapping by repo name, stopping webhook event routing for that repo.
- `whoami` (read) — Returns the orchestrator identity baked into the current bearer's scope context.

The tools below are present in the server code but disabled in this release: a client can neither list nor call them. They are named so this reference matches the code exactly.

### Registered, not advertised (26)

`accept_mandate`, `add_deployment`, `create_bu`, `create_mandate`, `delete_bu`, `get_bu`, `get_error`, `get_issue`, `get_mandate`, `get_repo_mapping`, `issue_stats`, `link_commit_to_issue`, `list_bus`, `list_errors`, `list_issues`, `list_mandates`, `remove_deployment`, `settle_mandate`, `soft_delete_mission_template`, `update_bu`, `update_issue_status`, `update_mandate`, `validate_mandate_spending`, `validate_okf_bundle`, `validate_task_payload`, `verify_issue`
<!-- tools:end -->

### Tool inputs and outputs

_Applies to: Cloud and Self-host._

- **Annotations.** Every tool declares MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`), so clients such as ChatGPT can label read and write actions correctly. A tool marked read-only is checked against what its handler does.
- **Paging.** Most list and search tools page their results with a cursor and keep each response under a fixed size; when a response says more results exist, call again with the returned cursor. `get_github_owner_bindings` takes `limit`, `cursor` and `unprovenCursor` and returns `nextCursor` and `unprovenNextCursor`.
- **Rows your scope removed.** `list_peers`, `list_tasks_by_mission` and `list_recurring_tasks` answer a bare array when nothing was filtered out, and `{ items, nextCursor?, scopeFiltered }` when your scope removed rows of your own organisation from the page (`scopeFiltered` is that count; another organisation's rows are never counted). `list_broadcast_status` reports `scopeFiltered` and `truncated` beside its receipts. The cursor is decided on the raw page, so a narrowed page still carries its cursor.
- **List arguments.** Every list argument a client fills (for example `mark_as_read` `receiptIds`) accepts a JSON array or the same array sent as a JSON string. The status filters of `list_tasks`, `list_tasks_by_mission` and `list_missions` are published as an array of statuses; a single status, or an alias (`open`, `active`, `all`) on its own, is still accepted.
- **Output schemas are open.** A tool's `outputSchema` allows fields added in a later release, so a client connected before an upgrade keeps validating the answers.
- **Agents by ID.** `send_message` takes `recipientAgentIds` (the `agentId` values `list_peers` returns) and `fromAgentId`; `create_task` and `update_task` take `assignedToAgentId`. A message to a fleet coordinator by channel name is refused (`coordinator-by-name-refused`); address it by ID.
- **Evidence lines in messages.** In `send_message`, an `evidence:` line that states a live state (a pull request's state, a package version, a task status) must carry the command that produced it on the same line (for example `gh pr view 12 -R owner/repo --json state -> MERGED`) or a token (`{{pr:owner/repo#N}}`, `{{npm:pkg@tag}}`, `{{task:id}}`). A bare literal is refused, even when true, and nothing is sent; a stated state is still checked live.
- **Tasks.** `create_task` and `update_task` take an optional `deliverable` (`{ pkg, export }`); `get_task` and `list_tasks` then show `deliverableState` and, when the export is published while the task is still open, `deliverableDivergence: "delivered-but-open"`. `bulk_complete_tasks` closes the first 500 matches in the call and the rest in the background; read the run with `get_bulk_complete_run` and the `bulkRunId` it returned. `list_blocked_on_me` lists the tasks other peers have blocked on your live tasks.
- **Recurring tasks.** A schedule whose previous task is still open creates nothing at its next run and records the skip (`skippedRuns`, `lastSkippedAt`, `lastSkipReason`, shown by `get_recurring_task` and `list_recurring_tasks`).
- **Debate rooms.** `debate_get_room` reads a room and its transcript; `debate_post_turn` posts your answer when it is your turn. Out-of-turn, non-participant, empty, stale or over-long posts are refused with their own codes (`not_your_turn`, `not_a_participant`, `empty`, `stale_turn`, `too_long`).
- **Errors.** A protocol error thrown by a tool reads without the former `MCP error <code>:` prefix. `tools/list` stamps its JSON Schemas with the 2020-12 dialect and no longer carries `execution.taskSupport`.

## Security

_Applies to: Cloud._

- **Tenant isolation by permanent organisation ID.** Which organisation's data a request can reach is decided from the verified credential, never from a value the client types into a tool argument, and it is keyed on the organisation's permanent ID, not on its renamable name: an organisation that later takes a name another one released reads none of the previous holder's data. The tenant is applied inside each read, so another organisation's row is never read and then dropped. Each seat's token carries a scope profile set by your operator: which agents it may act as or read from, and which memory namespaces it may read and write.
- **Writes land in your organisation or are refused.** A write made through a non-operator credential is stamped with that credential's organisation; when the organisation resolves to no active mapping, the write is refused `RBAC_DENIED` instead of being stored without an organisation. Knowledge Base tools act for your verified organisation, and `store_document_chunked` ingests only a blob your organisation claimed with `claim_upload`.
- **Messages stay in your organisation.** A seat's direct messages and broadcasts reach its own organisation's roster, plus fleet coordinators your organisation is explicitly allowed to address.
- **Agent identity comes from a credential, not a typed name.** See [Agent identity](#agent-identity). A caller from another organisation cannot send a message, or act on a task, under one of your agents' names, even when both organisations have an agent with the same name.
- **A refusal never looks like an empty result.** A read you are not allowed to make returns an explicit error (for example, `list_peers`, `list_diaries` and `list_briefing_notes` return text opening with `REFUSED (RBAC_DENIED)`) rather than an empty list, so an agent cannot mistake "not allowed" for "nothing there". An agent credential that does not resolve is refused with its own code (`AGENT_CREDENTIAL_INVALID`, HTTP 401), distinct from a lookup failure. A signed-in user whose account has no organisation yet receives its own refusal, distinct from an invalid token.
- **Token checks.** Clerk session tokens are verified against the issuer's published keys, with issuer and audience both bound. OAuth client secrets are compared in constant time. `redirect_uri` must match a registered URI exactly, and dynamic registration rejects non-HTTPS redirect URIs (except `localhost` / `127.0.0.1`). The consent page's form post must come from the same origin.
- **Health document.** `/health` is public and publishes only aggregates (version, commit, serving runtime, transport, the agent-identity mode and where it comes from). It never echoes a secret or a customer identifier.

To report a vulnerability, open an issue at https://github.com/vantageos-agency/vantage-peers/issues without exploit details and ask for a private channel.

## Self-host (a separate product)

_Applies to: Self-host._

This package also contains the server itself, and can run as a local stdio MCP server against your own deployment:

```bash
CONVEX_URL=https://<your-deployment>.convex.cloud npx vantage-peers-mcp
```

That is **VantagePeers Self-host**, a separate product with its own setup (backend deployment, service identity, environment). It is documented separately at https://vantagepeers.com/docs/getting-started. Nothing in that setup applies to VantagePeers Cloud, and nothing above is needed to self-host.

The stdio server answers MCP protocol `2026-07-28` and `2025-11-25` clients alike. It presents the service identity of your deployment to your backend (`CLERK_SECRET_KEY` and `CLERK_SERVICE_ACCOUNT_USER_ID`, see the Self-host guide); without it, it refuses to start.

The package also exports typed function references for the VantagePeers backend at `vantage-peers-mcp/api`, for TypeScript services that call a deployment directly.

### Backend compatibility check

_Applies to: Self-host._

Before it serves anything, the server asks your backend for its contract manifest (`meta:backendContract`) and refuses to start, with a log line beginning `BACKEND INCOMPATIBLE (<reason>)`, when:

- the backend has no manifest (it predates this check);
- the backend's contract version is below **10**, the version this release requires;
- any of the **141** backend functions this release calls is missing (they are named in the log);
- the server cannot present its service identity, or the backend refuses it.

So upgrade in this order: deploy the backend of the same release first, then upgrade this package. The check sees a missing function, not a changed argument; the contract version covers that.

## Release notes

### 4.0.0

_Applies to: Cloud and Self-host._ Each item names the product it concerns.

**Breaking**

- Cloud: connecting signs in a person. `/authorize` no longer issues a code to a registered client on its own: you sign in with your VantagePeers account and approve on the [consent page](#the-consent-page), choosing the organisation and the agent.
- Cloud: agent identity is `strict` by default. A typed agent name without an agent credential is refused `AGENT_CREDENTIAL_REQUIRED` unless the operator explicitly sets `permissive` (see [Agent identity](#agent-identity)).
- Cloud: a write whose organisation resolves to no active mapping is refused instead of stored without an organisation, and a token of an inactive or unmapped organisation is refused with HTTP 401 (see [Security](#security)).
- Cloud and Self-host: `list_peers`, `list_tasks_by_mission` and `list_recurring_tasks` answer `{ items, nextCursor?, scopeFiltered }` when your scope removed rows; `send_message` refuses an `evidence:` line that states a live state without its command; tool protocol errors lose the `MCP error <code>:` prefix (see [Tool inputs and outputs](#tool-inputs-and-outputs)).
- Self-host: the server refuses to start against a backend below contract version 10 or missing a function it calls (see [Backend compatibility check](#backend-compatibility-check)). `engines.node` is `26.12.1` (see [Requirements](#requirements)).

**Added**

- Cloud and Self-host: MCP protocol `2026-07-28` beside `2025-11-25`.
- Cloud: the consent page lets you choose the agent a connection acts as; a person can hold one agent per AI client; a person's connection gets a refresh token; `offline_access` is advertised; OpenID discovery and `/userinfo` (see [OAuth endpoints](#oauth-endpoints)).
- Cloud and Self-host: `list_blocked_on_me`, `get_bulk_complete_run`, `debate_get_room`, `debate_post_turn`; agent-ID arguments; task deliverables; `whoami` names the agent by ID and returns `caller_id`, `org_slug`, `role` (see [Tools](#tools)).

**Security and fixes**

- Cloud: tenant isolation keyed on the permanent organisation ID and applied inside each read; a removed member loses access within seconds; a replayed refresh token revokes its connection (see [Tokens and revocation](#tokens-and-revocation)).
- Cloud and Self-host: list arguments accept a JSON string; output schemas accept added fields; dependencies updated (`zod` ^4.6.7, `@vantageos/cloud-identity` ^0.27.0; `zod` 4.3.6 and 4.4.3 carried GHSA-mrhx-c7xc-m3w5).

### 3.0.0

**Breaking**

- The `components` registry (six tools: `list_components`, `register_component`, `get_component`, `update_component`, `delete_component`, `search_components`) is removed, together with its entry in the `vantage-peers-mcp/api` type exports. These tools were not advertised to clients in 2.19.0.
- Two legacy credential types are no longer accepted: tokens from the retired dynamic-registration token store, and legacy internal tenant bearers. A request presenting either is refused with HTTP 401. OAuth access tokens issued by `/token` and Clerk session tokens are unaffected.

**Added**

- `correct_task_segment`: narrow a recorded work span to its real boundaries, once, with a mandatory reason. The original span is kept for audit.
- Now available to clients: `whoami` (returns the identity attached to your own credential: agent name, scope profile, namespaces) and `generate_upload_url` (an upload URL for your own organisation's storage, used before `store_document_chunked`).
- Now available to clients: `fail_task` (a third terminal state, distinct from done and cancelled), `pause_task` and `resume_task` (stop and restart a task's work clock without ending it).
- Now available to clients: the fix-pattern tools `create_fix_pattern`, `get_fix_pattern`, `list_fix_patterns`, `search_fix_patterns`, `add_fix_attempt`, `validate_fix` and `link_issue_to_pattern`.
- `check_messages` reports how many in-progress tasks are stuck past the configured threshold on an open work segment, alongside the stuck list.
- `/health` publishes the agent-identity mode, where that mode comes from, and how many calls were served on a typed agent name without a credential.

**Security and fixes**

- Agents act under the credential they present (`x-vantage-agent-credential`), not under a name typed into a tool argument. Names are compared after case and Unicode normalisation; accented and unaccented names stay distinct.
- A message's sender is checked against the verified caller: a caller from another organisation can no longer sign as one of your agents.
- `list_peers` surfaces a backend refusal as an explicit error instead of an empty list.
- A signed-in user with no organisation yet receives a typed refusal instead of the "invalid token" answer. An agent credential that does not resolve is refused as `AGENT_CREDENTIAL_INVALID` (HTTP 401), distinct from a lookup failure.
- Every refresh now returns a new refresh token, so a seat that keeps refreshing no longer expires at 30 days.
- Seat names are canonical and unique across organisations.
- The server no longer passes a privileged secret to the backend as a function argument; the backend authorises it by identity.

Full history: [CHANGELOG.md](https://github.com/vantageos-agency/vantage-peers/blob/main/mcp-server/CHANGELOG.md).

## Versioning

`vantage-peers-mcp` follows semver:

- **Major**: a removed tool, a removed argument, a changed input or output shape, or a credential that stops being accepted.
- **Minor**: new tools, new optional arguments, newly exposed tools.
- **Patch**: fixes with no change to any tool's contract.

## Requirements

_Applies to: Self-host._

Node.js 26.12.1 (the October 2026 security release), for the Self-host stdio server and the `vantage-peers-mcp/api` exports: `engines.node` names that exact version. A backend of the same release (contract version 10, see [Backend compatibility check](#backend-compatibility-check)). VantagePeers Cloud clients need nothing installed.

## License

[FSL-1.1-Apache-2.0](https://github.com/vantageos-agency/vantage-peers/blob/main/LICENSE)
