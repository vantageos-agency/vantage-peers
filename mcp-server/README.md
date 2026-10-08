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

VantagePeers Cloud is hosted: **you do not need to install this package to use it.** You connect your MCP client to the Cloud endpoint.

At onboarding your operator gives you:

1. **The endpoint URL** of your VantagePeers Cloud server. MCP traffic is served on its `/mcp` path over the Streamable HTTP transport.
2. **OAuth credentials** (a client ID and client secret) for each seat. Use these; do not register new clients yourself. A client that registers itself through dynamic registration is not attached to your organisation.
3. Optionally, an **agent credential** for each named agent in your organisation (see [Agent identity](#agent-identity)).

Keep the client secret and any token out of chat messages, email and source control.

### Claude.ai

1. Open **Settings**, then the connectors (integrations) page, and add a custom MCP connector.
2. Paste the endpoint URL from onboarding.
3. Complete the OAuth sign-in with your onboarding client ID and secret.

### ChatGPT

1. Open **Settings → Apps** and add a connector.
2. Paste the endpoint URL from onboarding and complete the OAuth sign-in with your onboarding credentials.
3. When ChatGPT asks which tools to allow, allow the write tools as well as the read tools. Without them, reads work and every write is refused.

### Claude Code

```bash
claude mcp add --transport http vantage-peers <ENDPOINT_URL>
```

Then run `/mcp` inside a Claude Code session and authenticate `vantage-peers` with your onboarding credentials. If you were issued an agent credential, add it as a header when you register the server:

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

Then sign in with `codex mcp login vantage-peers`, using your onboarding credentials.

### Any other MCP client or IDE

Any client that supports remote MCP servers over Streamable HTTP can connect:

- **URL:** the endpoint URL from onboarding. It always ends in `/mcp` (for example `https://<your-host>/mcp`); enter it exactly, not the bare host.
- **Authentication:** OAuth 2.1. The server publishes its metadata at `/.well-known/oauth-protected-resource/mcp` (also at `/.well-known/oauth-protected-resource`) and `/.well-known/oauth-authorization-server`, so a client that supports MCP authorization discovers the rest by itself. The protected-resource `resource` value is the `/mcp` URL itself.
- A client that cannot run OAuth can send an access token as `Authorization: Bearer <token>`. Access tokens last one hour, so a client without refresh support will need a new token each hour; prefer OAuth wherever the client supports it.

### Check the connection

Ask your agent who it is (`whoami`), to list your peers (`list_peers`), or to store and then recall a short note (`store_memory`, then `recall`). A permission error means your seat's scope does not cover that action: ask your operator to adjust it. You do not need new credentials for that.

## Authentication

The `/mcp` endpoint accepts exactly these credentials, checked in this order:

| Credential | Who holds it | What it grants |
|---|---|---|
| OAuth access token issued by this server's `/token` endpoint | Each seat, through your MCP client | The scope profile attached to that seat by your operator |
| Clerk session token of a member of an organisation | Members authenticating with a VantagePeers (Clerk) session | Your organisation's own data only, resolved from the organisation in the verified token |
| Operator master credential | The service operator only, never issued to customers | Administration |

Any other bearer value is refused with HTTP 401. It is never treated as a lower-privilege guest.

OAuth endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/.well-known/oauth-protected-resource/mcp` | Protected resource metadata (RFC 9728) for the `/mcp` resource; the 401 from `/mcp` points here |
| `GET` | `/.well-known/oauth-protected-resource` | Same document, at the bare well-known path |
| `GET` | `/.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414). Advertises `none` (public clients with PKCE) and RFC 9207 `iss`. Client ID Metadata Documents are not supported. |
| `POST` | `/register` | Dynamic client registration (RFC 7591). Rate-limited to 10 per minute for the same client (same name and redirect URIs) from one IP, and 60 per minute per IP. The IP is `X-Real-IP` from the edge, else the rightmost `X-Forwarded-For` entry |
| `GET` | `/authorize` | Authorization endpoint (authorization code with PKCE); the redirect carries `iss` (RFC 9207) |
| `POST` | `/token` | Token endpoint (`authorization_code`, `refresh_token`) |
| `GET` | `/health` | Public status document: version, transport, agent-identity mode |

Token lifetimes: an access token lasts one hour. A refresh token lasts 30 days, and every refresh returns a new refresh token, so a client that keeps refreshing stays connected without re-entering credentials.

### Agent identity

Your organisation's credential authenticates the **organisation**. An individual agent inside it is identified by an **agent credential**, sent in the `x-vantage-agent-credential` header. Your organisation's admin mints one per agent.

- With an agent credential, every action is recorded as that agent. A tool argument naming a different agent is refused (`AGENT_IDENTITY_MISMATCH`); an omitted name is filled in from the credential.
- Without one, the server's mode decides. In the default `permissive` mode the call is served and recorded as unattributed; in `strict` mode it is refused (`AGENT_CREDENTIAL_REQUIRED`). The active mode is published at `/health` under `actor_credential`.

## Tools

<!-- tools:start -->
80 tools are advertised to clients. This reference is generated from the server's own `tools/list` by `scripts/print-tools.mjs`; do not edit it by hand.

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
- `send_message` (write) — Send a message to one, many, or all orchestrators via channel routing (broadcast / role DM / instance DM).

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
- `list_peers` (read) — List all orchestrator profiles with current status, summary, and session info, newest first. A non-master token that carries an organisation lists that organisation's roster (not its `from` allowlist); other organisations' agents are never listed.
- `set_summary` (write) — Update the current-work summary for an orchestrator instance, visible via list_peers.
- `update_profile` (write) — Create or update an orchestrator profile with static identity facts and dynamic session state.

### Knowledge bundles (OKF) (2)

- `export_okf_bundle` (read) — Export a VantagePeers namespace as an OKF v0.1 bundle (tarball).
- `import_okf_bundle` (write) — Import an OKF v0.1 bundle (memories + briefing-notes + tasks) into a target VantagePeers namespace.

### Other (5)

- `claim_upload` (write) — Claim an uploaded blob for your organisation with the single-use ticket generate_upload_url returned (required before validate_okf_bundle reads it).
- `generate_upload_url` (write) — Mint a Convex storage upload URL for the Knowledge Base ingest flow, plus a single-use upload ticket bound to your org.
- `get_bulk_complete_run` (read) — Read the status of one live bulk_complete_tasks run by the `bulkRunId` its first call returned.
- `improvisation_digest` (read) — Scan a rolling time window of VP tasks, messages, and memories for durable artifacts that carry fleet/state tokens (commit SHA, PR#, VP id, or decisive verb such as merged/deployed/approved) but have NO VP-Sources footer.
- `whoami` (read) — Returns the orchestrator identity baked into the current bearer's scope context.

The tools below are present in the server code but disabled in this release: a client can neither list nor call them. They are named so this reference matches the code exactly.

### Registered, not advertised (29)

`accept_mandate`, `add_deployment`, `add_repo_mapping`, `create_bu`, `create_mandate`, `delete_bu`, `get_bu`, `get_error`, `get_issue`, `get_mandate`, `get_repo_mapping`, `issue_stats`, `link_commit_to_issue`, `list_bus`, `list_errors`, `list_issues`, `list_mandates`, `list_repo_mappings`, `remove_deployment`, `remove_repo_mapping`, `settle_mandate`, `soft_delete_mission_template`, `update_bu`, `update_issue_status`, `update_mandate`, `validate_mandate_spending`, `validate_okf_bundle`, `validate_task_payload`, `verify_issue`
<!-- tools:end -->

Every tool declares MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`), so clients such as ChatGPT can label read and write actions correctly. Most list and search tools page their results with a cursor and keep each response under a fixed size; when a response says more results exist, call again with the returned cursor.

## Security

- **Tenant isolation.** Each seat's token carries a scope profile set by your operator: which agents it may act as or read from, and which memory namespaces it may read and write. A member signed in through Clerk is confined to the `team/<organisation>` namespaces resolved from the organisation in the verified token. Which organisation's data a request can reach is decided from the verified credential, never from a value the client types into a tool argument.
- **Agent identity comes from a credential, not a typed name.** See [Agent identity](#agent-identity). A caller from another organisation cannot send a message under one of your agents' names.
- **A refusal never looks like an empty result.** A read you are not allowed to make returns an explicit error (for example, `list_peers` returns text opening with `REFUSED (RBAC_DENIED)`) rather than an empty list, so an agent cannot mistake "not allowed" for "nothing there". An agent credential that does not resolve is refused with its own code (`AGENT_CREDENTIAL_INVALID`, HTTP 401), distinct from a lookup failure. A signed-in user whose account has no organisation yet receives its own refusal, distinct from an invalid token.
- **Token checks.** Clerk session tokens are verified against the issuer's published keys, with issuer and audience both bound. OAuth client secrets are compared in constant time. `redirect_uri` must match a registered URI exactly, and dynamic registration rejects non-HTTPS redirect URIs (except `localhost` / `127.0.0.1`).
- **Health document.** `/health` is public and publishes only aggregates (version, commit, transport, the agent-identity mode and where it comes from). It never echoes a secret or a customer identifier.

To report a vulnerability, open an issue at https://github.com/vantageos-agency/vantage-peers/issues without exploit details and ask for a private channel.

## Self-host (a separate product)

This package also contains the server itself, and can run as a local stdio MCP server against your own deployment:

```bash
CONVEX_URL=https://<your-deployment>.convex.cloud npx vantage-peers-mcp
```

That is **VantagePeers Self-host**, a separate product with its own setup (backend deployment, service identity, environment). It is documented separately at https://vantagepeers.com/docs/getting-started. Nothing in that setup applies to VantagePeers Cloud, and nothing above is needed to self-host.

The package also exports typed function references for the VantagePeers backend at `vantage-peers-mcp/api`, for TypeScript services that call a deployment directly.

## Release notes

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

Node.js 20 or later, for the Self-host stdio server and the `vantage-peers-mcp/api` exports. VantagePeers Cloud clients need nothing installed.

## License

[FSL-1.1-Apache-2.0](https://github.com/vantageos-agency/vantage-peers/blob/main/LICENSE)
