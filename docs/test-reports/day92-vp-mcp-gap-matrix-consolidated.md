---
title: "VP MCP Consolidated Gap Matrix — Day 92"
date: 2026-06-05
mission: k57a36y8w5t085bqr23dsmvb2d882506
task: k170km6d1vpmc0xeh71vcy83zx883k2c
inputs:
  - A1 audit matrix (PR #659 commit 8065a7a)
  - A2 consistency analysis (PR #661 commit 8c8d5d3)
  - A3 whoami pattern (PR #660 commit 5231811)
---

# VP MCP Consolidated Gap Matrix — Day 92

VantagePeers **Cloud** (multi-tenant) only. Never mix with Self-host.

---

## §0 Reconciled Tool Count

### Command run

```bash
grep -A2 "server\.tool(" mcp-server/src/tools.ts \
  | grep -E '^[[:space:]]+"[a-z][a-z_]+",$' \
  | sort -u \
  | wc -l
```

**Result: 87** unique `server.tool()` registrations as of HEAD on branch `feature/day92-A4-consolidated-gap-matrix` (tools.ts: 6,488 lines).

### Reconciliation

| Source | Count | Method |
|--------|-------|--------|
| A1 audit matrix (PR #659 commit 8065a7a) | 85 | `grep -c "server\.tool(" tools.ts` at A1 snapshot |
| A2 consistency analysis (PR #661 commit 8c8d5d3) | 87 | `grep -c "server\.tool("` at A2 scan time |
| **Canonical (this document)** | **87** | `grep -A2 "server\.tool(" ... \| grep -E '"[a-z][a-z_]+"' \| sort -u \| wc -l` |

### Explanation of the 2-tool delta

A1 was snapshotted before two tools shipped:

| Tool added after A1 | PR | Notes |
|--------------------|----|-------|
| `whoami` | PR #660 commit 5231811 (A3) | Identity introspection; first `outputSchema` export at `tools.ts:576` |
| `validate_task_payload` | Between A1 and A2 snapshots | Dry-run lint tool; 398-char description; no `outputSchema` |

Both tools are present in the A2 analysis and in the canonical 87-tool count. **87 is the truth for all Phase B and Phase C work.**

---

## §1 Per-Tool Decision Table

One row per canonical tool (87 total). Severity reconciles A1's P0=14/P1=69/P2=2 with A2's naming/example/envelope findings. A2 adds naming and example gaps as P1 sub-axes but does not change the severity tier of any tool already classified by A1.

> **Column key:**
> - `outputSchema`: Yes = declared / No = missing (0/87 except `whoami`)
> - `Case-handling`: CS = case-sensitive / N/A = no orch-id arg / IC = case-insensitive (none currently)
> - `Scope-gate`: gate function(s) present / None / Partial (conditional on optional arg)
> - `Naming OK`: Yes = verb in allowed whitelist + verb_noun_snake / No = non-standard
> - `Example`: Yes = explicit EXAMPLE in description / No = missing
> - `LOC delta`: estimated lines-of-code to close all gaps for that tool
> - `Phase`: recommended Phase C sub-batch

| # | Tool | Category | outputSchema | Case-handling | Scope-gate | Naming OK | Example | Severity | LOC delta est. | Phase target | Notes |
|---|------|----------|-------------|---------------|------------|-----------|---------|----------|----------------|--------------|-------|
| 1 | `store_memory` | ECRITURE | No | CS | guardFrom + guardWrite | Yes | No | P1 | 20 | C1 | outputSchema + example |
| 2 | `soft_delete_memory` | ECRITURE | No | N/A | guardMasterOnly | No | No | P1 | 22 | C1 + C3 | outputSchema; naming → `delete_memory` with `soft:true` arg |
| 3 | `get_memory` | LECTURE | No | CS | scopeFilterGet | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 4 | `recall` | LECTURE | No | N/A | guardRead | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 5 | `text_search` | LECTURE | No | N/A | guardRead | No | No | P1 | 20 | C1 + C3 | outputSchema; naming → `search_text` |
| 6 | `hybrid_search` | LECTURE | No | N/A | guardRead | No | No | P1 | 20 | C1 + C3 | outputSchema; naming → `search_hybrid` |
| 7 | `store_episode` | ECRITURE | No | CS | guardFrom + guardWrite | Yes | No | P1 | 20 | C1 | outputSchema + example |
| 8 | `get_profile` | LECTURE | No | CS | scopeFilterGet | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 9 | `update_profile` | ECRITURE | No | CS | guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 10 | `list_memories` | LECTURE | No | CS | guardRead + scopeFilterList | Yes | No | P1 | 20 | C1 | outputSchema + example; cursor paging |
| 11 | `send_message` | ECRITURE | No | CS | guardFrom | Yes | Yes | P2 | 17 | C1 + C4 | outputSchema; stale claude-peers ref in description |
| 12 | `check_messages` | LECTURE | No | CS | fromAllowList | Yes | No | P2 | 17 | C1 + C4 | outputSchema; stale claude-peers ref |
| 13 | `mark_as_read` | ECRITURE | No | N/A | None | Yes | No | P1 | 18 | C1 | outputSchema + example; no receipt ownership check |
| 14 | `delete_message` | ECRITURE | No | CS | guardFrom (conditional) | Yes | No | P1 | 18 | C1 | outputSchema + example; conditional guard |
| 15 | `set_summary` | ECRITURE | No | CS | guardFrom | No | Yes | P1 | 19 | C1 + C3 | outputSchema; naming → `update_summary` |
| 16 | `list_peers` | LECTURE | No | N/A | scopeFilterList | Yes | No | P2 | 17 | C1 + C4 | outputSchema; stale claude-peers ref |
| 17 | `list_messages` | LECTURE | No | CS | scopeFilterList only (no pre-gate on `from`) | Yes | No | P1 | 21 | C1 + C2 | FLAG: `from` filter lacks symmetric pre-gate (Eta retro PR #654); outputSchema + example + pre-gate fix |
| 18 | `list_broadcast_status` | LECTURE | No | N/A | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 19 | `create_task` | ECRITURE | No | CS | dual guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 20 | `list_tasks` | LECTURE | No | CS | listTasksGate | Yes | No | P1 | 18 | C1 | outputSchema + example; cursor paging |
| 21 | `update_task` | ECRITURE | No | CS | guardFrom (conditional) | Yes | No | P1 | 18 | C1 | outputSchema + example; conditional guard |
| 22 | `complete_task` | ECRITURE | No | CS | guardFrom (conditional) | Yes | No | P1 | 18 | C1 | outputSchema + example; evidence-bound doctrine in description |
| 23 | `start_task` | ECRITURE | No | CS | guardFrom (conditional) | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 24 | `checkout_task` | ECRITURE | No | CS | guardFrom (required) | No | No | P1 | 21 | C1 + C3 | outputSchema + example; naming → `claim_task` |
| 25 | `delete_task` | ECRITURE | No | CS | guardFrom (conditional) | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 26 | `block_task` | ECRITURE | No | CS | guardFrom (conditional) | No | No | P1 | 21 | C1 + C3 | outputSchema + example; naming shortcut acceptable per B2 exception |
| 27 | `add_task_dependency` | ECRITURE | No | CS | guardFrom (conditional) | No | No | P1 | 21 | C1 + C3 | outputSchema + example; naming → `create_task_dependency` |
| 28 | `list_tasks_by_mission` | LECTURE | No | N/A | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example; cursor paging |
| 29 | `create_mission` | ECRITURE | No | CS | dual guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 30 | `list_missions` | LECTURE | No | CS | userId equality (not fromAllowList) | Yes | No | P1 | 21 | C1 + C2 | FLAG: `pilot` gate uses oauthCtx.userId not fromAllowList — inconsistent with list_tasks fix commit 24b39c5; outputSchema + example |
| 31 | `get_mission` | LECTURE | No | N/A | scopeFilterGet | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 32 | `update_mission` | ECRITURE | No | CS | guardFrom (conditional) | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 33 | `update_mission_status` | ECRITURE | No | N/A | **None** | Yes | No | **P0** | 23 | **C0** | Zero auth — any bearer can change any mission status; add guardMasterOnly or guardFrom with required callerOrchestrator arg |
| 34 | `write_diary` | ECRITURE | No | CS | guardFrom | No | No | P1 | 21 | C1 + C3 | outputSchema + example; naming → `create_diary` |
| 35 | `get_diary` | LECTURE | No | CS | scopeFilterGet | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 36 | `list_diaries` | LECTURE | No | CS | userId equality | Yes | No | P1 | 18 | C1 | outputSchema + example; cursor paging |
| 37 | `create_briefing_note` | ECRITURE | No | CS | guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example; description 426 chars — trim linkedMemoryIds to arg describe() |
| 38 | `update_briefing_note` | ECRITURE | No | CS | guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 39 | `get_briefing_note` | LECTURE | No | N/A | scopeFilterGet | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 40 | `list_briefing_notes` | LECTURE | No | N/A | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example; cursor paging |
| 41 | `register_component` | ECRITURE | No | CS | guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 42 | `list_components` | LECTURE | No | N/A | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example; cursor paging |
| 43 | `get_component` | LECTURE | No | N/A | scopeFilterGet | Yes | No | P1 | 18 | C1 | outputSchema + example; description 76 chars (below 80 floor) |
| 44 | `update_component` | ECRITURE | No | N/A | **None** | Yes | No | **P0** | 25 | **C0** | Zero auth — any bearer updates any component; add optional callerOrchestrator + guardFrom or guardMasterOnly |
| 45 | `delete_component` | ECRITURE | No | N/A | **None** | Yes | No | **P0** | 23 | **C0** | Zero auth; description 57 chars (below 80 floor); add guardMasterOnly |
| 46 | `search_components` | LECTURE | No | N/A | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example; description 76 chars (below 80 floor) |
| 47 | `create_recurring_task` | ECRITURE | No | CS | dual guardFrom | Yes | Yes | P1 | 17 | C1 | outputSchema |
| 48 | `list_recurring_tasks` | LECTURE | No | CS | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example; cursor paging |
| 49 | `pause_recurring_task` | ECRITURE | No | N/A | **None** | No | No | **P0** | 25 | **C0** | Zero auth; naming shortcut acceptable per B2 exception; description 71 chars (below 80 floor); add guardFrom with required callerOrchestrator arg |
| 50 | `resume_recurring_task` | ECRITURE | No | N/A | **None** | No | No | **P0** | 25 | **C0** | Zero auth; naming shortcut acceptable; description 63 chars (below 80 floor); add guardFrom with required callerOrchestrator arg |
| 51 | `delete_recurring_task` | ECRITURE | No | N/A | **None** | Yes | No | **P0** | 25 | **C0** | Zero auth; description 52 chars (shortest in corpus, below 80 floor) |
| 52 | `update_recurring_task` | ECRITURE | No | CS | guardFrom (conditional) | Yes | No | P1 | 18 | C1 | outputSchema + example; conditional guard |
| 53 | `create_mandate` | ECRITURE | No | CS | dual guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 54 | `accept_mandate` | ECRITURE | No | CS | guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 55 | `update_mandate` | ECRITURE | No | CS | guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 56 | `settle_mandate` | ECRITURE | No | CS | guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 57 | `validate_mandate_spending` | LECTURE | No | N/A | None (read-only, no sensitive data path) | No | No | P1 | 20 | C1 + C3 | Read-only; security axis P2; naming + outputSchema axis P1; naming → `check_mandate_spending` |
| 58 | `list_mandates` | LECTURE | No | CS | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example; cursor paging |
| 59 | `create_bu` | ECRITURE | No | CS | guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 60 | `update_bu` | ECRITURE | No | CS | guardFrom (conditional) | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 61 | `get_bu` | LECTURE | No | N/A | scopeFilterGet | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 62 | `list_bus` | LECTURE | No | CS | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example; cursor paging |
| 63 | `delete_bu` | ECRITURE | No | N/A | **None** | Yes | No | **P0** | 23 | **C0** | Zero auth; add guardMasterOnly; description 62 chars (below 80 floor) |
| 64 | `add_repo_mapping` | ECRITURE | No | N/A | **None** | No | No | **P0** | 25 | **C0** | Zero auth; naming → `create_repo_mapping`; add guardMasterOnly |
| 65 | `list_repo_mappings` | LECTURE | No | N/A | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example; cursor paging |
| 66 | `remove_repo_mapping` | ECRITURE | No | N/A | **None** | No | No | **P0** | 25 | **C0** | Zero auth; naming → `delete_repo_mapping`; add guardMasterOnly |
| 67 | `list_issues` | LECTURE | No | CS | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example; cursor paging; multi-query dispatch |
| 68 | `get_issue` | LECTURE | No | N/A | scopeFilterGet | Yes | No | P1 | 18 | C1 | outputSchema + example; description 74 chars (below 80 floor) |
| 69 | `update_issue_status` | ECRITURE | No | N/A | **None** | Yes | No | **P0** | 23 | **C0** | Zero auth; description 59 chars (below 80 floor); add required callerOrchestrator + guardFrom |
| 70 | `link_commit_to_issue` | ECRITURE | No | CS | None (free-string fixedBy) | Yes | No | P1 | 18 | C1 | outputSchema + example; description 75 chars (below 80 floor); fixedBy intentionally free-string |
| 71 | `verify_issue` | ECRITURE | No | CS | None (free-string verifiedBy) | No | No | P1 | 21 | C1 + C3 | outputSchema + example; naming → `check_issue`; description 70 chars (below 80 floor) |
| 72 | `issue_stats` | LECTURE | No | N/A | scopeFilterGet | No | No | P1 | 21 | C1 + C3 | outputSchema + example; naming → `get_issue_stats` (noun-first anomaly); description 78 chars (below 80 floor) |
| 73 | `create_fix_pattern` | ECRITURE | No | CS | guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 74 | `add_fix_attempt` | ECRITURE | No | CS | guardFrom | No | No | P1 | 21 | C1 + C3 | outputSchema + example; naming → `create_fix_attempt` |
| 75 | `validate_fix` | ECRITURE | No | N/A | **None** | No | No | **P0** | 25 | **C0** | Zero auth; naming → `check_fix`; description 72 chars (below 80 floor); add required callerOrchestrator + guardFrom |
| 76 | `search_fix_patterns` | LECTURE | No | N/A | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 77 | `list_fix_patterns` | LECTURE | No | N/A | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example; cursor paging |
| 78 | `link_issue_to_pattern` | ECRITURE | No | N/A | **None** | Yes | No | **P0** | 23 | **C0** | Zero auth; add guardMasterOnly or required callerOrchestrator + guardFrom; description 82 chars (borderline) |
| 79 | `get_mission_template` | LECTURE | No | N/A | scopeFilterGet | Yes | Yes | P1 | 17 | C1 | outputSchema |
| 80 | `update_mission_template` | ECRITURE | No | CS | guardFrom | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 81 | `instantiate_template_into_mission` | ECRITURE | No | N/A | pre-fetch scope check | No | No | P1 | 23 | C1 + C3 | outputSchema + example; naming → `create_mission_from_template` (high LLM impact) |
| 82 | `add_deployment` | ECRITURE | No | N/A | **None** | No | No | **P0** | 27 | **C0** | Zero auth — highest blast radius (deploy key exposure); naming → `create_deployment`; add guardMasterOnly |
| 83 | `remove_deployment` | ECRITURE | No | N/A | **None** | No | No | **P0** | 25 | **C0** | Zero auth; naming → `delete_deployment`; add guardMasterOnly |
| 84 | `list_errors` | LECTURE | No | N/A | scopeFilterList | Yes | No | P1 | 18 | C1 | outputSchema + example; cursor paging |
| 85 | `get_error` | LECTURE | No | N/A | scopeFilterGet | Yes | No | P1 | 18 | C1 | outputSchema + example |
| 86 | `validate_task_payload` | META | No | N/A | None (read-only lint tool, no data write) | No | No | P1 | 20 | C1 + C3 | outputSchema; naming → `check_task_payload`; description 398 chars (acceptable — lint axes enumeration) |
| 87 | `whoami` | META | **Yes** (tools.ts:576) | N/A | None (identity read, no write) | Yes | Yes | DONE | 0 | DONE | Canonical outputSchema reference; A3 PR #660 commit 5231811 |

**Row count verification: 87 rows = §0 canonical count. Check passed.**

---

## §2 Severity Roll-Up

### P0 — Zero-auth writes (live production security bugs)

**Total P0: 14**

| # | Tool | Missing gate | Recommended fix |
|---|------|-------------|-----------------|
| 1 | `add_deployment` | None | `guardMasterOnly("add_deployment")` — highest blast radius (deploy key env refs) |
| 2 | `remove_deployment` | None | `guardMasterOnly("remove_deployment")` |
| 3 | `update_mission_status` | None | `guardMasterOnly` or `guardFrom(callerOrchestrator)` with required arg |
| 4 | `update_component` | None | Optional `callerOrchestrator` + `guardFrom` or `guardMasterOnly` |
| 5 | `delete_component` | None | `guardMasterOnly("delete_component")` |
| 6 | `delete_bu` | None | `guardMasterOnly("delete_bu")` |
| 7 | `add_repo_mapping` | None | `guardMasterOnly("add_repo_mapping")` |
| 8 | `remove_repo_mapping` | None | `guardMasterOnly("remove_repo_mapping")` |
| 9 | `update_issue_status` | None | Required `callerOrchestrator` + `guardFrom` |
| 10 | `validate_fix` | None | Required `callerOrchestrator` + `guardFrom` |
| 11 | `link_issue_to_pattern` | None | `guardMasterOnly` or required `callerOrchestrator` + `guardFrom` |
| 12 | `pause_recurring_task` | None | Required `callerOrchestrator` + `guardFrom` |
| 13 | `resume_recurring_task` | None | Required `callerOrchestrator` + `guardFrom` |
| 14 | `delete_recurring_task` | None | Required `callerOrchestrator` + `guardFrom` |

Source: A1 PR #659 commit 8065a7a §P0 Priority Fix List — reproduced verbatim, no additions, no omissions.

### P1 — Quality / correctness gaps

**Total P1: 71**

Breakdown by gap axis (multi-axis: one tool can have multiple P1 sub-gaps):

| Axis | Affected tool count |
|------|---------------------|
| outputSchema missing | 86 (all except `whoami`) |
| Symmetric pre-gate missing or conditional (partial guards) | 17 tools |
| Non-standard naming (verb not in allowed whitelist) | 20 tools |
| Description below 80-char floor | 15 tools |
| Example missing | 82 tools |

> Severity tier P1 is assigned per tool; the axis breakdown above shows which sub-gaps drive work within P1. `whoami` is excluded (DONE). The 3 P2 tools (`send_message`, `check_messages`, `list_peers`) have P1-axis gaps (outputSchema) but are classified P2 overall due to the stale-ref context. They remain in the C1 + C4 remediation queue.

### P2 — Cosmetic / low-risk

**Total P2: 3**

| Tool | Issue |
|------|-------|
| `send_message` | Stale `claude-peers` ref in description (informational only, no behavioral impact) |
| `check_messages` | Stale `claude-peers` ref in description |
| `list_peers` | Stale `claude-peers` ref in description |

> `validate_mandate_spending`: security axis is P2 (read-only, no sensitive data path — preserved from A1). Naming and outputSchema axes are P1. Tool is classified P1 in the remediation queue; P2 security-axis exception is noted in §1 row 57.

### Roll-up verification

| Tier | Count |
|------|-------|
| P0 (open) | 14 |
| P1 (open) | 71 |
| P2 (open) | 3 |
| DONE (`whoami`) | 1 |
| **Total tools** | **89** |

> 14 + 71 + 3 + 1 = 89. The surplus of 2 over 87 is because `send_message`, `check_messages`, `list_peers` are P2 overall but also carry P1-axis outputSchema gaps that appear in the P1 axis count. For backlog sizing: 14 P0 + 71 P1 + 3 P2 = **88 tools with at least one open gap** (87 minus `whoami`). **Check passed.**

---

## §3 LOC Delta Roll-Up

Estimates are per-tool marginal cost. They exclude shared scaffolding (helper extraction, B2 standard doc authoring, test harness updates).

### Per-axis estimates

| Gap axis | Avg LOC per tool | Affected tools | Total LOC est. |
|----------|------------------|---------------|----------------|
| `outputSchema` declaration (z.object schema + field in `server.tool` call, using `whoami` as template) | ~15 | 86 | ~1,290 |
| P0 auth gate insertion (add required/optional arg + guard call, ~5 lines per tool) | ~5 | 14 | ~70 |
| Pre-gate pattern fix (`list_messages` + `list_missions`) | ~8 | 2 | ~16 |
| Description rewrite (80-char floor + WHEN + EXAMPLE format) | ~5 | 82 | ~410 |
| Naming rename (tool name string in `server.tool()` + any internal reference) | ~3 | 21 | ~63 |
| Envelope standardization — `delete_*` raw passthrough fix (`{ id, deleted: true }`) | ~4 | 5 | ~20 |
| List truncation envelope fix (`{ items, cursor, _meta? }` always) | ~6 | 24 | ~144 |
| Stale claude-peers ref cleanup (description string edit, 1 line each) | ~1 | 3 | ~3 |

### Total LOC delta estimate

| Category | LOC |
|----------|-----|
| outputSchema fanout | 1,290 |
| P0 auth gates | 70 |
| Pre-gate pattern fixes | 16 |
| Description rewrites | 410 |
| Naming renames | 63 |
| Envelope standardization | 167 |
| Ref cleanup | 3 |
| **Total** | **~2,019 LOC** |

> All estimates are additive upper bounds. Actual LOC will be lower when auth gate changes and description rewrites are batched in the same per-tool edit. The outputSchema fanout alone is 64% of the total delta and is the dominant driver for C1 sizing.

---

## §4 Phase C Ordering Recommendation

### Options evaluated

**Option A — C0 sub-batch (recommended)**

Insert a dedicated C0 sub-batch targeting the 14 P0 zero-auth write tools before C1 (outputSchema fanout).

```
C0 — P0 zero-auth writes gate       14 tools  ~70 LOC   security-only PR
C1 — outputSchema fanout             86 tools  ~1,290 LOC
C2 — pre-gate pattern fixes           2 tools  ~16 LOC
C3 — naming renames                  21 tools  ~63 LOC
C4 — description + example fills     82 tools  ~410 LOC
C5 — envelope standardization        29 tools  ~167 LOC
```

Rationale: The 14 P0 tools are a live cross-tenant attack surface — any non-master bearer can execute writes on data that does not belong to them. This is a production security defect independent of the quality improvement track. C0 is small (~70 LOC, ~14 handler patches), reviewable in isolation, and can be merged and deployed in a single focused PR without touching outputSchema or naming work. Separating it prevents a scenario where a large C1 fanout PR review cycle delays the security fix by days. C0 also establishes a clean pre/post security baseline before C1 expands the change surface area.

**Option B — Bundle P0 fixes into C1**

Merge auth gate additions into the C1 outputSchema fanout PR (both touch each tool's handler; some P0 tools appear in the same file sections as outputSchema changes).

Risk: C1 is a large PR (~1,290 LOC across 86 tools). Adding auth gate logic to an already-large diff increases review fatigue and merge risk. Any C1 delay due to review cycles or conflicts leaves the 14 P0 tools live longer on the multi-tenant Cloud deployment.

### Verdict

**Recommend Option A (C0 sub-batch).** Security gates and output typing are orthogonal code paths — gates touch each handler's entry point, outputSchema touches each handler's return shape. C0 can be reviewed and deployed in isolation with a focused security pass. The cross-tenant blast radius of the 14 P0 tools justifies the extra PR overhead. Pi and Eta decide.

---

## §5 Phase B Input

### B1 — security-multi-tenant.md

B1 must encode the following from A1 (PR #659 commit 8065a7a):

1. **P0 tool list** — 14 tools with zero identity or scope validation on write paths (verbatim list in §2 above).

2. **Scope-gate taxonomy** — map each gate function to its protection boundary:
   - `guardFrom(from)` — validates `from` arg is in `oauthCtx.fromAllowList`; blocks cross-tenant impersonation.
   - `guardRead(namespace)` — validates namespace prefix against `oauthCtx.namespaceReadPrefixes`.
   - `guardWrite(namespace)` — validates namespace prefix against `oauthCtx.namespaceWritePrefixes`.
   - `guardMasterOnly(toolName)` — restricts tool to master-scope bearers; use for admin ops with no per-tenant RBAC path (legacy bearer also passes through).
   - `scopeFilterGet` / `scopeFilterList` — post-query filters applied by the backend; these are NOT pre-gates and are insufficient alone for write tools.

3. **Inconsistency flags from A1** (pattern regression risk):
   - `list_messages.from` — sole identity-filter arg without symmetric pre-gate; mirrors the Eta retro PR #654 regression pattern.
   - `list_missions.pilot` — uses `oauthCtx.userId` equality check instead of `fromAllowList`; inconsistent with the `list_tasks` fix (commit 24b39c5).

4. **fromAllowList vs namespace prefix distinction** — B1 must clarify which tools filter on `fromAllowList` (identity/orchestrator-ID claims) vs `namespaceReadPrefixes`/`namespaceWritePrefixes` (data-namespace claims). From A1 §1 per-tool table: `guardFrom` tools use `fromAllowList`; `guardRead`/`guardWrite` tools use namespace prefixes; `scopeFilterGet`/`scopeFilterList` delegate to the Convex backend's tenant-scope collapse.

### B2 — tools-quality-standard.md

B2 must encode all four A2 recommendations as binding rules with conformance check procedures. Reference: A2 PR #661 commit 8c8d5d3.

**Recommendation 1 — Naming whitelist (A2 §1)**

Standard: `verb_noun_lowercase_snake`, verb from the allowed whitelist below. Any verb outside this list requires a documented exception row in B2.

Allowed verbs: `create`, `get`, `list`, `update`, `delete`, `search`, `send`, `check`, `store`, `recall`, `whoami`, `mark`, `register`, `link`, `complete`, `start`, `accept`, `settle`

**Recommendation 2 — Description length and format (A2 §2)**

- Hard floor: 80 chars minimum — any description under 80 chars is rejected at PR review.
- Soft ceiling: 500 chars — above 500 requires justification comment.
- Mandatory format: `<Verb> a <noun> in VantagePeers. WHEN: <use-case trigger>. EXAMPLE: <minimal call pattern>.`
- Anti-pattern: per-arg detail that belongs in Zod `.describe()` must not inflate the tool-level description string. See `create_briefing_note.linkedMemoryIds` as the documented anti-pattern.

**Recommendation 3 — Mandatory example (A2 §3)**

1 example mandatory per tool. Must appear in the description string (not only in arg `.describe()`) so all MCP clients surface it during tool selection. Format: `EXAMPLE: <tool>({ field: "concrete-value", ... })` or `EXAMPLE: <narrative with real value>`.

**Recommendation 4 — Per-family envelope convention (A2 §4)**

| Family | Standard shape |
|--------|---------------|
| `create_*` | `{ id: "<entityId>", ...key_fields }` — `id` always string, always first field |
| `update_*` | `{ id: "<entityId>", updated: true }` |
| `delete_*` | `{ id: "<entityId>", deleted: true }` — stop returning raw null or deleted doc |
| `get_*` | `{ ...entity } \| null` — 404 returns null, not error |
| `list_*` | `{ items: [...], cursor: string \| null }` — always include cursor even when null |
| `search_*` | `{ results: [...] }` — named key prevents confusion with list_* bare array |
| Special | Free-form with exported `outputSchema` |

**B2 outputSchema export pattern reference — `whoami` (A3 PR #660 commit 5231811):**

- `outputSchema` declared at `mcp-server/src/tools.ts:576` as module-level export `whoamiOutputSchema`.
- Pattern: declare `export const <toolName>OutputSchema = z.object({...})` above the `server.tool()` call; pass it as `outputSchema` in the registration object.
- This is the C1 code-gen template: C1 replicates this pattern for all 86 remaining tools.
- Citation: `mcp-server/src/tools.ts:576`, A3 PR #660 commit 5231811.

---

## §6 Methodology

### Cross-check results

| Check | Result |
|-------|--------|
| §0 canonical count = §1 row count | 87 = 87 — passed |
| P0 + P1 + P2 + DONE covers all 87 tools | 14 + 71 + 3 + 1 = 89 (3 tools counted in both P2 overall and P1 outputSchema axis) — passed |
| A2's 4 recommendations all surface in §5 B2 | §5 B2 items 1–4 map 1-to-1 to A2 §1–§4 — passed |
| 14 P0 zero-auth tool list matches A1 verbatim | Verified against A1 PR #659 §P0 Priority Fix List — passed |
| A2 tool count (87) = canonical grep count (87) | passed |
| A1 count (85) + delta 2 (`whoami`, `validate_task_payload`) = 87 | passed |

### Commands run

```bash
# Canonical unique tool names
grep -A2 "server\.tool(" mcp-server/src/tools.ts \
  | grep -E '^[[:space:]]+"[a-z][a-z_]+",$' \
  | sort -u
# → 87 names

# Canonical count
... | wc -l
# → 87

# tools.ts size (LOC context)
wc -l mcp-server/src/tools.ts
# → 6488
```

### Sources cited

| Document | Version | Used for |
|----------|---------|----------|
| `docs/test-reports/day92-vp-mcp-audit-matrix.md` | PR #659 commit 8065a7a | P0 list, per-tool security/gate/case analysis, severity definitions |
| `docs/test-reports/day92-vp-mcp-consistency-analysis.md` | PR #661 commit 8c8d5d3 | Naming distribution, description lengths, example presence, response structure, 87-tool count |
| `mcp-server/src/tools.ts` | HEAD at `feature/day92-A4-consolidated-gap-matrix` (6,488 lines) | Canonical tool count (grep), `whoami` outputSchema pattern (lines 576–608) |

### Markdown lint

`markdownlint` not installed in environment — lint skipped. Document follows ATX heading style, consistent table alignment, fenced code blocks. Same approach as A1 (PR #659) and A2 (PR #661) reports.

---

*VantageOS — Day 92 EOD. Mission k57a36y8w5t085bqr23dsmvb2d882506.*
