# Changelog

## [Unreleased]

## [4.0.0] — 2026-11-01

Customer-facing summary of every `mcp-server/` change since 3.0.0. Each entry says which product it concerns (VantagePeers Cloud, the hosted service; VantagePeers Self-host, the separate product) and links the README section that documents it. The repository changelog carries the full engineering record of the same release.

### Breaking

- Cloud: connecting signs in a person. `/authorize` no longer issues a code to a registered client on its own: it redirects to sign-in, then to a consent page where the person chooses one of their own organisations and the agent the connection acts as, and approves. A client ID and secret alone no longer connect. ([Connect to VantagePeers Cloud](README.md#connect-to-vantagepeers-cloud), [The consent page](README.md#the-consent-page))
- Cloud: agent identity is `strict` by default. With `VANTAGE_ACTOR_CREDENTIAL_MODE` unset, empty or unrecognised, a typed agent name without an agent credential is refused `AGENT_CREDENTIAL_REQUIRED` (the header is named); only an explicit `permissive` restores the old behaviour. A seat whose token lists exactly one agent may still name that agent. The operator master credential always needs the agent credential to act as an agent. `/health` publishes the mode and its source (`configured`, `unset`, `empty`, `coerced`). ([Agent identity](README.md#agent-identity))
- Cloud: a write through a non-operator credential whose organisation resolves to no active mapping is refused `RBAC_DENIED` instead of being stored without an organisation, and an access token of an inactive or unmapped organisation is refused with HTTP 401. ([Security](README.md#security), [Authentication](README.md#authentication))
- Cloud and Self-host: `list_peers`, `list_tasks_by_mission` and `list_recurring_tasks` answer `{ items, nextCursor?, scopeFiltered }` instead of a bare array when your scope removed rows of your organisation from the page; the cursor is decided on the raw page. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `send_message` refuses an `evidence:` line that states a live state (pull request, package version, task status) with no command on the same line, even when it is true; nothing is sent. Use the command form or a `{{pr:…}}` / `{{npm:…}}` / `{{task:…}}` token. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: the server moves to the MCP server SDK 2.x. A protocol error thrown by a tool reads without the `MCP error <code>:` prefix, `tools/list` stamps the 2020-12 JSON Schema dialect, and `execution.taskSupport` is no longer published. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Self-host: the server refuses to start, before it listens or opens stdio, against a backend that has no contract manifest, whose contract version is below 10, or that lacks any of the 141 functions it calls; the log line `BACKEND INCOMPATIBLE (<reason>)` names the missing functions. Deploy the backend first. ([Backend compatibility check](README.md#backend-compatibility-check))
- Self-host: `engines.node` is pinned to `26.12.1`, the October 2026 security release (was `>=20`), and `.node-version` carries the same value. ([Requirements](README.md#requirements))

### Added

- Cloud and Self-host: MCP protocol `2026-07-28` (`server/discover`, used by ChatGPT) is served beside `2025-11-25` (Claude.ai, Claude Code, Codex); each client is answered in its own version. ([Any other MCP client or IDE](README.md#any-other-mcp-client-or-ide), [Self-host](README.md#self-host-a-separate-product))
- Cloud: the consent page lists the agents of the chosen organisation that designate you or nobody, defaults to **Connect as myself**, and lets an organisation admin create an agent. A person can hold one agent per AI client. A person token can also act as the agent the organisation designates as that person's own. ([The consent page](README.md#the-consent-page), [Agent identity](README.md#agent-identity))
- Cloud: sign-in from ChatGPT and Claude completes through `GET /authorize/callback` with Clerk's session handshake instead of answering `403 session-required`. New `GET /userinfo` and `/.well-known/openid-configuration`; `scopes_supported` advertises `offline_access`. ([OAuth endpoints](README.md#oauth-endpoints))
- Cloud: a person's connection gets a refresh token on the code exchange, so it no longer ends when the access token expires. ([Tokens and revocation](README.md#tokens-and-revocation))
- Cloud and Self-host: new tools `list_blocked_on_me`, `get_bulk_complete_run`, `debate_get_room` and `debate_post_turn`. ([Tools](README.md#tools), [Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: agent-ID arguments, each the `agentId` that `list_peers` returns: `send_message` `recipientAgentIds` and `fromAgentId`, `create_task` and `update_task` `assignedToAgentId`. Once a connection resolves to an agent, the acting-name arguments are optional. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs), [Agent identity](README.md#agent-identity))
- Cloud and Self-host: `create_task` / `update_task` take an optional `deliverable` (`{ pkg, export }`); task reads show `deliverableState` and `deliverableDivergence: "delivered-but-open"`. `get_github_owner_bindings` pages with `limit`, `cursor` and `unprovenCursor`. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `whoami` names the acting agent by ID (`actor`: `agentId`, `orgId`, `agentName`, `orgSlug`, or `null` with `agent_unresolved_reason`) and returns `caller_id` (opaque and stable), `org_slug`, `role` and `acting_name`, with a declared `outputSchema`. ([Check the connection](README.md#check-the-connection))
- Cloud: the server serves the VantagePeers icon at `/favicon.ico`, `/icon.png` and `/apple-touch-icon.png`; `/health` reports the serving runtime (`runtime`, `bun`, `node`). ([OAuth endpoints](README.md#oauth-endpoints))

### Changed

- Cloud: a person (OAuth or Clerk session) reads `team/<organisation>` and `project/<organisation>` and writes `team/<organisation>` only; writes without an acting agent are recorded as `user:<id>`. A viewer role reads; every write tool needs an editor or admin role. ([Authentication](README.md#authentication), [The consent page](README.md#the-consent-page))
- Cloud: an acting name is judged once, before the tool runs, by the identity package. Refusals keep their codes (`AGENT_IDENTITY_MISMATCH`, `AGENT_CREDENTIAL_REQUIRED`); a call with no authorization context is refused `RBAC_DENIED` (`no-context`). A mission `pilot` or a task assignee is an assignment checked against your organisation's roster, not an identity claim. ([Agent identity](README.md#agent-identity))
- Cloud: the consent page uses the VantagePeers design, shows each organisation with your role, and **Deny** redirects to the client with `error=access_denied`, its `state` and `iss`. ([The consent page](README.md#the-consent-page))
- Cloud and Self-host: every client-filled list argument accepts a JSON array sent as a string (Claude.ai sends `mark_as_read` `receiptIds` that way). The status filters of `list_tasks`, `list_tasks_by_mission` and `list_missions` are published as one shape, an array of statuses; a single status or an alias alone is still accepted. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: a recurring schedule whose previous task is still open creates nothing at its next run and records the skip. `bulk_complete_tasks` closes the first 500 matches in the call and the rest in the background. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Security and fixes

- Cloud: tenant isolation is keyed on the organisation's permanent ID, never its renamable name, and applied inside each read; Knowledge Base tools act for your verified organisation, and a seat can search the documents it ingested; `store_document_chunked` ingests only a blob your organisation claimed. ([Security](README.md#security))
- Cloud: a seat's direct messages and broadcasts stay within its organisation; another organisation's agent with the same name can no longer act on your tasks or sign your messages; `list_diaries` and `list_briefing_notes` report a refusal instead of an empty list. ([Security](README.md#security))
- Cloud: a replayed refresh token revokes every token of its connection; a member removed from an organisation loses its access within seconds and its refresh is answered `invalid_grant`. ([Tokens and revocation](README.md#tokens-and-revocation))
- Cloud: an `/authorize` request without `resource` (Claude.ai) is bound to the one resource the server publishes instead of being refused, and the consent page's form post no longer fails with `session-required` in a browser. ([OAuth endpoints](README.md#oauth-endpoints), [The consent page](README.md#the-consent-page))
- Cloud: a person token whose agent joined the organisation after the person connected can write without reconnecting. ([Agent identity](README.md#agent-identity))
- Cloud and Self-host: a tool's `outputSchema` accepts fields added later, so a client connected before an upgrade no longer rejects `whoami` with "must NOT have additional properties". ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: dependencies `zod` ^4.6.7 (GHSA-mrhx-c7xc-m3w5 in 4.3.6 and 4.4.3) and `@vantageos/cloud-identity` ^0.27.0. ([Requirements](README.md#requirements))

## [3.0.0] — 2026-10-01

Customer-facing summary of every `mcp-server/` change since 2.19.0 (commit `f718dd3`). Earlier releases are listed below.

### Breaking

- The `components` registry (six tools: `list_components`, `register_component`, `get_component`, `update_component`, `delete_component`, `search_components`) is removed, together with its entry in the `vantage-peers-mcp/api` type exports. These tools were not advertised to clients in 2.19.0.
- Two legacy credential types are no longer accepted: tokens from the retired dynamic-registration token store, and legacy internal tenant bearers. A request presenting either is refused with HTTP 401. OAuth access tokens issued by `/token` and Clerk session tokens are unaffected.

### Added

- `correct_task_segment`: narrow a recorded work span to its real boundaries, once, with a mandatory reason. The original span is kept for audit.
- Now available to clients: `whoami` (returns the identity attached to your own credential: agent name, scope profile, namespaces) and `generate_upload_url` (an upload URL for your own organisation's storage, used before `store_document_chunked`).
- Now available to clients: `fail_task` (a third terminal state, distinct from done and cancelled), `pause_task` and `resume_task` (stop and restart a task's work clock without ending it).
- Now available to clients: the fix-pattern tools `create_fix_pattern`, `get_fix_pattern`, `list_fix_patterns`, `search_fix_patterns`, `add_fix_attempt`, `validate_fix` and `link_issue_to_pattern`.
- `check_messages` reports how many in-progress tasks are stuck past the configured threshold on an open work segment, alongside the stuck list.
- `/health` publishes the agent-identity mode, where that mode comes from, and how many calls were served on a typed agent name without a credential.

### Security and fixes

- Agents act under the credential they present (`x-vantage-agent-credential`), not under a name typed into a tool argument. Names are compared after case and Unicode normalisation; accented and unaccented names stay distinct.
- A message's sender is checked against the verified caller: a caller from another organisation can no longer sign as one of your agents.
- `list_peers` surfaces a backend refusal as an explicit error instead of an empty list.
- A signed-in user with no organisation yet receives a typed refusal instead of the "invalid token" answer. An agent credential that does not resolve is refused as `AGENT_CREDENTIAL_INVALID` (HTTP 401), distinct from a lookup failure.
- Every refresh now returns a new refresh token, so a seat that keeps refreshing no longer expires at 30 days.
- Seat names are canonical and unique across organisations.
- The server no longer passes a privileged secret to the backend as a function argument; the backend authorises it by identity.

## Changes between 2.18.0 and 3.0.0 (some shipped in 2.19.0)

### Added

- `fail_task`: a third terminal task state, `failed`, distinct from `done` and `cancelled`, with a mandatory failure note. `update_task` cannot set `failed` or `blocked`; use `fail_task` and `block_task`.
- `block_task` accepts an optional `blockedCause` (`peer_task`, `human`, `authorisation` or `other`, default `other`) naming what the task is waiting on, and always returns it.

### Fixed

- `list_peers` and `list_mandates` no longer turn a backend refusal into an empty list. A refusal is returned as an error result that starts with `REFUSED (RBAC_DENIED)` and names the tool; a genuinely empty result is still `[]`.
- `check_messages` shows how many in-progress tasks are stuck past the configured threshold, and renders the stuck lists correctly against both older and newer backends.

### Security

- An identity named on a mission (pilot or agent), a mandate (requester or fulfiller) or a task (assignee) can read that record, while still being unable to read records it is not named on.
- Clerk session tokens are checked for the expected audience (`CLERK_JWT_AUDIENCE`, default `convex`), so a token minted for another audience is refused.

## [2.18.0] — 2026-08-11

### Changed

- The server advertises only its core tool set, listed in `tool-exposure.json`. The other tools stay in the code but are disabled: a client can neither list nor call them. The server refuses to start if that file names a tool that does not exist.

## [2.17.0] — 2026-08-11

### Removed

- 14 duplicate alias tools were removed; the canonical tool of each pair remains.

## Changes between 2.12.0 and 2.17.0

### Added

- Knowledge-base ingest: `store_document_chunked` (chunk and index a file previously uploaded to storage; returns `{ docId, chunkCount, storageId }`) and `soft_delete_document`. Both require an organisation-scoped Clerk session.
- Clerk session tokens carrying an organisation claim are verified against Clerk's published keys and scoped to that organisation's `team/<orgId>` namespace for reads and writes. A token for an organisation that is not registered is refused.

### Security

- `list_messages`, `search_messages_by_keyword`, `search_tasks_by_keyword`, `get_profile`, `list_peers`, `get_message`, `list_mandates` and `get_mandate` return only rows the caller owns or is a party to. Previously some of them refused every scoped caller, including the owner.
- Operations tools with no customer owner (error logs, issue tracking, repository mappings) are restricted to the service operator; other callers receive an explicit refusal instead of an empty list.
- Cross-organisation reads and writes in another team's namespace are refused.

## 2.14.2 — 2026-06-30

### Fixed

- OAuth dynamic client registration (`/register`) rejects a missing, empty or malformed `redirect_uris` with `invalid_redirect_uri` (RFC 7591).

## [2.12.0] — 2026-06-14

### Changed

- `check_messages` returns a bounded page of messages. New optional `limit` (1–50, default 20). When more messages are waiting, the reply ends with the `since` value to pass on the next call.

## [2.11.0] — 2026-06-14

### Added

- Keyword (BM25) search over tasks, messages and briefing notes: `search_tasks_by_keyword`, `search_messages_by_keyword`, `search_briefing_notes_by_keyword`. Default 20 results, maximum 200, compact projection available.

## [2.10.0] — 2026-06-14

### Added

- `search_components_by_keyword` and `search_fix_patterns_by_semantic` as the canonical names of `search_components` and `search_fix_patterns`.

### Deprecated

- `search_components` and `search_fix_patterns`, kept as aliases of the canonical names. The removal of `text_search` and `recall` was moved to 2.11.0.

## [2.9.0] — 2026-06-14

### Added

- Episode tools: `get_episode`, `list_episodes`, `search_episodes_by_keyword`, `search_episodes_by_semantic`. Episodes are memories of type `episode`; these tools are shortcuts that apply that type for you. An ID that is not an episode returns "Episode not found".

## [2.8.0] — 2026-06-14

### Added

- `search_memories_by_keyword` (BM25) and `search_memories_by_semantic` (vector) as the canonical memory search tools.

### Deprecated

- `text_search` and `recall`, kept as aliases of the two tools above with identical behaviour.

## [2.7.1] — 2026-06-14

### Fixed

- Tool errors return a structured payload (`code`, `message`, `path`, `hint`) instead of an opaque "Server Error" string, so the real cause (for example a validation error) is visible to the client.

## [2.7.0] — 2026-06-13

### Added

- `get_message` and `get_recurring_task`: fetch a single message or recurring task by ID, scoped to the caller.

## [2.6.0] — 2026-06-13

### Added

- `get_task`, `get_fix_pattern`, `get_mandate` and `get_repo_mapping`: fetch a single record by ID, scoped to the caller.

## [2.5.0] — 2026-06-06

### Added

- `whoami`: returns the identity attached to the current credential, so a client can discover its agent name instead of asking the user.
- `validate_task_payload`: checks a task or message payload against every validation rule at once and returns all failures together.
- Output schemas on tools, and standardised tool descriptions.

### Changed

- Agent names are Unicode-normalised and matched case-insensitively.
- `list_tasks` honours the caller's allowed agent names.

### Security

- Write tools that previously required no authorisation are restricted to the service operator.

## [2.4.13] — 2026-06-02

### Changed

- Documentation and package metadata only; no runtime change.

## [2.4.0] — 2026-05-29

### Added

- Optional UI result markers: with `VP_EMIT_UI_MARKERS=1` (off by default), `list_tasks`, `list_messages`, `get_diary`, `list_missions`, `list_briefing_notes` and `list_memories` append a machine-readable `__VP_TOOL_RESULT__…__END__` block after their normal output, for clients that render rich views. Output is unchanged when the variable is unset.
- Embedded-session registry backing those views.

## UI resources (released with 2.4.0)

### Added

- `ui://vp/v1/<primitive>` MCP resources rendering tasks, messages, diary entries, missions, briefing notes and memories as accessible, bilingual (EN/FR) HTML fragments, with typed payload schemas.

## v2.3.5 — 2026-05-28

### Fixed

- `list_tasks` and `list_tasks_by_mission` forward `createdBy`, and all four list tools forward `updatedSince`; previously these filters were silently dropped. An omitted `limit` now reaches the backend so its automatic page-size cap applies.

## v2.3.4 — 2026-05-28

### Security

- Dynamic client registration can no longer obtain operator scope; self-registered clients receive a tenant scope only.

## v2.3.3 — 2026-05-28

### Added

- `createdBy` and `updatedSince` filters on list queries, and an automatic page-size cap when full records are requested without a limit.

## v2.3.2 — 2026-05-28

### Fixed

- `list_tasks`, `list_tasks_by_mission`, `list_missions` and `list_briefing_notes` accept `fields="lite"`; the task and mission tools accept status arrays and aliases (`open`, `active`, `all`). Aliases are not allowed inside an array.

## 2.3.1 — 2026-05-26

### Fixed

- `status="all"` returns every row; `status=["all"]` is rejected like the other aliases inside an array.

## 2.3.0 — 2026-05-26

### Added

- `fields=lite` on `list_tasks`, `list_missions`, `list_tasks_by_mission` and `list_briefing_notes` for compact payloads.
- Status filters accept arrays and the aliases `open` (non-terminal), `active` and `all`. A single status string and an omitted `fields` behave as before.

## 2.2.0 — 2026-05-07

- New fix-pattern tools: `create_fix_pattern`, `add_fix_attempt`, `validate_fix`, `link_issue_to_pattern`.
- Per-tool documentation with argument tables and examples.

## 2.1.1 — 2026-05-04

- Stricter memory ID validation on `create_briefing_note` and `update_briefing_note`.

## 2.1.0 — 2026-04-25

- `update_briefing_note` with role-based access control.

## 2.0.2 — 2026-04-14

- README badges, `bugs` URL and keywords in `package.json`. Any lowercase agent name is accepted.

## 2.0.1 — 2026-04-14

- Docstring fix.

## 2.0.0

- Typed function references for calling a deployment directly (`vantage-peers-mcp/api`).
- Deploy-key authentication guide.
- `update_mission_template`.

## 1.x

- Initial public release.
