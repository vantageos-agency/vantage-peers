# Changelog

## [Unreleased]

## [8.0.0] — 2026-11-28

A major release: `claim_upload` refuses a master bearer that presents no organisation, which it accepted in 7.2.0, and Self-host requires backend contract 39. This is a major release because a credential stops being accepted by a tool (see the package's [Versioning](README.md#versioning) rules). No tool or argument is removed and no output shape changes. Each entry names the product it concerns.

### Breaking

- Cloud and Self-host: `claim_upload` refuses a master bearer that resolves no organisation with `AUTH_NO_ORG_ID` before the backend call, the same coded refusal the other Knowledge Base tools give; the backend door `kbMutations:claimUpload` refuses a service-account call with no `verifiedOrg` with `RBAC_DENIED`. 7.2.0 served that call as the master and bound the blob to the ticket's organisation. Seats (which carry their organisation), Clerk sessions and a master presenting an organisation are served as before. Upgrade note: a master that claims uploads presents the organisation the upload belongs to (#1828). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Changed

- Self-host: the server requires backend contract version 39 (7.2.0: 38); the called functions are unchanged. A backend below contract 39 is refused at start. Upgrade note: deploy the backend of this release first, then upgrade this package. Cloud clients have nothing to upgrade or configure: the Cloud backend is deployed by the platform (#1826). ([Backend compatibility check](README.md#backend-compatibility-check))
- Cloud and Self-host: `update_briefing_note` forwards the caller's verified organisation to `briefingNotes:update`, which applies it inside the write: the note must belong to that organisation and the acting name must be on its roster. A foreign note was already refused with `RBAC_DENIED` and still is; every other answer is unchanged (#1826). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Fixed

- Cloud and Self-host: a `ui://vp/v1/*` resource read whose door-scope resolution is denied is refused with the typed `RBAC_DENIED` (`door-scope-denied`) before any backend call; it was never reachable with today's callers, but would have sent the call without the caller's claim. The caller's verified claim is set after every other argument, so an argument carried by the URI never replaces it (#1831). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: the after-read scope checks on `list_memories`, `list_episodes`, `get_profile` and `get_fix_pattern` are kept: each still enforces something the door does not (the roster in a team or own namespace, a seat's roster narrower than its organisation's, a creator's label), and each is pinned per caller class; answers unchanged (#1832). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

## [7.2.0] — 2026-11-28

A minor release: Self-host requires backend contract 38, four tools forward the caller's verified organisation to doors that now decide it inside the read, and `get_mission_template`, the `ui://` resources, `list_blocked_on_me` and `get_tool_usage` carry the caller's verified claim where it was missing. This is a minor release because no tool or argument is removed, no success becomes an error and no working credential is refused (see the package's [Versioning](README.md#versioning) rules). Each entry names the product it concerns.

### Changed

- Self-host: the server requires backend contract version 38 (7.1.0: 36); the 155 called functions are unchanged. A backend below contract 38 is refused at start. Upgrade note: deploy the backend of this release first, then upgrade this package. Cloud clients have nothing to upgrade or configure: the Cloud backend is deployed by the platform (#1821, #1822). ([Backend compatibility check](README.md#backend-compatibility-check))
- Cloud and Self-host: `list_memories`, `list_episodes`, `get_profile` and `get_fix_pattern` forward the caller's verified organisation to `memories:listMemories`, `profiles:getProfile` and `fixPatterns:get`, which apply it inside the read. Every caller's answer is unchanged, with one wording difference: `get_fix_pattern` on a pattern created outside the caller's roster was already refused with `RBAC_DENIED` after the read and is now refused by the door with `RBAC_DENIED` (`not-in-creator-roster`), so the refusal text is the door's message (#1821). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `get_mission_template` forwards the caller's roster to `missionTemplates:getByName` for a caller with no verified organisation, and the door applies it inside the read; every caller's answer is unchanged (#1822). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Fixed

- Cloud and Self-host: the `ui://vp/v1/*` resources call the backend through the same wrapped client as the tools, so `ui://vp/v1/memory-quote` carries the caller's verified agent ID to `memories:listMemories` as a tool call does; the seven other doors the resources read receive no agent ID, as before. `list_blocked_on_me` states the claim at its call; its answers are unchanged (#1820). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `get_tool_usage` with no argument from a master seat that holds a verified agent ID reads that agent's own usage; it answered `caller-unidentified` before. A master naming a `caller` or an `orgSlug`, a master with no agent ID, `get_owner_tool_usage`, client seats and Clerk sessions send what they sent before (#1824). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

## [7.1.0] — 2026-11-27

A minor release: every registered tool now declares an `outputSchema` and returns `structuredContent`; Self-host requires backend contract 36. This is a minor release because the changes add fields and keep every text, success and error as it was (see the package's [Versioning](README.md#versioning) rules). Each entry names the product it concerns.

### Added

- Cloud and Self-host: 26 more tools declare an `outputSchema` and answer a `structuredContent` that is the same object as their JSON text: the seven mandate tools (#1810), the five business-unit tools (#1812), the six issue tools (#1814), and `validate_okf_bundle`, `soft_delete_mission_template`, `add_deployment`, `remove_deployment`, `list_errors`, `get_error`, `validate_task_payload` and `get_repo_mapping` (#1816). The text of a success is unchanged; an error or a refusal still carries `isError` and no `structuredContent`. `get_bu`, `get_issue` and `get_error` stay a success when nothing matches, with `{ bu: null }`, `{ issue: null }` and `{ error: null }` as `structuredContent`; `get_repo_mapping` of a mapping that does not exist is still an error. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Changed

- Self-host: the server requires backend contract version 36 (7.0.0: 34); the 155 called functions are unchanged. A backend below contract 36 is refused at start. Upgrade note: deploy the backend of this release first, then upgrade this package. Cloud clients have nothing to upgrade or configure: the Cloud backend is deployed by the platform (#1813, #1818). ([Backend compatibility check](README.md#backend-compatibility-check))
- Cloud and Self-host: the MCP declares the four task, mission and recurring-task doors that apply the caller's verified organisation inside the read (`tasks:getById`, `tasks:getBulkCompleteRun`, `missions:get`, `recurringTasks:getById`) and forwards that organisation at every call site. The backend change is an expand step: a read without the claim is still served (#1813). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `get_mission_template` forwards the caller's verified organisation to `missionTemplates:getByName`, which applies it inside the read with the same rule as the after-read filter; that filter stays, so every caller's answer is unchanged (#1818). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `get_issue` and `issue_stats` read fleet-master-only backend doors. The caller's scope is checked before the read: a caller that is not the fleet master gets the answer it got before and the door is not called; the fleet master is unchanged (#1815). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `list_mandates`, `list_bus`, `list_issues` and `list_errors` measure the 60 KB page cap on the text and the structured content together, so a page over the cap is cut slightly earlier. A page of `list_errors` cut by the cap carries the cursor that continues after the last row shown, so the withheld rows are reachable (#1810, #1812, #1814, #1816). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: a tool registration without an `outputSchema` fails at registration, naming the tool. Every registered tool declares one, so no served tool changes (#1816). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

## [7.0.0] — 2026-11-27

A major release: the five Knowledge Base tools and the Clerk-JWT layer refuse what 6.0.0 accepted. This is a major release because a credential stops being accepted (see the package's [Versioning](README.md#versioning) rules). Each entry names the product it concerns.

### Breaking

- Cloud and Self-host: the five Knowledge Base tools (`store_document_chunked`, `soft_delete_document`, `claim_upload`, and `generate_upload_url` with and without `sha256`) refuse a bearer that is neither the master nor a Clerk session and has no verified organisation. The refusal is `RBAC_DENIED` with reason `verified-org-unresolved`, and no backend call is made (#1804). Master and Clerk-session callers are unchanged. Caller change: call the Knowledge Base tools with a bearer that carries a verified organisation. Cloud is unaffected: production has 0 bearers without an org slug (counted by sigma). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Self-host: `CLERK_DOMAIN` is now required by the Clerk-JWT layer, `whoami` and the org-admin token too, not only the service-account mint. An unset, empty or whitespace-only value is refused instead of defaulting to a dev Clerk instance (#1802). Upgrade note: set CLERK_DOMAIN before upgrading, or every Clerk JWT is refused. Cloud is unaffected: `CLERK_DOMAIN` is set on Railway. ([Self-host](README.md#self-host-a-separate-product); variable table in `docs/self-host/railway-template.md`)

### Changed

- Cloud and Self-host: the tools forward the caller's verified agent ID to the backend doors that take it, and refuse with a typed `RBAC_DENIED` before the door a caller with none where the door admits none (`accept_mandate`, `update_mandate`, `settle_mandate`; `debate_get_room` and `improvisation_digest` for a caller that is not a Clerk session). One shared producer builds every identity refusal (#1803). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `get_memory` forwards the caller's verified organisation to the backend door (#1804). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: the README and `docs/` state the 6.0.0 behaviours of `create_recurring_task`, `CLERK_DOMAIN` and `list_repo_mappings` (#1808). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Fixed

- Cloud and Self-host: `list_bus` forwards the `{time,id}` `nextCursor` it emits, so its page 2 is reachable. `list_bus` and `list_repo_mappings` refuse a cursor of an unknown shape instead of silently restarting at page 1 (#1807). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

## [6.0.0] — 2026-11-27

A major release: `create_recurring_task` requires `project`. This is a major release because a tool input changed (see the package's [Versioning](README.md#versioning) rules). Each entry names the product it concerns.

### Breaking

- Cloud and Self-host: `create_recurring_task` requires a `project`. A call with no `project`, an empty one or a blank one is refused before any recurring task is written. This change (#1800) was already deployed on Cloud inside 5.2.1 and never appeared in a changelog; 6.0.0 is the first published version that carries it (npm `latest` was 5.1.0, 5.2.0 and 5.2.1 were never published). Caller change: pass a project name on every `create_recurring_task`. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Self-host: `CLERK_DOMAIN` must be set. An unset, empty or whitespace-only value is refused, before any Clerk or network call, instead of defaulting to a dev Clerk instance (#1795). It must be the Frontend API origin of the Clerk instance that issued `CLERK_SECRET_KEY`. Caller change: set `CLERK_DOMAIN` on the service before upgrading. ([Self-host](README.md#self-host-a-separate-product); variable table in `docs/self-host/railway-template.md`)

### Fixed

- Cloud and Self-host: `list_repo_mappings` page 2 is reachable. The tool now forwards the `{time,id}` `nextCursor` it emits instead of refusing it (#1805). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: the HTTP server logs the port at startup, never the bound hostname (#1797). ([Self-host](README.md#self-host-a-separate-product))

### Changed

- Cloud: reading a `ui://` resource forwards the caller's verified organisation to every backend door that takes one, and refuses a bearer that has no verified organisation (#1801). No production bearer was affected (0 counted by sigma). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

## [5.2.1] — 2026-11-27

A patch release: `list_diaries` accepts a member's own verified identities. No tool is added or removed and no tool input or output shape changes. Each entry names the product it concerns.

### Fixed

- Cloud and Self-host: a member agent can list its own diary with `list_diaries`. The tool compared a non-master caller's filters with its Clerk user id, while an agent's entries are recorded under its agent name, so a member agent was always refused. A non-master caller's own identities are now read from its verified context only: its agent name (as `whoami` reports `agent_name`), `user:<subject>`, and the bare subject kept for compatibility. With no filter, the tool lists the caller's own entries instead of refusing; a filter naming another member is still refused. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

## [5.2.0] — 2026-11-27

A minor release: `check_repo_routing` gains one output bucket and `list_repo_mappings` serves out-of-scope rows. No tool is added or removed and no tool input changes. Each entry names the product it concerns.

### Fixed

- Cloud and Self-host: `list_repo_mappings` serves out-of-scope rows again. An out-of-scope row carries no `orchestrator`, but the output schema still required one, so every page holding such a row failed output validation (lite and full). `orchestrator` is now optional (absent on an out-of-scope row), and the schema describes `outOfScope`, `orchestratorAgentId`, `reviewerAgentId` and `fallbackReviewerAgentId`. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Added

- Cloud and Self-host: `check_repo_routing` run for the operator organisation counts, in a new `routedElsewhere` number, the repos of your list that have a row in another organisation (a client's repos are routed in the client's organisation). They are not `missing` and do not block `complete`. It never names that organisation, its owner or its content, and `get_repo_route` still answers `absent` for another organisation's row. A client organisation's own check is unchanged. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Changed

- Self-host: the server requires backend contract version 34 (5.1.0: 33) and calls 155 backend functions (5.1.0: 154, + `githubRepoMapping:routedElsewhere`). A backend of contract 33 is refused at start. Deploy the backend of this release first, then upgrade this package. VantagePeers Cloud already serves contract 34. ([Backend compatibility check](README.md#backend-compatibility-check))

## [5.1.0] — 2026-11-25

A minor release: two new read tools. No existing tool input or output changes. Each entry names the product it concerns.

### Added

- Cloud and Self-host: `get_repo_route` reads who owns and who reviews one GitHub repository in your organisation: `routed` (owner and reviewer), `unreviewed` (owner, no reviewer) or `absent` (no row), always a typed state, never an empty reply. Another organisation's row answers `absent`. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `check_repo_routing` takes your organisation's real repository list and returns which repos are `routed`, `unreviewed`, `missing` (no row) and `stale` (a row for a repo not in your list), with `complete` true only when the last three are empty. It reads every page of your routing table. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Changed

- Self-host: the server calls one more backend function, `githubRepoMapping:getRoute` (154 called functions, 5.0.3: 153); the required backend contract stays 30. A backend that lacks `getRoute` is refused at start, naming it. Deploy the backend of this release first, then upgrade this package. ([Backend compatibility check](README.md#backend-compatibility-check))

## [5.0.3] — 2026-11-25

A patch release. Tool inputs and outputs are unchanged. Each entry names the product it concerns.

### Fixed

- Cloud and Self-host: `get_tool_usage` and `get_owner_tool_usage` serve a master-scope caller that has a verified agent ID. Such a caller got `RBAC_DENIED` (`claimless-service-account`) because it resolves no organisation; it now sends its agent as the claim, never beside an organisation claim. Organisation seats, person sessions and a master with no agent ID are unchanged. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Changed

- Self-host: the server requires backend contract version 30 (5.0.2: 29); the 153 called functions are unchanged. A backend of contract 29 is refused at start. Deploy the backend of this release first, then upgrade this package. ([Backend compatibility check](README.md#backend-compatibility-check))

## [5.0.2] — 2026-11-24

A patch release. Tool inputs and outputs are unchanged. Each entry names the product it concerns.

### Fixed

- Cloud and Self-host: `next_task` works for a master-scope caller. Such a caller got `RBAC_DENIED` (`claimless-service-account`) because it resolves no organisation and sent no claim. A master caller with a verified agent ID now sends that agent (`verifiedActor`), and the backend judges it as an agent of the operator organisation. An organisation seat still sends its organisation only and is still refused for another organisation's assignee. A Clerk session sends no claim. A master caller with no agent ID is still refused. `get_tool_usage` and `get_owner_tool_usage` are unchanged here: their backend doors do not yet accept an agent claim. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Self-host: no backend change. The required backend contract stays 29 with 153 called functions. ([Backend compatibility check](README.md#backend-compatibility-check))

## [5.0.1] — 2026-11-24

A patch release. Tool inputs are unchanged, and so are the outputs for a backend that answers its contract. Each entry names the product it concerns.

### Fixed

- Cloud and Self-host: `reorder_queue` now names only the callers MCP admits: the assignee agent and a queue coordinator its organisation lists. A person bearer is refused; a person sets a queue from a signed-in session. The 5.0.0 description also named an organisation admin, which MCP never admitted. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: a backend reply that breaks its contract (null, a shapeless object, or an envelope without its array) now fails with `BACKEND_SHAPE_MISMATCH`, naming the tool and the backend door, and the outcome is reported as unknown. Before, it was read as an empty list or a default. This covers `reorder_queue` and `next_task`, `list_tasks` (every sort), and 23 other list and read tools: `list_peers`, `list_messages`, `search_messages_by_keyword`, `search_tasks_by_keyword`, `list_tasks_by_mission`, `list_missions`, `list_briefing_notes`, `search_briefing_notes_by_keyword`, `list_recurring_tasks`, `list_mandates`, `list_issues`, `search_fix_patterns`, `list_fix_patterns`, `list_errors`, `get_tool_usage`, `get_owner_tool_usage`, `list_blocked_on_me`, `list_episodes`, `list_memories`, `list_diaries`, `list_bus`, `list_repo_mappings` and `get_github_owner_bindings`. A well-formed empty reply still returns an empty list, and a backend refusal is still reported as a refusal. `check_messages` keeps its documented tolerance of an older backend. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Self-host: no backend change. The required backend contract stays 29 with 153 called functions, so a 5.0.0 backend serves 5.0.1 as is. ([Backend compatibility check](README.md#backend-compatibility-check))

## [5.0.0] — 2026-11-24

Customer-facing summary of every `mcp-server/` change since 4.1.0. Each entry says which product it concerns (VantagePeers Cloud, the hosted service; VantagePeers Self-host, the separate product) and links the README section that documents it. This is a major release because tool inputs and output shapes changed (see the package's [Versioning](README.md#versioning) rules).

### Breaking

- Cloud and Self-host: `create_task` requires a `project`. A call with no `project`, an empty one or a blank one is refused before any task is written, and `update_task` refuses setting `project` to empty. Caller change: pass a project name on every `create_task`. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: the text of `get_owner_tool_usage`, `list_diaries` and `get_profile` is now exactly the JSON of their `structuredContent`. `get_owner_tool_usage` answers `{ items, truncated? }` instead of a bare array; `list_diaries` answers `{ items, nextCursor, truncated }` on every page instead of a bare array or a page without those fields, and a cut is `truncated: true` (the `_meta` text envelope is gone); `get_profile` answers `{ found: true, item }`, or `{ found: false, id }` instead of `null` when no profile is visible. Caller change: read the `items` array, or `item` / `found`, from `structuredContent` (or from the parsed text), not the former array or `null`. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `tools/list`, `resources/list` and `resources/templates/list` refuse any `cursor` with JSON-RPC error -32602 (these methods are served whole and never issue one); they used to ignore it and return the full list. Caller change: do not send a cursor on these three methods. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `list_tasks` with `updatedSince` returns the rows newest-updated first (it was newest-created first) and its `nextCursor` resumes at that position. Caller change: a client that depended on creation order must sort the rows itself; a cursor minted by an earlier version still decodes. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud: `get_fix_pattern` answers `RBAC_DENIED` instead of "not found" to a caller outside the pattern's creator roster. Caller change: treat a refusal as "not allowed", not "does not exist". ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Self-host: the server requires backend contract version 29 and 153 backend functions (4.1.0: 17 and 144) and refuses to start against an older backend. Caller change: deploy the backend of this release first, then upgrade this package. ([Backend compatibility check](README.md#backend-compatibility-check))

### Added

- Cloud and Self-host: explicit task queue order. New tool `reorder_queue` sets one agent's queue in a single call (listed tasks get ranks 1 to N, the agent's other open tasks lose their rank, an empty list clears the queue); it is open to the assignee, an organisation admin or a listed queue coordinator. New tool `next_task` returns the next task the agent can take (rank, then priority, then age, dependencies done) or an explicit `found: false`. `list_tasks` accepts `sort: "queue"`; a call without `sort` is unchanged. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud: new tools `erase_row` and `erase_fix_pattern`, and `erase_memory` now works for an agent seat. An organisation admin erases any row of the organisation; an author erases the rows it wrote (a person by verified identity, an agent by its agent ID). The row, and the rows that exist only for it, are deleted and a memory's search entry is purged. Erasing a memory erases every version of it. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud: a client can identify itself with a URL as its `client_id` (Client ID Metadata Documents, as Claude.ai's connector does). The server fetches the document under strict network limits (HTTPS only, public addresses only, no redirect, 5 KB, 3 seconds), shows the redirect origin on the consent page and flags the client as unverified. The service operator can unlist a client by URL, host or domain. ([OAuth endpoints](README.md#oauth-endpoints))
- Cloud and Self-host: `billing_summary_by_project` splits `unattributedTaskCount` into `noProjectCount` and `noDurationCount`, and the new optional `listNoDuration` returns the tasks that have a project but no measured duration. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud: `whoami` also names the agent and the workspace on every seat (`agent_name`, `agent_status`, `writableNamespaces`, `default_write_namespace`). `store_memory` and `store_episode` take an optional `namespace`: omitted, a person writes in `team/<organisation>` and a seat in its own `orchestrator/<agent ID>`. ([Agent identity](README.md#agent-identity))
- Cloud and Self-host: every tool now declares an `outputSchema` and returns `structuredContent` beside its unchanged text, every field of every output schema is described, every tool carries an `idempotentHint`, and every tool description states the result it returns. `check_messages` and `debate_get_room` keep their whole answer under the 60 000-byte response cap. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud: the public MCP Server Card now lists the server's `capabilities` and `tools`, and the `initialize` answer carries `serverInfo.commitSha`, the same build identity `/health` reports (`"unknown"` when no build stamped one). ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Changed

- Cloud and Self-host: an invalid `cursor` argument on a paged tool answers `isError: true` with `structuredContent { error: { code: "invalid_cursor", message } }`. `tools/list`, `resources/list` and `resources/templates/list` refuse a cursor with JSON-RPC error -32602 instead of silently returning the full list. `get_github_owner_bindings` now hands out opaque cursors. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `list_tasks` with `updatedSince` pages a window of any size and returns the rows newest-updated first; `updatedSince`, `createdBy` and a `createdBefore` cursor no longer fail with a scan-cap refusal. Combinations the indexes cannot serve are refused with the remedy named, never answered with a partial page. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud: a memory or episode read without `namespace` (`recall`, `text_search`, `hybrid_search`, `list_episodes`, `search_episodes_by_keyword`, `search_episodes_by_semantic`) reads your own space instead of being refused; `list_memories` and `export_okf_bundle` still require one. `list_episodes` without a namespace answers for the fleet master only. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud: the OAuth consent page offers the operator's own organisation, lists the agent already bound to the person and pre-selects it, refuses an Approve that silently connects a person as themselves while an agent is bound to them, and an agent created there joins its organisation's roster. An agent-less person connection that now has an agent to choose is asked to sign in again (`invalid_grant`, `agent-choice-pending`). ([The consent page](README.md#the-consent-page))
- Cloud: a refused agent credential answers `AGENT_CREDENTIAL_INVALID (<reason>)` when the backend names a reason code, for example `owner-missing`. ([Agent identity](README.md#agent-identity))
- Cloud and Self-host: the server's public description is "MCP server for multi-agent teams: persistent memory, agent messaging, time-tracked tasks, missions", the same text on `initialize`, the Server Card, the `/mcp` landing page and the package. The `fields` input is no longer published on seven list tools (`list_episodes`, `list_memories`, `list_peers`, `list_messages`, `list_diaries`, `list_recurring_tasks`, `list_fix_patterns`); a call that still sends it is accepted and the key is ignored. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: input descriptions say only what a field means and where its value comes from; the schema carries bounds, enums and defaults. The `createdBy` fields of `list_tasks_by_mission` and `list_diaries` and the `unprovenCursor` of `get_github_owner_bindings` name their source. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Security and fixes

- Cloud: `recall`, `text_search` and `hybrid_search` no longer return a superseded, soft-deleted or tombstoned memory or Knowledge Base chunk; an organisation member no longer reads a retired row through `get_memory` or `list_memories`. A client seat now finds through those three tools the memory it wrote in its own `orchestrator/<agent ID>` and `project/<organisation>` namespaces. ([Security](README.md#security))
- Cloud: a client-organisation agent whose name has capital letters (for example "Ada") can read and act on its own tasks, messages, briefing notes and profile; the roster is compared by normalised name on every door, and only narrows inside the organisation. A person seat can write a memory, episode or briefing note in its own name. `list_peers` lists a client organisation's agents to its own seats instead of refusing. ([Agent identity](README.md#agent-identity))
- Cloud and Self-host: `list_messages` with `from` and `sessionDay` applies both, newest first, and no longer fails on a busy sender or a large page; a page cut by the response cap keeps the cursor that resumes after its last row. `list_diaries` by `createdBy` and `list_recurring_tasks` by `assignedTo` and `active` return a full page. `list_issues` refuses `assignedTo` together with `project`, and filters `status` before the page is cut. `list_memories` and `list_episodes` return a cursor on a full first page. A fleet-master `list_diaries` by `createdBy` reads at most 250 rows per call and answers a partial page with a resuming cursor. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `improvisation_digest` no longer fails on an orchestrator whose name has a non-ASCII letter (for example "hélios"). `get_fix_pattern` reads what `list_fix_patterns` lists and answers `RBAC_DENIED` instead of "not found" to a caller outside the creator roster. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

## [4.1.0] — 2026-11-03

Customer-facing summary of every `mcp-server/` change since 4.0.0. Each entry says which product it concerns (VantagePeers Cloud, the hosted service; VantagePeers Self-host, the separate product) and links the README section that documents it.

### Action required

- Self-host: the server requires backend contract version 17 and 144 backend functions (4.0.0: 10 and 141) and refuses to start against an older backend. Deploy the backend of this release first, then upgrade this package. ([Backend compatibility check](README.md#backend-compatibility-check))

### Added

- Cloud and Self-host: new tools `get_tool_usage` and `get_owner_tool_usage`: which MCP tools a caller, or all the agents a person owns, has called, with first call, last call and call count. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: `list_tasks`, `list_messages`, `list_missions`, `list_memories`, `get_diary` and `get_briefing_note` name an interactive MCP Apps view; a client without MCP Apps support shows the unchanged text result. ([MCP Apps](README.md#mcp-apps-interactive-views))
- Cloud: a native client's loopback `redirect_uri` (`http://127.0.0.1`, `http://localhost`, `http://[::1]`) may vary its port, so VS Code can connect (RFC 8252 section 7.3). ([Security](README.md#security))

### Changed

- Cloud: `pause_recurring_task`, `resume_recurring_task` and `delete_recurring_task` are no longer refused to every non-operator caller; an agent manages the schedules it created. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))
- Cloud and Self-host: a refused `send_message` carries `RBAC_DENIED` or `INVALID_RECIPIENTS`, a missing message `MESSAGE_NOT_FOUND`, and a refused `store_memory` / `store_episode` write names the namespaces the caller may write. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

### Security and fixes

- Cloud: every call an OAuth bearer makes runs inside its own verified organisation, keyed by the permanent organisation ID, so a bearer no longer reads another organisation's diaries, mandate bindings, tasks or UI resources (cross-tenant leak, #1639). ([Security](README.md#security))
- Cloud: a seat reads and writes its own `orchestrator/<agent ID>` and `project/<org>` on every path into the server, whatever its token was minted with; a token's rights follow its scope profile as it is now; a one-agent seat resolves its agent by ID only. ([Agent identity](README.md#agent-identity))
- Cloud and Self-host: `add_task_dependency` and `block_task` append to a task's dependencies instead of replacing them, and `link_commit_to_issue` no longer records a SHA twice. ([Tool inputs and outputs](README.md#tool-inputs-and-outputs))

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
