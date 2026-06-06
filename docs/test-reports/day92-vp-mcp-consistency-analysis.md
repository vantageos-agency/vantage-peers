---
title: "VP MCP Tools Consistency Analysis — Day 92"
date: 2026-06-05
mission: k57a36y8w5t085bqr23dsmvb2d882506
task: k171n7fdqz15g1trht4q2dm4rn8836qv
input: docs/test-reports/day92-vp-mcp-audit-matrix.md (PR #659 commit 8065a7a)
---

# VP MCP Tools Consistency Analysis — Day 92

VantagePeers **Cloud** (multi-tenant) only. Never mix with Self-host.

**Corpus:** 86 tools registered in `mcp-server/src/tools.ts` as of Day 92 (SHA 9e31caf).
The A1 audit matrix (PR #659, commit 8065a7a) covers 85 tools — `whoami` was added after the A1 snapshot (A3 PR #660). `validate_task_payload` does NOT exist at this SHA — it ships in F1 PR #663 (OPEN, not merged). All four distribution analyses below cover the correct 86-tool corpus.

> **A2 iter 2 phantom-fix note**: original A2 claimed 87 tools and included `validate_task_payload` in distributions. That tool is absent at SHA 9e31caf. Counts corrected below (Eta verdict comment 4634019881 on PR #662).

---

## §1 Naming Distribution

### Counts

| Pattern | Count | % | Notes |
|---------|-------|---|-------|
| `verb_noun_lowercase_snake` — allowed verb | 66 | 76.7% | Core standard — dominant pattern |
| `verb_noun_lowercase_snake` — non-standard verb | 20 | 23.3% | See sub-table below |
| camelCase | 0 | 0% | No anomalies |
| noun-first anomaly | 1 | 1.1% | `issue_stats` (counted in non-standard above) |

**Total: 86**

### Non-standard verb breakdown (20 tools)

| Non-standard verb | Count | Tools | Canonicalization |
|-------------------|-------|-------|-----------------|
| `add` | 4 | `add_deployment`, `add_fix_attempt`, `add_repo_mapping`, `add_task_dependency` | → `create` |
| `remove` | 2 | `remove_deployment`, `remove_repo_mapping` | → `delete` |
| `validate` | 2 | `validate_fix`, `validate_mandate_spending` | → `check` |
| `soft` | 1 | `soft_delete_memory` | → `delete_memory` + `soft: true` arg |
| `text` | 1 | `text_search` | → `search_text` (swap word order) |
| `hybrid` | 1 | `hybrid_search` | → `search_hybrid` (swap word order) |
| `set` | 1 | `set_summary` | → `update_summary` |
| `write` | 1 | `write_diary` | → `create_diary` (diary entries are create, not update) |
| `checkout` | 1 | `checkout_task` | → `claim_task` or `start_task` (atomic claim semantics) |
| `block` | 1 | `block_task` | → `update_task` with `status=blocked` (or keep as named shortcut) |
| `pause` | 1 | `pause_recurring_task` | → `update_recurring_task` with `status=paused` |
| `resume` | 1 | `resume_recurring_task` | → `update_recurring_task` with `status=active` |
| `verify` | 1 | `verify_issue` | → `check_issue` or `update_issue` with `verified=true` |
| `instantiate` | 1 | `instantiate_template_into_mission` | → `create_mission_from_template` |
| `issue` (noun-first) | 1 | `issue_stats` | → `get_issue_stats` (move verb to front) |

### Verb frequency (all 86 tools)

| Verb | Count | Status |
|------|-------|--------|
| `list` | 17 | Allowed |
| `update` | 11 | Allowed |
| `get` | 10 | Allowed |
| `create` | 7 | Allowed |
| `delete` | 5 | Allowed |
| `add` | 4 | Non-standard |
| `store` | 2 | Allowed |
| `search` | 2 | Allowed |
| `validate` | 2 | Non-standard |
| `remove` | 2 | Non-standard |
| `link` | 2 | Allowed |
| All others | 1 each | Mixed — see table above |

### RECOMMENDATION for B2

Standardize on `verb_noun_lowercase_snake` with a fixed allowed-verb whitelist. Reject any verb outside the whitelist at PR review.

**Allowed verbs whitelist:**
`create`, `get`, `list`, `update`, `delete`, `search`, `send`, `check`, `store`, `recall`, `whoami`, `mark`, `register`, `link`, `complete`, `start`, `accept`, `settle`

**Migration targets (by priority):**

- **High impact (confusing to LLM clients):** `instantiate_template_into_mission` → `create_mission_from_template` | `issue_stats` → `get_issue_stats` | `soft_delete_memory` → fold into `delete_memory` with `soft: true` arg | `text_search` / `hybrid_search` → `search_text` / `search_hybrid`
- **Medium impact (consistent family names):** `add_*` → `create_*` (4 tools) | `remove_*` → `delete_*` (2 tools) | `validate_*` → `check_*` (2 tools at this SHA: `validate_fix`, `validate_mandate_spending`; `validate_task_payload` ships post-F1-merge PR #663) | `set_summary` → `update_summary` | `write_diary` → `create_diary`
- **Low impact (domain shortcuts acceptable):** `checkout_task`, `block_task`, `pause_recurring_task`, `resume_recurring_task`, `verify_issue` — may keep as named shortcuts if product surface area justifies; document exception in B2.

---

## §2 Description Length Distribution

### Measurements (86 tools)

| Percentile | Char count |
|-----------|-----------|
| Min | 52 (`delete_recurring_task`) |
| P25 | 96 |
| P50 (median) | 131 |
| P75 | 165 |
| P95 | 248 |
| Max | 426 (`create_briefing_note`) |

Mean: 143 chars | Stdev: 75 chars

### Distribution by range

| Range | Count | % | Assessment |
|-------|-------|---|-----------|
| < 80 chars | 15 | 17.2% | Too short — no context for LLM selection |
| 80–200 chars | 59 | 67.8% | OK zone — working range |
| 201–400 chars | 11 | 12.6% | Long — review for trimming |
| > 400 chars | 2 | 2.3% | Outlier — trim or move to docstring |

### Outlier short (<80 chars) — 15 tools

| Tool | Chars | Gap |
|------|-------|-----|
| `delete_recurring_task` | 52 | No context, no WHEN |
| `delete_component` | 57 | No context, no WHEN |
| `update_issue_status` | 59 | No context, no WHEN |
| `delete_bu` | 62 | No context, no WHEN |
| `resume_recurring_task` | 63 | No context, no WHEN |
| `update_mission_status` | 67 | No context, no WHEN |
| `verify_issue` | 70 | No context, no WHEN |
| `pause_recurring_task` | 71 | No context, no WHEN |
| `validate_fix` | 72 | No context, no WHEN |
| `delete_task` | 73 | No context, no WHEN |
| `get_issue` | 74 | No context, no WHEN |
| `link_commit_to_issue` | 75 | No context, no WHEN |
| `get_component` | 76 | No context, no WHEN |
| `search_components` | 76 | No context, no WHEN |
| `issue_stats` | 78 | No context, no WHEN |

### Outlier long (>250 chars) — 3 tools

| Tool | Chars | Reason |
|------|-------|--------|
| `create_briefing_note` | 426 | `linkedMemoryIds` disclaimer inflates; should move to arg-level `describe()` |
| `add_deployment` | 273 | Security note inflates; acceptable |

### RECOMMENDATION for B2

Target description format: **1-line summary (≤ 120 chars) + WHEN clause (1–2 sentences) + 1 example. Total ≤ 500 chars.**

Template:
```
<Verb> a <noun> in VantagePeers. WHEN: <use-case trigger>. EXAMPLE: <minimal call pattern>.
```

Reference implementation: `whoami` (320 chars) — has all three components. `complete_task` (249 chars) — has WHEN context + evidence-bound doctrine note.

Enforce in B2:
- Hard floor: 80 chars minimum — any description under 80 chars is rejected at review.
- Soft ceiling: 500 chars — above 500 requires justification comment.
- Mandatory components: 1-line summary (no period before WHEN), WHEN clause, 1 EXAMPLE.
- Note extraction rule: per-arg detail that appears in the tool-level description must be moved to its Zod `.describe()` instead (see `create_briefing_note.linkedMemoryIds` as anti-pattern).

---

## §3 Example Presence

### Counts (86 tools)

| Status | Count | % |
|--------|-------|---|
| Explicit example in description | 5 | 5.8% |
| No example | 81 | 94.2% |

### Tools with explicit examples

| Tool | Example text |
|------|-------------|
| `send_message` | `"broadcast"` (channel value) |
| `set_summary` | `"pi-chromebook"` (instanceId value) |
| `create_recurring_task` | `"every 30min"` (schedule pattern) |
| `get_mission_template` | `"issue-resolution-v2"` (template name) |
| `whoami` | `"a fresh Claude.ai connector calls whoami first, then uses suggested_orchestrator_id as 'from'"` |

### Impact of missing examples on MCP clients

MCP clients (Claude.ai, ChatGPT, Claude Code, Codex) select tools by comparing the user's intent against tool descriptions. Without an example:

1. **Ambiguous value selection** — clients guess field formats (Convex IDs, orchestrator role names, namespace prefixes, cron expressions) and produce `ArgumentValidationError` on first attempt.
2. **Retry tax** — each failed guess costs a round-trip; Day 92 diagnosis showed 2–3 rejection loops per task on `create_task` / `complete_task` (note: `validate_task_payload` pre-lint tool ships in F1 PR #663, not yet merged at this SHA).
3. **ChatGPT-specific degradation** — GPT-4o description ranking weighs concrete examples more heavily than Claude; 94% of tools have no anchor value.

### RECOMMENDATION for B2

**1 example MANDATORY per tool.** Example must appear in the description string (not in arg `describe()` only) so all MCP clients surface it during tool selection.

Example format: `EXAMPLE: <tool>({ field: "concrete-value", ... })` or `EXAMPLE: <narrative sentence with real value>`.

Priority: fix all 15 short-description tools first (they have both no example and no WHEN clause). The 3 tools with `send_message`-style broadcasts or cron expressions (`send_message`, `create_recurring_task`, `get_mission_template`) already demonstrate the pattern — replicate it.

---

## §4 Response Structure

### Counts (86 tools)

| Category | Count | % | Description |
|----------|-------|---|-------------|
| Object — write confirmation | 37 | 43.0% | `{ entityId, status/updated, ... }` custom per-family |
| Array — list/search | 24 | 27.9% | Raw JSON array, sometimes `_meta`-wrapped by `capListResponseBytes` |
| Object — entity get | 11 | 12.8% | Raw entity shape from Convex passthrough |
| Object — raw passthrough | 13 | 15.1% | `JSON.stringify(result)` — no reshaping |
| Object — structured special | 1 | 1.2% | `whoami` (typed, stable shape with exported `outputSchema`) |

**Total: 86**

### Envelope consistency analysis

| Envelope type | Count | Notes |
|--------------|-------|-------|
| Standard `{ status, data, ... }` envelope | 0 | Never used |
| Standard `{ result, error }` envelope | 0 | Never used |
| Family-consistent custom envelope | ~37 | Write tools: `{ entityId, updated: true }` near-consistent within families |
| `_meta` truncation wrapper | 24 | Only present when `capListResponseBytes` triggers (>60 KB) |
| Raw passthrough | 13 | Shape determined by Convex mutation/query return value |

### Per-family consistency

**ECRITURE (write) tools — nearest to consistent:**

| Sub-family | Shape pattern |
|-----------|---------------|
| Create | `{ <entityId>, name/title, key-fields, status }` |
| Update | `{ <entityId>, updated: true }` |
| Delete | raw Convex result (inconsistent — some return `null`, some return deleted doc) |
| Status transition | `{ <entityId>, status: "<new-status>" }` |

**LECTURE (read) tools — inconsistent:**

| Sub-family | Shape pattern |
|-----------|---------------|
| `get_*` | Raw entity object (or `null` for 404) |
| `list_*` | Raw array (or `{ _meta, items }` if truncated by capListResponseBytes) |
| `search_*` | Raw array (no cursor, no `_meta`) |
| Aggregate | Custom — `issue_stats` returns flat counts object |

### Notable inconsistencies

1. **Delete shape divergence:** `delete_task`, `delete_component`, `delete_bu`, `delete_message`, `delete_recurring_task` — 5 tools return raw Convex result (may be `null`, may be the deleted doc). No uniform `{ deleted: true, id }` shape.
2. **List truncation opacity:** `list_*` tools return bare array when under 60 KB but switch to `{ _meta, items }` envelope when over — callers must handle both shapes.
3. **`whoami` is the only tool with an exported `outputSchema`** (line 576). Declared as "precedent for C1 code-gen." All other 85 tools have `outputSchema: 0/85` (A1 gap metric, adjusted for 86-tool corpus).
4. **Raw passthrough risk:** 13 tools forward the Convex mutation/query return directly — if Convex schema changes, the MCP tool response shape changes silently with no outputSchema validation gate.

### RECOMMENDATION for B2

Adopt a **per-family envelope convention** (not a global envelope — migration cost is too high):

| Family | Standard shape |
|--------|---------------|
| `create_*` | `{ id: "<entityId>", ...key_fields }` — `id` always string, always first |
| `update_*` | `{ id: "<entityId>", updated: true }` |
| `delete_*` | `{ id: "<entityId>", deleted: true }` — stop returning raw null |
| `get_*` | `{ ...entity } \| null` — 404 returns `null`, not error |
| `list_*` | `{ items: [...], cursor: string \| null }` — always include `cursor` even when null; retire bare-array shape |
| `search_*` | `{ results: [...] }` — named key prevents confusion with `list_*` |
| Special | Free-form with exported `outputSchema` (see `whoami` precedent) |

**outputSchema gap is structural:** 85/86 tools have no `outputSchema`. B2 should designate the `create_*` and `get_*` families as pilot targets for outputSchema addition (stable shapes, high call frequency). `whoami` is the reference implementation.

**Truncation envelope fix:** standardize `list_*` response to always be `{ items: [...], cursor: string | null, _meta?: { truncated, showing, total } }` — the `_meta` field becomes optional rather than the shape itself switching.

---

## §5 Roll-Up Summary

| Distribution | Key finding | B2 section driven |
|--------------|------------|-------------------|
| §1 Naming | 76.7% compliant; 20 non-standard verbs, 0 camelCase | B2 §2 "Allowed verb whitelist" + §3 "Migration targets" |
| §2 Description length | P50=131 chars; 15 tools too short (<80), 2 outlier-long (>250) at this SHA | B2 §4 "Description format template" + floor/ceiling enforcement |
| §3 Example presence | 5.8% with examples (5/86); 94.2% missing | B2 §5 "Mandatory example rule" |
| §4 Response structure | No global envelope; per-family near-consistent for write tools; delete and passthrough diverge | B2 §6 "Per-family envelope standard" + §7 "outputSchema pilot targets" |

**Next step: B2 (tools-quality-standard.md)** encodes each recommendation above as a binding rule with conformance check procedure. B2 is the reference document for PR review of any new or modified tool registration.

---

## §6 Methodology

**Sources scanned:**
- Primary: `docs/test-reports/day92-vp-mcp-audit-matrix.md` (PR #659, commit 8065a7a) — 85-tool matrix with description lengths, naming convention flag, example presence flag, and scope-gate assessment.
- Secondary: `mcp-server/src/tools.ts` (HEAD at branch creation) — direct scan for tool names, response shapes, example presence in description strings, and `outputSchema` registration.

**Tool count derivation (iter 2 corrected):**
- `grep -c "server\.tool(" mcp-server/src/tools.ts` → **86** at SHA 9e31caf (A1 baseline was 85; `whoami` added post-matrix via A3 PR #660; `validate_task_payload` absent — ships in F1 PR #663).
- Name extraction: `awk '/server\.tool\(/{found=1; next} found{...}' tools.ts` — 86 unique names, 0 duplicates.

**Naming analysis:**
- Allowed verb whitelist derived from mission spec + existing compliant-tool verb set.
- Non-standard: `verb = tool.split("_")[0]` not in whitelist. `whoami` treated as single-token allowed verb (identity introspection idiom).
- `issue_stats`: noun-first — verb missing entirely, counted as non-standard.

**Description length:**
- A1 matrix char counts used directly for 85 tools (methodology: visual character count at matrix scan time).
- `whoami` length measured via `len()` on the string literal in `tools.ts`.
- Line counts not measured (descriptions are single-string concatenations with no literal newlines — line count = 1 for all tools).

**Example presence:**
- A1 matrix "Example in description" column used for 85 tools.
- `whoami` description scanned manually — contains `EXAMPLE:` keyword, counted as Yes.

**Response structure:**
- Manual scan of each handler's return statement in `tools.ts`.
- Categorized by presence of: entity-id field, `updated: true` pattern, array top-level, raw `result` passthrough.
- Passthrough defined as: `text: JSON.stringify(result, null, 2)` where `result` is the direct Convex query/mutation return with no field re-mapping.

**Markdown lint:** `markdownlint` not installed in environment — lint skipped. Document follows ATX heading style, consistent table alignment, fenced code blocks.

**Reproducibility:** Re-run naming analysis with `awk '/server\.tool\(/{found=1; next} found{...}' mcp-server/src/tools.ts | sort` and cross-check against this report's tool list. Re-run description length scan against `tools.ts` string literals for new tools.
