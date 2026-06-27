# vantage-peers-mcp

[![npm version](https://img.shields.io/npm/v/vantage-peers-mcp)](https://www.npmjs.com/package/vantage-peers-mcp)
[![npm downloads](https://img.shields.io/npm/dm/vantage-peers-mcp)](https://www.npmjs.com/package/vantage-peers-mcp)
[![License: FSL-1.1-Apache-2.0](https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue)](https://github.com/vantageos-agency/vantage-peers/blob/main/LICENSE)
[![Tests: 97/97](https://img.shields.io/badge/MCP_tools-97_registered-green)]()

MCP server for [VantagePeers](https://vantagepeers.com) — shared memory, messaging, and task coordination for AI agent teams.

97 tools across 18 categories: memory, profiles, tasks, missions, mission templates, messages, diary, briefing notes, search (RAG), issues, fix patterns, error monitoring, deployments, business units, components, mandates, recurring tasks, and session. All tools ship with ChatGPT Apps SDK annotations (`readOnlyHint`, `openWorldHint`, `destructiveHint`) for native UX in ChatGPT custom connectors.

## Quick start

```bash
npx vantage-peers-mcp
```

Requires `CONVEX_URL` pointing to your VantagePeers Convex deployment.

## What's new in v2.5.0

Day 92 VP MCP quality overhaul (mission `k57a36y8w5t085bqr23dsmvb2d882506`, PR #678):

- **C0 — 14 P0 zero-auth write tools secured** with master-only gates (`guardMasterOnly` / `checkFromAllowed`); all 14 tools identified in the A1 audit matrix (commit `d03d2d7`) now require an explicit scope gate before any mutation reaches Convex.
- **C1 — 87 Zod `outputSchema` exports** following the per-family envelope standard (`create_*` → `{id,...}`, `list_*` → `{items,cursor}`, `delete_*` → `{id,deleted:true}`, etc.) based on the `whoamiOutputSchema` precedent (commit `5231811`).
- **C2 — Unicode NFC normalization + case-insensitive orchestrator-ID matching** applied at all write paths and filter comparisons; closes the NFD/NFC silent mismatch class discovered in the Hélios/helios production regression.
- **C3 — 97 tool descriptions standardized** (1-line summary + WHEN clause + concrete EXAMPLE, 80–500 chars) + 10 canonical aliases aligned to the `verb_noun_snake` whitelist.
- **PR-J (Day 113) — canonical 114-tool snapshot quality gate** (`mcp-server/src/__tests__/tools-descriptions-canonical.test.ts`): inventory floor ≥100, length floor ≥60 chars, placeholder ban, category contracts (every `list_*` mentions `limit` + `cap`/`default 20`/`default 100`; every recall-class tool carries the PR-H VP-Sources doctrine verbatim). 15 `list_*` descriptions amended in T-GREEN `41944dc` to add the paging qualifier `Default limit N. cap M.` aligned with PR-A/B/C/E precedent.
- **C4 — `claude-peers` legacy references removed** from source and docs + grep-gate CI check to prevent reintroduction.
- **A3 — `whoami` LECTURE tool** (PR #661, commit `5231811`) — returns `suggested_orchestrator_id`, `scope_profile`, and `namespace_read_prefixes` so skills auto-resolve identity without prompting the user.
- **F1 — `validate_task_payload` validator tool** (commit `cf6c961`) — client-side payload validation before any write reaches Convex.

See `mcp-server/CHANGELOG.md` for the full per-PR list.

## Install

### Option 1: npx (no install)

```bash
CONVEX_URL=https://your-deployment.convex.cloud npx vantage-peers-mcp
```

### Option 2: global install

```bash
npm install -g vantage-peers-mcp
CONVEX_URL=https://your-deployment.convex.cloud vantage-peers-mcp
```

### Option 3: Claude Code MCP config

Add to `~/.claude.json` or project `.claude/settings.json`:

```json
{
  "mcpServers": {
    "vantage-peers": {
      "command": "npx",
      "args": ["-y", "vantage-peers-mcp"],
      "env": {
        "CONVEX_URL": "https://your-deployment.convex.cloud"
      }
    }
  }
}
```

## OAuth 2.1 DCR endpoints

VantagePeers ships a built-in OAuth 2.1 authorization server so Claude.ai web can connect via "Add custom integration" without any extra configuration.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/.well-known/oauth-authorization-server` | Authorization Server Metadata (RFC 8414) — advertises supported grant types, endpoints, and capabilities |
| `GET` | `/.well-known/oauth-protected-resource` | Protected Resource Metadata (RFC 9728) — links back to the authorization server |
| `POST` | `/register` | Dynamic Client Registration (RFC 7591) — Claude.ai registers itself automatically on first connect |
| `GET` | `/authorize` | Authorization endpoint — redirects the user to grant access |
| `POST` | `/token` | Token endpoint — issues access tokens per OAuth 2.1 |

**RFCs implemented:** RFC 8414 (AS Metadata), RFC 9728 (Protected Resource Metadata), RFC 7591 (Dynamic Client Registration), OAuth 2.1 draft.

**Backward compatibility:** the `BEARER_SECRET_MASTER` env var still works unchanged. Claude Code and Claude Desktop users do not need to change anything — static bearer auth remains the default for those clients. OAuth 2.1 DCR is used exclusively when a client initiates the discovery flow (e.g. Claude.ai web).

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CONVEX_URL` | Yes | Your VantagePeers Convex deployment URL |

The server also reads `CONVEX_URL` from `.env.local` in the parent directory if not set via environment.

## Tools (97)

### Memory (7)
`store_memory`, `search_memories_by_semantic` (alias `recall`), `list_memories`, `soft_delete_memory`, `get_memory`, `store_episode`

### Profiles (3)
`get_profile`, `update_profile`, `list_peers`

### Tasks (11)
`create_task`, `list_tasks`, `list_tasks_by_mission`, `update_task`, `start_task`, `complete_task`, `checkout_task`, `delete_task`, `block_task`, `add_task_dependency`, `bulk_complete_tasks`

#### `list_tasks` — args schema + `excludeAutoGenerated` filter (PR-E)

```
list_tasks(assignedTo?, status?, missionId?, createdBy?, updatedSince?, createdBefore?, limit?, cursor?, fields?, excludeAutoGenerated?)
```

| Arg | Type | Default | Notes |
|-----|------|---------|-------|
| `assignedTo` | string | — | Filter by assignee (e.g. `"pi"`). |
| `status` | string \| string[] \| alias | — | Single status, array, or alias (`"open"`, `"active"`, `"all"`). |
| `missionId` | string | — | Filter to tasks in a specific mission. |
| `createdBy` | string | — | Filter by creator (e.g. `"sigma"`). |
| `updatedSince` | number | — | Epoch ms. Returns tasks with `updatedAt >= this`. |
| `createdBefore` | number | — | Epoch ms. Pagination anchor (legacy; prefer `cursor`). |
| `limit` | number 1–200 | `50` | Page size. |
| `cursor` | string | — | Opaque token from prior `nextCursor`. |
| `fields` | `"lite"\|"full"` | `"full"` | `"lite"` returns `{_id, _creationTime, title, status, priority, assignedTo, missionId}`. |
| `excludeAutoGenerated` | boolean | `false` | When `true`, filters tasks where `createdBy ~ /^cron-/i` OR `title ~ /^\/?check-messages$/i`. Default `false` — backward-compatible. |

**`excludeAutoGenerated` cron contract:**
- `createdBy` matches `/^cron-/i` (dash mandatory): `cron-bot` is filtered, `cronus` is **not** filtered.
- `title` matches `/^\/?check-messages$/i` (whole-string, optional leading slash, case-insensitive).
- Filter applied in-memory after existing query filters, before envelope assembly.
- **Post-filter pages may be smaller than `limit`** — filtered rows do not count toward limit. Acceptable for cron-spam catalog (small, narrowly targeted).

Example — Pi queue cleaned of cron-spam:
```json
{
  "tool": "list_tasks",
  "arguments": { "assignedTo": "pi", "status": "open", "excludeAutoGenerated": true, "limit": 50 }
}
```

Returns `{ items: Task[], nextCursor: string | null }`. `nextCursor` is `null` on the last page.

#### `bulk_complete_tasks` — args schema + dry-run-default safety (PR-F)

```
bulk_complete_tasks(filter, dryRun?, completionNoteTemplate?, callerOrchestrator?)
```

| Arg | Type | Default | Notes |
|-----|------|---------|-------|
| `filter` | object | (required) | Filter object. Currently: `{ autoGeneratedOnly?: boolean }`. |
| `filter.autoGeneratedOnly` | boolean | `false` | When `true`, matches tasks where `createdBy ~ /^cron-/i` OR `title ~ /^\/?check-messages$/i`. |
| `dryRun` | boolean | `true` | **Safety default.** When `true`, returns a preview `{count, sampleIds, bulkRunId}` without mutating. Pass `false` explicitly to commit. |
| `completionNoteTemplate` | string | (see below) | Template string for the `completionNote` written to each closed task. Supports `{{day}}`, `{{bulkRunId}}`, `{{executedAt}}` interpolation. Default: `"bulk-cleanup: cron-spam day {{day}} runId={{bulkRunId}} executedAt={{executedAt}}"`. |
| `callerOrchestrator` | string | — | Caller identity for RBAC. When provided and not `"system"`, every matched task must have `createdBy` or `assignedTo` equal to the caller — otherwise throws `RBAC_DENIED`. |

**`dryRun` safety note:** `bulk_complete_tasks` always defaults `dryRun` to `true`. Calling the tool without `dryRun=false` never mutates the database. This mirrors the two-step pattern required for all destructive bulk operations: preview first, then commit.

**`excludeAutoGenerated` cron contract** (same as `list_tasks`):
- `createdBy` matches `/^cron-/i` (dash mandatory): `cron-bot` is filtered, `cronus` is **not** filtered.
- `title` matches `/^\/?check-messages$/i` (whole-string, optional leading slash, case-insensitive).
- Filter applied in-memory against all non-done tasks.
- **Post-filter count may be smaller than expected** — same trade-off as `list_tasks excludeAutoGenerated`.

Examples:

```json
// Step 1 — dry-run preview (default dryRun=true)
{
  "tool": "bulk_complete_tasks",
  "arguments": { "filter": { "autoGeneratedOnly": true }, "callerOrchestrator": "system" }
}
// → { "count": 152, "sampleIds": ["k17...", "k18..."], "bulkRunId": "bulk-1782050000000-a3f2" }

// Step 2 — commit (explicit dryRun=false)
{
  "tool": "bulk_complete_tasks",
  "arguments": { "filter": { "autoGeneratedOnly": true }, "dryRun": false, "callerOrchestrator": "system" }
}
// → { "count": 152, "sampleIds": ["k17...", "k18..."], "bulkRunId": "bulk-1782050000000-a3f2", "executedAt": 1782050000000 }
```

Returns `{ count, sampleIds, bulkRunId, executedAt? }`:
- `dryRun=true` — `{ count, sampleIds, bulkRunId }` (no `executedAt`).
- `dryRun=false` — `{ count, sampleIds, bulkRunId, executedAt }` — `bulkRunId` is the Day-76 evidence token; `executedAt` is the mutation epoch ms.

### Missions (6)
`create_mission`, `list_missions`, `update_mission`, `update_mission_status`, `get_mission_template`, `get_mission`

### Mission Templates (1)
`update_mission_template`

### Messages (6)
`send_message`, `check_messages`, `mark_as_read`, `list_messages`, `delete_message`, `list_broadcast_status`

### Diary (3)
`write_diary`, `get_diary`, `list_diaries`

### Briefing Notes (2)
`create_briefing_note`, `list_briefing_notes`

#### `list_briefing_notes` — VP-Sources doctrine (PR-H)

Exports `LIST_BRIEFING_NOTES_TOOL_DESCRIPTION` from `mcp-server/src/tools.ts`.

Same two advisory VP-Sources doctrine paragraphs appended after the existing description (identical strings, see `recall` in Search / RAG above).

#### `search_briefing_notes_by_keyword` — VP-Sources doctrine (PR-H)

Exports `SEARCH_BRIEFING_NOTES_BY_KEYWORD_TOOL_DESCRIPTION` from `mcp-server/src/tools.ts`.

Same two advisory VP-Sources doctrine paragraphs appended after the existing description (identical strings, see `recall` in Search / RAG above).

### Search / RAG (3)
`search_fix_patterns_by_semantic` (alias `search_fix_patterns`), `search_memories_by_keyword` (alias `text_search`), `hybrid_search`

#### `recall` — VP-Sources doctrine (PR-H)

Alias of `search_memories_by_semantic`. Exports `RECALL_TOOL_DESCRIPTION` from `mcp-server/src/tools.ts`.

The description now embeds two advisory VP-Sources doctrine paragraphs appended after the existing text:

> VP-Sources doctrine: MUST be called before any factual claim about fleet state, audits, dette tooling, mission/task/client status, incident history, doctrine references.
>
> Cite returned ids in the answer footer as 'VP-Sources: recall("\<q\>")→[ids] | none-needed:\<reason\>'.

Doctrine is advisory-only — no hook blocks on absence. Client LLMs read the doctrine at tool-list time.

#### `text_search` — VP-Sources doctrine (PR-H)

Alias of `search_memories_by_keyword`. Exports `TEXT_SEARCH_TOOL_DESCRIPTION` from `mcp-server/src/tools.ts`.

Same two advisory VP-Sources doctrine paragraphs appended after the existing description (identical strings, see `recall` above).

#### `hybrid_search` — VP-Sources doctrine (PR-H)

Exports `HYBRID_SEARCH_TOOL_DESCRIPTION` from `mcp-server/src/tools.ts`.

Same two advisory VP-Sources doctrine paragraphs appended after the existing description (identical strings, see `recall` above).

### Issues (6)
`get_issue`, `list_issues`, `update_issue_status`, `verify_issue`, `issue_stats`, `link_commit_to_issue`

### Fix Patterns (5)
`create_fix_pattern`, `list_fix_patterns`, `add_fix_attempt`, `validate_fix`, `link_issue_to_pattern`

#### `create_fix_pattern`
Create a new fix pattern in the knowledge base. Documents a bug symptom, root cause, and optional validated fix. Agents search the KB before fixing to avoid repeating known mistakes.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `symptom` | string | yes | What the bug looks like — the user-visible problem |
| `rootCause` | string | yes | Why the bug happens — the underlying technical cause |
| `tags` | string or string[] | yes | Tags for categorization (e.g. `"react-hydration"`) |
| `stack` | string or string[] | yes | Tech stack involved (e.g. `"next.js"`, `"convex"`) |
| `sourceProject` | string | yes | Project where this was discovered |
| `createdBy` | string | yes | Orchestrator name (e.g. `"sigma"`) |
| `severity` | string | yes | `"critical"`, `"major"`, or `"minor"` |
| `validatedFix` | string | no | The fix that worked — set later if not yet known |
| `files` | string or string[] | no | Files involved in the fix |
| `linkedIssueIds` | string or string[] | no | VantagePeers issue IDs linked to this pattern |

Example:
```json
{
  "tool": "create_fix_pattern",
  "arguments": {
    "symptom": "Convex subscription silently drops after 60s of inactivity",
    "rootCause": "Missing keepAlive ping in useConvexQuery wrapper",
    "tags": ["convex-subscription", "silent-failure"],
    "stack": ["next.js", "convex"],
    "sourceProject": "myreeldream",
    "createdBy": "sigma",
    "severity": "major",
    "validatedFix": "Add 30s ping interval to the subscription hook"
  }
}
```

#### `add_fix_attempt`
Log a fix attempt against an existing pattern. Documents what was tried, whether it worked, and why. If `worked: true` and the pattern has no `validatedFix`, auto-sets it.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `patternId` | string | yes | ID of the fix pattern |
| `description` | string | yes | What was tried — the fix approach |
| `worked` | boolean | yes | Whether this fix resolved the issue |
| `why` | string | yes | Why it worked or did not — the reasoning |
| `createdBy` | string | yes | Orchestrator name |
| `commit` | string | no | Git commit hash of this attempt |

Example:
```json
{
  "tool": "add_fix_attempt",
  "arguments": {
    "patternId": "k5708d9xxwj81v92e0x3hwv36985g4d7",
    "description": "Added 30s ping interval to useConvexQuery",
    "worked": true,
    "why": "Keeps the WebSocket connection alive past the server idle timeout",
    "createdBy": "sigma",
    "commit": "e866274"
  }
}
```

#### `validate_fix`
Promote a candidate fix to validated status on an existing pattern. Use after independently confirming the fix holds in production.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `patternId` | string | yes | ID of the fix pattern |
| `validatedFix` | string | yes | Description of the validated fix |

Example:
```json
{
  "tool": "validate_fix",
  "arguments": {
    "patternId": "k5708d9xxwj81v92e0x3hwv36985g4d7",
    "validatedFix": "30s ping interval in subscription hook — verified stable over 48h in production"
  }
}
```

#### `link_issue_to_pattern`
Link a VantagePeers issue to a fix pattern. Creates a bidirectional reference so the issue and pattern are discoverable from each other.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `patternId` | string | yes | ID of the fix pattern |
| `issueId` | string | yes | VantagePeers issue ID to link |

Example:
```json
{
  "tool": "link_issue_to_pattern",
  "arguments": {
    "patternId": "k5708d9xxwj81v92e0x3hwv36985g4d7",
    "issueId": "m97ewrrqczew67kc6at3a59e7985ea7h"
  }
}
```

### Error Monitoring (2)
`list_errors`, `get_error`

### Deployments & Repos (5)
`add_deployment`, `remove_deployment`, `list_repo_mappings`, `add_repo_mapping`, `remove_repo_mapping`

#### `list_repo_mappings` — args schema + defaults (PR-C)

```
list_repo_mappings(limit?, cursor?, fields?)
```

| Arg | Type | Default | Notes |
|-----|------|---------|-------|
| `limit` | number 1–200 | `20` | Page size. Capped at `200` server-side. |
| `cursor` | string | — | Opaque token from prior `nextCursor`. |
| `fields` | `"lite"\|"full"` | `"full"` | `"lite"` returns `{_id, _creationTime, repo, orchestrator, project}`. `"full"` returns complete mapping object (including `active`, `lastDeployedSHA`, `lastDeployedAt`). |

Returns `{ items: RepoMapping[], nextCursor: string | null }`. `nextCursor` is `null` on the last page.

### Business Units (5)
`create_bu`, `list_bus`, `get_bu`, `update_bu`, `delete_bu`

#### `list_bus` — args schema + defaults (PR-A)

```
list_bus(orchestratorId?, status?, limit?, cursor?, fields?)
```

| Arg | Type | Default | Notes |
|-----|------|---------|-------|
| `orchestratorId` | string | — | Filter by lead orchestrator (e.g. `"sigma"`). |
| `status` | `"idea"\|"building"\|"live"\|"revenue"` | — | Filter by lifecycle status. |
| `limit` | number 1–200 | `20` | Page size. Capped at `200` server-side. |
| `cursor` | string | — | Opaque token from prior `nextCursor`. |
| `fields` | `"lite"\|"full"` | `"full"` | `"lite"` returns `{_id, name, status, orchestratorId, _creationTime}`. `"full"` returns complete BU object (18+ keys). |

Returns `{ items: BusinessUnit[], nextCursor: string | null }`. `nextCursor` is `null` on the last page.

### Components (6)
`register_component`, `list_components`, `get_component`, `update_component`, `delete_component`, `search_components_by_keyword` (alias `search_components`)

#### `list_components` — args schema + defaults (PR-B)

```
list_components(type?, team?, limit?, cursor?, fields?)
```

| Arg | Type | Default | Notes |
|-----|------|---------|-------|
| `type` | `"agent"\|"skill"\|"hook"\|"plugin"` | — | Filter by component type. |
| `team` | string | — | Filter by team (e.g. `"development"`). |
| `limit` | number 1–200 | `20` | Page size. Capped at `200` server-side. |
| `cursor` | string | — | Opaque token from prior `nextCursor`. |
| `fields` | `"lite"\|"full"` | `"full"` | `"lite"` returns `{_id, _creationTime, name, type, team}`. `"full"` returns complete component object. |

Returns `{ items: Component[], nextCursor: string | null }`. `nextCursor` is `null` on the last page.

### Mandates (6)
`create_mandate`, `list_mandates`, `accept_mandate`, `update_mandate`, `validate_mandate_spending`, `settle_mandate`

### Recurring Tasks (6)
`create_recurring_task`, `list_recurring_tasks`, `pause_recurring_task`, `resume_recurring_task`, `delete_recurring_task`, `update_recurring_task`

### Session (1)
`set_summary`

### Observability (1)
`improvisation_digest`

#### `improvisation_digest` — weekly advisory digest (PR-I)

Scans a rolling time window of VP tasks, messages, and memories for records carrying fleet/state tokens (commit SHA, PR#, VP id, decisive verb) with **no VP-Sources footer** — the Eta heuristic proxy for "made a fleet-state claim without a prior `recall` upstream".

```
improvisation_digest(windowDays?, orchestrators?)
```

| Arg | Type | Default | Notes |
|-----|------|---------|-------|
| `windowDays` | number | `7` | Days to look back. |
| `orchestrators` | string[] | — | Scope to these roles only (e.g. `["sigma","pi"]`). Omit for all orchestrators. |

**Returns:**

```ts
{
  countsByOrch: Record<string, number>,      // hit count per orchestrator
  countsByCategory: Record<string, number>,  // hit count per record type (task/message/memory)
  samples: Array<{
    id: string,
    category: string,
    orchestrator: string,
    snippet: string
  }>                                         // up to 50 representative snippets
}
```

**ADVISORY-only.** Pure read query — never blocks any action. Results are informational: a high improvisation rate suggests a team should increase VP-Sources citation hygiene, but the tool itself takes no automated action.

**V1 scope (Option C):** scans VP records (tasks + messages + memories) only. Per Pi Day-113 arbitration (msg `k97a0pp6kq1axkj6cmc4pecpy989ce1w`), fallback if V1 misses too many = **Option B** (new dedicated `sessions` Convex table), not Option A (JSONL replay).

**Detection heuristic (Eta A5 scope filter):**
- Flag condition 1: record body contains a durable-artifact token (7–40 hex SHA, `#NNN`, Convex ID prefix, or decisive verb `merged/deployed/approved/shipped/released/fixed`).
- Flag condition 2: record body does NOT contain the `VP-Sources:` footer substring.
- A5 scope: excludes `system`, `cron-*`, and webhook-sourced entries.

Examples:

```json
// Default 7-day window, all orchestrators
{ "tool": "improvisation_digest", "arguments": { "windowDays": 7 } }

// Scoped to one orchestrator
{ "tool": "improvisation_digest", "arguments": { "windowDays": 14, "orchestrators": ["sigma"] } }
```

## Compact payloads and status aliases (v2.12.0 — feature since v2.3.0)

### `fields=lite` — reduced token payloads

`list_tasks`, `list_tasks_by_mission`, `list_missions`, `list_briefing_notes`, `list_bus`, `list_components`, and `list_repo_mappings` accept an optional `fields` parameter:

| Value | Behaviour |
|-------|-----------|
| `"full"` | Default. Returns the complete document (backward-compatible). |
| `"lite"` | Returns a compact projection — significantly fewer tokens. |

Lite projections per entity:

| Tool | Lite fields |
|------|------------|
| `list_tasks` / `list_tasks_by_mission` | `_id`, `_creationTime`, `title`, `status`, `priority`, `assignedTo`, `missionId` |
| `list_missions` | `_id`, `_creationTime`, `name`, `status`, `pilot`, `priority`, `project` |
| `list_briefing_notes` | `_id`, `_creationTime`, `topic`, `title`, `participants`, `createdBy` |
| `list_bus` | `_id`, `_creationTime`, `name`, `status`, `orchestratorId` — PR-A activated actual projection (was no-op since v2.4.12) |
| `list_components` | `_id`, `_creationTime`, `name`, `type`, `team` — PR-B activated actual projection (was no-op — returned full row) |
| `list_repo_mappings` | `_id`, `_creationTime`, `repo`, `orchestrator`, `project` — PR-C activated actual projection (excludes `active`, `lastDeployedSHA`, `lastDeployedAt`) |

Example (tasks lite):
```json
{
  "tool": "list_tasks",
  "arguments": { "assignedTo": "sigma", "fields": "lite", "limit": 20 }
}
```
Returns:
```json
[
  { "_id": "k17e2r...", "title": "Prepare MCP v2.3.0", "status": "in_progress", "priority": "high", "assignedTo": "sigma", "missionId": "k572a..." }
]
```

### `status` arrays and aliases

`list_tasks`, `list_tasks_by_mission`, and `list_missions` now accept `status` as a single string, an array, or one of the aliases below.

#### Task status aliases

| Alias | Expands to |
|-------|-----------|
| `"open"` | `["todo", "in_progress", "review", "blocked"]` — everything except `done` |
| `"active"` | `["todo", "in_progress"]` |
| `"all"` | No filter — returns all statuses |

#### Mission status aliases

| Alias | Expands to |
|-------|-----------|
| `"open"` | `["brainstorm", "plan", "execute", "validate"]` — everything except `complete` |
| `"active"` | `["plan", "execute"]` |
| `"all"` | No filter — returns all statuses |

Examples:

```json
{ "tool": "list_tasks", "arguments": { "status": "open" } }
{ "tool": "list_tasks", "arguments": { "status": ["todo", "in_progress"] } }
{ "tool": "list_missions", "arguments": { "status": "active", "fields": "lite" } }
{ "tool": "list_tasks_by_mission", "arguments": { "missionId": "k572a...", "status": "all", "fields": "lite" } }
```

Single-string status values still work unchanged — fully backward-compatible.

## Fix patterns cycle

A fix pattern is a validated learning extracted from a resolved bug — symptom, root cause, and the fix that worked — stored in the VantagePeers knowledge base. Patterns accumulate across projects and agents so that the same bug is never debugged twice from scratch.

The cycle runs as follows:

1. **Agent encounters a bug.** Before touching any code, call `search_fix_patterns_by_semantic` (alias `search_fix_patterns`) with a plain-language description of the symptom. The KB returns ranked matches using semantic vector search.
2. **KB hit.** If a validated pattern is returned, apply the known fix directly. Log the reuse via `add_fix_attempt` (`worked: true`) so confidence scores stay current.
3. **KB miss.** If no pattern matches, the agent fixes the bug manually using standard debugging. Once resolved, the learning is captured immediately via `create_fix_pattern` — symptom, root cause, severity, stack, and the working fix.
4. **Validation.** After the fix holds in production (or after a second independent confirmation), call `validate_fix` to promote the pattern to validated status. This is the signal that downstream agents can trust the pattern without verification.
5. **Issue linkage.** Call `link_issue_to_pattern` to attach the VantagePeers issue ID to the pattern. This creates a bidirectional reference: the issue record points to the pattern, and the pattern's `linkedIssueIds` list points back.

The four tools that power this cycle are: `create_fix_pattern`, `add_fix_attempt`, `validate_fix`, and `link_issue_to_pattern`. The fifth tool, `search_fix_patterns_by_semantic` (alias `search_fix_patterns`), is in the Search / RAG category and is the entry point agents should call first.

On the agent side, the `/capitalize-fix` skill and the `inject-fix-patterns` hook automate steps 3-5: the hook fires on task completion events and prompts the orchestrator to capture the learning before closing the task. The cycle is designed to be low-friction — one tool call per step, all via MCP, no `npx convex run` required.

## Programmatic API (TypeScript)

For external services that need type-safe access to VantagePeers functions:

```bash
npm install vantage-peers-mcp convex
```

```typescript
import { fetchQuery, fetchMutation } from "convex/nextjs";
import { api } from "vantage-peers-mcp/api";

// Query memories with full type safety
const memories = await fetchQuery(
  api.memories.listMemories,
  { namespace: "global", limit: 10 },
  { url: process.env.CONVEX_URL }
);

// Send a message
await fetchMutation(
  api.messages.sendMessage,
  { from: "pi", channel: "broadcast", content: "Hello from Studio" },
  { url: process.env.CONVEX_URL }
);
```

Requires `convex` as a peer dependency. Only public functions are exported.

### Authentication with Deploy Keys

For server-to-server access, use a Convex deploy key:

1. Go to your [Convex dashboard](https://dashboard.convex.dev) > Settings > Deploy Keys
2. Generate a new deploy key for your deployment
3. Set it as an environment variable:

```bash
CONVEX_DEPLOY_KEY=prod:your-deploy-key-here
```

4. Use it with the Convex client:

```typescript
import { ConvexHttpClient } from "convex/browser";
import { api } from "vantage-peers-mcp/api";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);

// Query with type safety
const memories = await client.query(api.memories.listMemories, {
  namespace: "global",
  limit: 10,
});

// Mutate with type safety
await client.mutation(api.messages.sendMessage, {
  from: "studio",
  channel: "sigma",
  content: "Task completed",
});
```

**Security:** Never commit deploy keys to git. Use environment variables or a secrets manager.

## Orchestrator Roles

All orchestrator names are open strings — any lowercase name is accepted. The following are conventions used by the VantageOS team:

| Role | Purpose |
|------|---------|
| `pi` | Lead orchestrator — planning, delegation, strategy |
| `tau` | Frontend specialist — UI, design systems, components |
| `phi` | Backend specialist — APIs, database, infrastructure |
| `sigma` | Infrastructure — deployments, CI/CD, monitoring |
| `omega` | VantageRegistry — agent and skill catalog |
| `zeta` | Project-specific specialist |
| `eta` | Code reviewer — GitHub PR reviews |
| `alpha` | Perello Consulting — client delivery |
| `lambda` | Tech intelligence — research and monitoring |
| `victor` | HR / people operations |
| `system` | Reserved for automated/webhook operations (bypasses RBAC). Not a real agent. |

> **Custom roles:** any lowercase string is a valid orchestrator name. Enterprise clients can use arbitrary role names for their own agent teams.

## Requirements

- Node.js >= 18
- A VantagePeers Convex deployment ([get started](https://vantagepeers.com/docs))

## Changelog

### 2.4.3 — 2026-05-31 (Day 89)
- fix(overflow): defensive byte-cap on all 17 `list_*` tools — `capListResponseBytes` truncates any list response above 60 KB and wraps the result in a `_meta` envelope (`_truncated`, `_showing`, `_total`, `_advice`) so MCP clients (Claude.ai, ChatGPT, Claude Code) never reject a list result for exceeding their token budget. Day 89 Pi 75,003-char `list_tasks` overflow incident reproduced and capped in regression test. PR #565.

### 2.4.1 — 2026-05-30 (Day 88)
- fix(dcr): `oauthDcr:validateAccessToken` exposed as PUBLIC `query` (was `internalQuery`, unreachable via `ConvexHttpClient.query()` → Path 3 DCR returned 401 even with valid token) — issue #556 / PR #557.
- fix(dcr): `WWW-Authenticate` header now emits `Bearer resource_metadata="..."` per MCP spec §Protected Resource Metadata Discovery (was `resource="..."` — broke Claude.ai PRM discovery bootstrap on 401) — PR #557.
- feat(mcp): ChatGPT Apps SDK tool annotations on all 84 tools (`readOnlyHint`, `openWorldHint`, `destructiveHint`) — 34 read-only + 41 write + 9 destructive — PR #555.
- security(dcr): DCR scope isolation — new `public-readonly` profile + cross-tenant assertion tests + `scopeProfile` forced to `client-generic` for auto-discovery flow (never `master`) — PR #554.
- docs(cloud): dedicated `/docs/cloud/` section in vantage-peers-site for VantagePeers Cloud (multi-tenant, multi-clients MCP: Claude.ai, ChatGPT, Claude Code, Codex) — site PR #120.

### 2.4.0 — 2026-05-29 (Day 86)
- feat(m3): `iframeEmbedSessions` table + `__VP_TOOL_RESULT__` stream marker + ack-checklist primitive — PR #545.
- feat(v0.0.2-auth): `credentials:issueBearerFromClerk` httpAction + audit log + iter 2 P1 fixes — PR #546.

### 2.3.0 — 2026-05-26
- `list_tasks`, `list_missions`, `list_tasks_by_mission`, `list_briefing_notes` now accept `fields=lite` for compact payloads (less tokens).
- Status filters now accept arrays and aliases: `status=["todo","in_progress"]`, `status="open"` (expands to non-terminal), `status="active"` (in_progress only on tasks; plan+execute on missions), `status="all"` (no filter).
- Single-string status still accepted unchanged (backward-compatible).

### 2.2.0 — 2026-05-07
- 4 new fix-pattern tools: `create_fix_pattern`, `add_fix_attempt`, `validate_fix`, `link_issue_to_pattern`
- Detailed per-tool docs with arg tables and example calls in README
- New "Fix patterns cycle" section documenting the KB learning loop
- 41 new Zod input-validation unit tests for fix-pattern tools

### 2.1.1 — 2026-05-04
- Defense-in-depth `memoryIdSchema` validation for `create_briefing_note` and `update_briefing_note`

### 2.1.0 — 2026-04-25
- `update_briefing_note` MCP tool with RBAC

### 2.0.2 — 2026-04-14
- Added badges (npm version, downloads, license, tool count) to the published README
- Added Orchestrator Roles reference table including alpha, lambda, victor (Day 39 additions)
- Added note that any custom lowercase role name is accepted
- Added `bugs` URL and additional keywords to `package.json`

### 2.0.1 — 2026-04-14
- Docstring fix in server.ts (minor)

### 2.0.0
- Type-safe `api.ts` export for cross-deployment calls (`vantage-peers-mcp/api`)
- Deploy key authentication guide
- Mission Templates category (1 tool: `update_mission_template`)
- Programmatic API section in README

### 1.x
- Initial public release with 82 MCP tools

## License

FSL-1.1-Apache-2.0

## Links

- [Documentation](https://vantagepeers.com/docs)
- [GitHub](https://github.com/vantageos-agency/vantage-peers)
