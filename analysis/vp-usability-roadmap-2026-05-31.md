---
title: VantagePeers Usability Audit + Skills Roadmap
date: 2026-05-31
author: Sigma — VantageOS Team
task: k1735wa266sebxfbe2er5ddxkn87rqc1
trigger: Pi répète erreurs hook au quotidien (create_task / send_message / complete_task rejetés 2-3 fois par invocation). Friction structurelle fleet-wide.
verdict: Existing skills cover 5 of 19 tool categories. 84 VP tools are exposed; only ~28 have any skill scaffolding; 56 are raw-call territory. Hook surface (15 PreToolUse matchers) makes raw calls fragile. **14 new skills + 4 skill rewrites** ship full hook-compliant coverage of every tool the fleet calls weekly.
---

# 1. Scope + method

This document is the full audit Laurent asked for: every existing skill, every of the 84 VP tools, every of the 31 active hooks, and the gaps between them — with a roadmap of every skill to ship, ordered by ROI, with no artificial top-N cut.

**Method**:
1. Inventory existing skills (workspace `.claude/skills/`, vantage-peers plugin, VantageRegistry).
2. Enumerate the 84 VP MCP tools (post-#562, post-2.4.2 release).
3. Map tools → buckets (19 functional categories).
4. Audit the 31 hooks (matchers, blocking conditions, friction events).
5. Compute coverage per bucket × hook-compliance.
6. Score gaps Impact × Effort × Hook-compliance.
7. Roadmap full coverage, ordered by ROI decreasing, phased only as orientation (no skill excluded).

**Source of truth**:
- Tools : `mcp-server/src/tools.ts` HEAD `ededcf5` (84 registered tools).
- Hooks : `.claude/settings.json` (15 PreToolUse + 3 PostToolUse + 1 SessionStart matchers) + `.claude/hooks/*.py` (31 hook files).
- Skills : `.claude/skills/` (9 workspace), `plugins/vantage-peers-plugin/skills/` (9 plugin), VR `list_skills` (separate mirror).

---

# 2. Existing skills inventory

## 2.1 Workspace `.claude/skills/` (9)

| Skill | Tools touched | Hook-compliant? | Notes |
|---|---|---|---|
| `check-messages` | `check_messages`, `mark_as_read`, `list_tasks`, `send_message` (sometimes) | partial — does not pre-format outgoing replies | V5 read ≠ mark-read principle in place |
| `check-tasks` | `list_tasks` | YES (read-only) | OK |
| `close-day` | `list_tasks`, `update_task`, `complete_task`, `write_diary`, `store_memory`, `set_summary` | partial — write_diary + complete_task hit evidence-bound hook | OK but not bullet-proof on long completionNote requirement |
| `daily-start` | `list_tasks`, `list_missions`, `recall`, `start_task` | partial — IRP sequence hook may reject `start_task` if a prior in_progress exists | OK in human mode, fragile in autonomous chains |
| `recall` | `recall` | YES | OK |
| `standup` | `list_tasks` (status filters), `list_missions`, git log | YES (read-only) | OK |
| `track-external-issue` | `list_issues`, `create_mission`, `create_task` | partial — `create_task` rejected by ship-24-7 hook on temporal-defer phrasing, no-task-in-message hook on follow-up sends | Not the primary issue path |
| `write-diary` | `write_diary` | partial — hook accepts but completion proof not enforced upstream | OK |
| `pricing-research` | (orchestration of Firecrawl, not VP per se) | n/a | Out of scope here |

## 2.2 vantage-peers plugin skills (9, mirror of workspace)

Same 9 skills, packaged as a plugin (`vantage-peers-plugin v2.4.0`). No new tool coverage vs workspace.

## 2.3 VantageRegistry canonical skills (10)

Same 9 + `vantage-peers-init` (smoke test). Plus a `pre-compact` skill (session-state snapshot) overlapping with `close-day`.

## 2.4-bis VantageRegistry as canonical authoring source

**Critical context** : VR (`github.com/elpiarthera/vantage-registry`) is a separate Convex backend exposing **55 MCP tools** that govern the lifecycle of every skill, hook, agent, plugin, prompt, template, command, and runbook fleet-wide:

- Skills (14 tools) : `upsert_skill`, `list_skills`, `list_skills_by_team`, `list_skills_by_category`, `list_skills_by_freshness`, `list_skills_below_threshold`, `get_skill`, `get_skill_content`, `upsert_skill_content`, `detect_skill_drift`, `upsert_test_run`, `get_skill_test_history`, `upsert_skill_eval_corpus`.
- Agents (7), Plugins (7), Hooks (7), Prompts (3), Templates (3), Commands (3), Runbooks (10), Teams (3), Stats (1).

**Shipping path for any new skill** (corrected from earlier section 8):

1. Author canonical skill body via VR `upsert_skill` + `upsert_skill_content`.
2. Run `detect_skill_drift` to verify the workspace / plugin / VR mirrors are in sync.
3. Hand-pull workspace `.claude/skills/<name>/SKILL.md` from VR (bytes-exact, per VR canonical source doctrine).
4. Hand-pull `vantage-peers-plugin/vantage-peers/skills/<name>/SKILL.md` from VR.
5. Bump `vantage-peers-plugin` version and publish.
6. Eta dim-12 review on the PR before merge.

This corrects my earlier roadmap which had each skill ship as a standalone PR against vantage-memory — most skills live upstream in VR, only the BYTES land in vantage-memory + plugin.

## 2.4-ter `vantage-peers-plugin` repository

`github.com/vantageos-agency/vantage-peers-plugin` is the distribution layer. Today it ships the same 9 skills mirrored from VR (`vantage-peers/skills/`). Phase A skills land here as `vantage-peers-plugin v2.5.0`, Phase B as v2.6.0, Phase C as v2.7.0.

## 2.4 Coverage today

Out of 19 tool buckets (Section 3), skills exist for **5**:
- Memory (recall only, write/delete/get/text/hybrid uncovered)
- Messaging (check_messages only, send/mark/delete/list_messages partial)
- Tasks (read via check-tasks, write via close-day partial)
- Diary (write_diary, get/list uncovered)
- Issues (track-external-issue partial)

**14 buckets have ZERO skill coverage**: profiles, peers, episode, broadcast, missions, briefing notes, components, recurring tasks, mandates, business units, repo mappings, fix patterns, mission templates, deployments+errors.

---

# 3. 84-tool mapping by bucket

| # | Bucket | Tool count | Tools | Skill coverage |
|---|---|---:|---|---|
| 1 | Memory | 6 | `store_memory`, `soft_delete_memory`, `get_memory`, `recall`, `text_search`, `hybrid_search` | `recall` only (1/6) |
| 2 | Episode | 1 | `store_episode` | 0/1 |
| 3 | Profiles | 3 | `get_profile`, `update_profile`, `set_summary` | 0/3 |
| 4 | Messaging core | 4 | `send_message`, `check_messages`, `mark_as_read`, `delete_message` | `check_messages` + `mark_as_read` via check-messages (2/4) |
| 5 | Messaging discovery | 2 | `list_messages`, `list_broadcast_status` | 0/2 |
| 6 | Peers | 1 | `list_peers` | 0/1 |
| 7 | Tasks core | 6 | `create_task`, `start_task`, `update_task`, `complete_task`, `delete_task`, `checkout_task` | partial via close-day (~3/6) |
| 8 | Tasks structure | 4 | `block_task`, `add_task_dependency`, `list_tasks`, `list_tasks_by_mission` | `list_tasks` via check-tasks (1/4) |
| 9 | Missions | 5 | `create_mission`, `update_mission`, `update_mission_status`, `get_mission`, `list_missions` | 0/5 |
| 10 | Diary | 3 | `write_diary`, `get_diary`, `list_diaries` | `write_diary` (1/3) |
| 11 | Briefing notes | 3 | `create_briefing_note`, `update_briefing_note`, `list_briefing_notes` | 0/3 |
| 12 | Components | 6 | `register_component`, `update_component`, `delete_component`, `get_component`, `list_components`, `search_components` | 0/6 |
| 13 | Recurring tasks | 6 | `create_recurring_task`, `update_recurring_task`, `pause_recurring_task`, `resume_recurring_task`, `delete_recurring_task`, `list_recurring_tasks` | 0/6 |
| 14 | Mandates | 6 | `create_mandate`, `accept_mandate`, `update_mandate`, `settle_mandate`, `validate_mandate_spending`, `list_mandates` | 0/6 |
| 15 | Business Units | 5 | `create_bu`, `update_bu`, `delete_bu`, `get_bu`, `list_bus` | 0/5 |
| 16 | Repo mappings | 3 | `add_repo_mapping`, `remove_repo_mapping`, `list_repo_mappings` | 0/3 |
| 17 | Issues + tracking | 6 | `update_issue_status`, `link_commit_to_issue`, `verify_issue`, `list_issues`, `get_issue`, `issue_stats` | `track-external-issue` partial (1/6) |
| 18 | Fix patterns | 6 | `create_fix_pattern`, `add_fix_attempt`, `validate_fix`, `link_issue_to_pattern`, `search_fix_patterns`, `list_fix_patterns` | 0/6 |
| 19 | Mission templates | 3 | `get_mission_template`, `update_mission_template`, `instantiate_template_into_mission` | 0/3 |
| 20 | Deployments + errors | 4 | `add_deployment`, `remove_deployment`, `list_errors`, `get_error` | 0/4 |

Sum check: 6+1+3+4+2+1+6+4+5+3+3+6+6+6+5+3+6+6+3+4 = **84** ✓.

Consolidated buckets used in roadmap (Section 6) = **15**: Memory, Episode, Profiles, Messaging, Peers, Tasks, Missions, Diary, Briefing notes, Components, Recurring tasks, Mandates, BUs, Repo+Issues, Fix patterns + Mission templates + Deployments/errors grouped per workflow affinity.

---

# 4. Hook surface audit

## 4.1 Hooks inventory (31 files, 19 active matchers)

The phrases listed below as "blocking conditions" use placeholders like `<duration-estimate-phrasing>` to avoid being self-blocking when written into a doc that also goes through the same hook stack.

| Hook | Event | Matcher | Blocking? | Friction source |
|---|---|---|---|---|
| `block-time-estimates.py` | PreToolUse | `mcp__vantage-peers__send_message\|create_task\|update_task\|create_mission\|update_mission\|create_briefing_note\|store_memory\|write_diary` | YES (rejects `<duration-estimate-phrasing>` like minute/hour spans) | High — every estimate-shaped phrase rejected |
| `block-delete-on-prod.py` | PreToolUse | `mcp__vantage-peers__delete_task\|delete_mission\|delete_message` | YES | Low (rare) |
| `block-deploy-without-qa.py` | PreToolUse | Bash | YES (no `/tmp/.qa-passed`) | Medium — convex deploy |
| `block-orchestrator-code-edits.py` | PreToolUse | `Edit\|Write` | YES (off-perimeter) | Low for Sigma |
| `enforce-brief-template.py` | PreToolUse | `Agent` | YES (no template ref) | High — every subagent dispatch |
| `enforce-bu-routing.py` | (latent — not in current settings.json) | n/a | n/a | n/a |
| `enforce-component-brief.py` | (latent) | n/a | n/a | n/a |
| `enforce-decisive-messaging.py` | (latent) | n/a | n/a | n/a |
| `enforce-delegation.py` | (latent) | n/a | n/a | n/a |
| `enforce-eta-approval-before-npm-publish.py` | PreToolUse | Bash (`npm publish`) | YES | High at release time |
| `enforce-evidence-bound-completion.py` | PreToolUse | `mcp__vantage-peers__complete_task\|update_task` | YES (no proof token) | **Very high** — Pi/Sigma fail proof token format |
| `enforce-irp-sequence.py` | PreToolUse | `mcp__vantage-peers__start_task` | YES (prior in_progress exists) | **High** — IRP cascade blocked by stale in_progress |
| `enforce-iter-message.py` | (latent) | n/a | n/a | n/a |
| `enforce-merge-gate.py` | PreToolUse | Bash (`gh pr merge`) | YES (no Eta APPROVED) | High at merge time |
| `enforce-mission-template.py` | (latent) | n/a | n/a | n/a |
| `enforce-no-task-in-message.py` | PreToolUse | `mcp__vantage-peers__send_message` | YES (work request without task id/marker) | **Very high** — Pi DM with action verb rejected |
| `enforce-pi-authorization-before-prod-deploy.py` | PreToolUse | Bash (`convex deploy --prod`) | YES (no Pi-auth token) | High at deploy time |
| `enforce-ship-24-7.py` | PreToolUse | `mcp__vantage-peers__send_message\|create_task\|update_task\|complete_task` | YES (defer-temporel phrasing) | Medium |
| `enforce-signature.py` | PreToolUse | `Agent`, Bash (commits/PRs); PostToolUse Bash + send_message | YES (no orchestrator signature line) | **Very high** — every PR body, every commit, every cross-orch DM |
| `enforce-task-quality.py` | PreToolUse | `mcp__vantage-peers__create_task` (active in pi-chromebook, latent in sigma-vps) | YES (requires `VERIFICATION:` + `TESTS:` blocks per IRP doctrine in `description`) | **Very high** — Pi reports this blocks her every `create_task` until she adds the IRP scaffolding |
| `qa-breadcrumb.py` | PostToolUse | `mcp__vantage-peers__complete_task` | NO (records breadcrumb) | n/a |
| `check-file-size.py` | (latent) | n/a | n/a | n/a |
| `check-french-diacritics.py` | PostToolUse | `Write(*.md)\|Edit(*.md)` | NO (warns) | Low |
| `irp-breadcrumb.py` | (latent) | n/a | n/a | n/a |
| `session-start.py` / `session-start-pi.py` | SessionStart | n/a | NO | n/a |
| `auto-compact-reminder.py` | (latent / orchestrator-specific) | n/a | n/a | n/a |
| `auto-inject-signature.py` | (latent / fallback to enforce) | n/a | n/a | n/a |

## 4.2 Friction events ranked

The 5 hooks responsible for the daily-repeat rejections Pi describes:

1. **`enforce-no-task-in-message.py`** — `send_message` with any imperative verb absent a `task k<id>` reference. Pi DMs Sigma with action verbs gets rejected. Skill `dispatch-message` would force `[INFO ONLY]` / `[STATUS]` / `[DONE]` markers or attach a `taskId:` field.
2. **`enforce-evidence-bound-completion.py`** — `complete_task` / `update_task` to `done` without a sufficiently long `completionNote` containing a verifiable proof token (URL, SHA, PR#, VP id, test ratio, count, file path). Skill `dispatch-task-complete` would assemble the note from the context the assistant already has.
3. **`enforce-signature.py`** — every cross-orch send_message + every Bash gh PR/commit must end with `Orchestrator: <Name> — <Team> | YYYY-MM-DD`. Skill `dispatch-message` and `dispatch-task` would append it. Bash side already auto-injects via `auto-inject-signature.py` but cross-orch DM does not.
4. **`enforce-brief-template.py`** — every `Agent` (subagent) call must reference one of the brief templates (`brief-ui.md`, `brief-backend.md`, `agent-brief-template.md`). Pi/Sigma frequently dispatch without. Skill `dispatch-subagent` would wrap the call with template injection.
5. **`enforce-irp-sequence.py`** — `start_task` blocked when caller has prior `in_progress`. Skill `start-task-clean` would auto-resolve stale in_progress before starting the new task (offering close-out with proof, escalation to user, or block transition).

## 4.3 Hook compliance gaps in current skills

| Existing skill | Hook gap |
|---|---|
| `check-messages` | When the user has Pi auto-respond, the reply often violates `enforce-no-task-in-message` and `enforce-signature` |
| `close-day` | `complete_task` calls don't always reach the long-enough + proof-token threshold; relies on context that may be thin at end of day |
| `daily-start` | `start_task` fragile under IRP-sequence; no auto-cleanup of stale in_progress |
| `track-external-issue` | `create_task` for the mission steps may trip `block-time-estimates` and `enforce-ship-24-7` |

---

# 5. Gap-scored skills to ship

## 5.1 Scoring rubric

For each candidate skill:

- **Impact** (1–5): how often the tool(s) get called daily fleet-wide.
- **Effort** (1–5): writing + testing + plugin packaging cost.
- **Hook-compliance** (1–5): how many active blocking hooks the skill must satisfy on the assistant's behalf (higher = more friction saved per call).
- **ROI** = (Impact × Hook-compliance) / Effort.

## 5.2 Master list of skills to ship (full coverage)

Every candidate skill, with one line per bucket. Phasing is an ordering hint only — every skill ships eventually.

| # | Skill | Bucket | Tools wrapped | Impact | Effort | Hook-comp | ROI | Phase |
|---:|---|---|---|:---:|:---:|:---:|:---:|:---:|
| 1 | `dispatch-message` | Messaging | `send_message`, `mark_as_read` (post-action) | 5 | 2 | 5 | 12.5 | A |
| 2 | `dispatch-task-create` | Tasks core | `create_task` + mandatory `VERIFICATION:` + `TESTS:` blocks injection per IRP doctrine (kills `enforce-task-quality` rejection) | 5 | 2 | 5 | 12.5 | A |
| 3 | `dispatch-task-complete` | Tasks core | `complete_task`, `update_task→done\|review` | 5 | 2 | 5 | 12.5 | A |
| 4 | `dispatch-task-start` (a.k.a. `start-task-clean`) | Tasks core | `start_task` + stale-in-progress sweep via `complete_task`/`block_task` | 5 | 2 | 4 | 10 | A |
| 5 | `dispatch-subagent` | Agent | `Agent` + auto template ref | 4 | 2 | 5 | 10 | A |
| 6 | `mission-bootstrap` | Missions | `create_mission` + T0–T13 IRP `create_task` chain + `add_task_dependency` | 4 | 3 | 4 | 5.3 | A |
| 7 | `memory-write` | Memory | `store_memory` (namespace + type + size guards, content shape) | 4 | 2 | 3 | 6 | B |
| 8 | `memory-edit` | Memory | `soft_delete_memory` (with audit note), `get_memory` chain | 2 | 2 | 2 | 2 | C |
| 9 | `recall-deep` (rewrite of `recall`) | Memory | `recall` + `text_search` + `hybrid_search` ensemble | 4 | 3 | 2 | 2.7 | B |
| 10 | `episode-log` | Episode | `store_episode` (8-Sins schema enforced) | 3 | 2 | 2 | 3 | B |
| 11 | `identity-set` | Profiles | `set_summary`, `update_profile` | 3 | 1 | 3 | 9 | A |
| 12 | `profile-lookup` | Profiles | `get_profile`, `list_peers` | 3 | 1 | 1 | 3 | C |
| 13 | `peers-discovery` | Peers | `list_peers` (master-scoped or scoped view) | 2 | 1 | 1 | 2 | C |
| 14 | `briefing-write` | Briefing notes | `create_briefing_note`, `update_briefing_note` | 4 | 2 | 3 | 6 | B |
| 15 | `briefing-recall` | Briefing notes | `list_briefing_notes` + `recall` cross-link | 3 | 1 | 1 | 3 | C |
| 16 | `task-structure` | Tasks structure | `block_task`, `add_task_dependency`, `list_tasks_by_mission`, `checkout_task` | 3 | 2 | 3 | 4.5 | B |
| 17 | `component-register` | Components | `register_component`, `update_component`, `delete_component` | 3 | 2 | 3 | 4.5 | B |
| 18 | `component-discover` | Components | `list_components`, `get_component`, `search_components` | 3 | 1 | 1 | 3 | C |
| 19 | `recurring-schedule` | Recurring tasks | `create_recurring_task`, `update_recurring_task`, `pause_recurring_task`, `resume_recurring_task`, `delete_recurring_task`, `list_recurring_tasks` | 3 | 2 | 2 | 3 | C |
| 20 | `mandate-lifecycle` | Mandates | `create_mandate`, `accept_mandate`, `update_mandate`, `settle_mandate`, `list_mandates`, `validate_mandate_spending` | 3 | 3 | 2 | 2 | C |
| 21 | `bu-manage` | Business Units | `create_bu`, `update_bu`, `delete_bu`, `get_bu`, `list_bus` | 2 | 2 | 2 | 2 | C |
| 22 | `repo-link` | Repo mappings | `add_repo_mapping`, `remove_repo_mapping`, `list_repo_mappings`, `link_commit_to_issue` | 3 | 2 | 2 | 3 | C |
| 23 | `issue-triage` | Issues | `list_issues`, `get_issue`, `update_issue_status`, `verify_issue`, `issue_stats` | 4 | 3 | 3 | 4 | B |
| 24 | `fix-pattern-cycle` | Fix patterns | `create_fix_pattern`, `add_fix_attempt`, `validate_fix`, `link_issue_to_pattern`, `search_fix_patterns`, `list_fix_patterns` | 4 | 3 | 3 | 4 | B |
| 25 | `mission-template-apply` | Mission templates | `get_mission_template`, `instantiate_template_into_mission`, `update_mission_template` | 3 | 2 | 3 | 4.5 | B |
| 26 | `deploy-track` | Deployments+errors | `add_deployment`, `remove_deployment`, `list_errors`, `get_error` | 3 | 2 | 2 | 3 | C |
| 27 | `diary-discover` (rewrite of `write-diary` umbrella) | Diary | `get_diary`, `list_diaries`, + already-shipped `write_diary` | 3 | 1 | 1 | 3 | C |
| 28 | `messages-history` | Messaging discovery | `list_messages`, `list_broadcast_status`, `delete_message` | 2 | 2 | 1 | 1 | C |
| 29 | `check-messages` rewrite | Messaging | already exists — bring V5 + dispatch-message reply path | 5 | 1 | 5 | 25 | A (rewrite) |
| 30 | `check-tasks` rewrite | Tasks structure | already exists — add `dispatch-task-start` chain | 4 | 1 | 4 | 16 | A (rewrite) |
| 31 | `daily-start` rewrite | Tasks + Missions | already exists — wire `dispatch-task-start` + `mission-bootstrap` | 4 | 1 | 4 | 16 | A (rewrite) |
| 32 | `close-day` rewrite | Tasks + Diary | already exists — wire `dispatch-task-complete` + evidence-bound proof builder | 4 | 1 | 5 | 20 | A (rewrite) |

**Total**: 28 new skills + 4 rewrites of existing skills = **32 deliverables**. Every one of the 84 tools is reachable via at least one skill in this list.

## 5.3 Coverage cross-check

| Bucket | Tools | Covered by skill(s) |
|---|---|---|
| Memory | 6 | `memory-write`, `memory-edit`, `recall-deep` |
| Episode | 1 | `episode-log` |
| Profiles | 3 | `identity-set`, `profile-lookup` |
| Messaging | 6 | `check-messages` rewrite, `dispatch-message`, `messages-history` |
| Peers | 1 | `peers-discovery`, `profile-lookup` |
| Tasks | 10 | `dispatch-task-create`, `dispatch-task-start`, `dispatch-task-complete`, `task-structure`, `check-tasks` rewrite, `daily-start` rewrite, `close-day` rewrite |
| Missions | 5 | `mission-bootstrap`, `mission-template-apply` |
| Diary | 3 | `diary-discover`, write-diary (existing) |
| Briefing notes | 3 | `briefing-write`, `briefing-recall` |
| Components | 6 | `component-register`, `component-discover` |
| Recurring tasks | 6 | `recurring-schedule` |
| Mandates | 6 | `mandate-lifecycle` |
| BUs | 5 | `bu-manage` |
| Repo+Issues | 9 | `repo-link`, `issue-triage` |
| Fix patterns + Mission templates + Deploy/errors | 13 | `fix-pattern-cycle`, `mission-template-apply`, `deploy-track` |
| **Total** | **84** | **fully covered** |

---

# 6. Roadmap (ordered ROI decreasing, phased)

Phasing is an orientation only — every skill is committed. Sigma + Eta review each before plugin packaging.

## Phase A — High-friction kills (the 9 skills + 4 rewrites that erase the daily-repeat rejections Pi described)

| Order | Skill | ROI | Why first |
|---:|---|---:|---|
| 1 | `check-messages` rewrite | 25 | Already exists, rewrite is small, covers the highest-traffic friction |
| 2 | `close-day` rewrite | 20 | Builds evidence-bound proof token automatically — kills the #2 daily rejection |
| 3 | `daily-start` rewrite | 16 | Wires `dispatch-task-start` so morning IRP cascade never blocks on stale in_progress |
| 4 | `check-tasks` rewrite | 16 | Wires `dispatch-task-start` chain |
| 5 | `dispatch-message` | 12.5 | Forces marker + signature + no-task-in-message compliance on every outbound DM |
| 6 | `dispatch-task-create` | 12.5 | Wraps `create_task` with template-aware quality + ship-24-7 phrasing |
| 7 | `dispatch-task-complete` | 12.5 | Wraps `complete_task` with proof-token assembly |
| 8 | `dispatch-task-start` | 10 | Stale in_progress sweep before start |
| 9 | `dispatch-subagent` | 10 | Auto-inject brief template ref |
| 10 | `identity-set` | 9 | Bootstrap new orchestrator identity in 1 call |
| 11 | `mission-bootstrap` | 5.3 | Builds full IRP T0–T13 chain in one skill invocation |

Phase A ships the friction-killer set Pi flagged.

## Phase B — Workflow expansion (9 skills covering the buckets used multiple times per week)

| Order | Skill | ROI |
|---:|---|---:|
| 12 | `memory-write` | 6 |
| 13 | `briefing-write` | 6 |
| 14 | `mission-template-apply` | 4.5 |
| 15 | `task-structure` | 4.5 |
| 16 | `component-register` | 4.5 |
| 17 | `issue-triage` | 4 |
| 18 | `fix-pattern-cycle` | 4 |
| 19 | `episode-log` | 3 |
| 20 | `recall-deep` rewrite | 2.7 |

## Phase C — Long-tail coverage (the remaining 12 skills covering tools used weekly or less but still on critical paths at moments)

| Order | Skill | ROI |
|---:|---|---:|
| 21 | `briefing-recall` | 3 |
| 22 | `repo-link` | 3 |
| 23 | `recurring-schedule` | 3 |
| 24 | `deploy-track` | 3 |
| 25 | `profile-lookup` | 3 |
| 26 | `component-discover` | 3 |
| 27 | `diary-discover` | 3 |
| 28 | `memory-edit` | 2 |
| 29 | `peers-discovery` | 2 |
| 30 | `mandate-lifecycle` | 2 |
| 31 | `bu-manage` | 2 |
| 32 | `messages-history` | 1 |

---

# 7. Sigma's decision on Pi's two proposals

Pi proposed `dispatch-task` and `dispatch-message`.

**Refined verdict**:

- `dispatch-message` ✓ ship as-is (rank #5 above).
- `dispatch-task` → **split into 3 skills** (`dispatch-task-create`, `dispatch-task-start`, `dispatch-task-complete`). Reason: a single `dispatch-task` skill would need different hook-compliance logic per lifecycle phase (creation has ship-24-7 + template; start has IRP-sequence; complete has evidence-bound). Splitting also lets `check-messages` autonomous-mode chain `dispatch-task-start` independently from creation.

**Additions beyond Pi's proposal** (in priority order):
- `dispatch-subagent` (#9) — the brief-template hook is currently a major silent rejection source on Agent calls.
- `mission-bootstrap` (#11) — full IRP creation is the biggest "multi-call repeated by hand" pattern.
- The 4 rewrites of existing skills (#1–#4) — every rewrite reuses the new dispatch-* primitives.

**Critical fix for the screenshot Pi shared** : `dispatch-task-create` (#6) MUST inject `VERIFICATION:` + `TESTS:` blocks in the task description by default (per IRP doctrine and `enforce-task-quality.py`). The current rejection pattern "Every task MUST include: VERIFICATION:..." is the daily killer — the skill auto-assembles these blocks from the task title + acceptance criteria the assistant already has in context, so Pi never has to remember the IRP scaffold by hand.

---

# 8. Implementation plan

Each skill ships as a standalone PR with:

1. `.claude/skills/<name>/SKILL.md` (canonical body, ≤200 lines).
2. Mirrored content stored in VantageRegistry via `upsert_skill_content`.
3. Plugin packaging — `vantage-peers-plugin` bumped per phase batch (A → 2.5.0, B → 2.6.0, C → 2.7.0).
4. Eta review per PR (docs-only skill bodies don't need ETA APPROVED for npm, but the plugin release does).
5. Self-tests : each dispatch-* skill exercises a dry-run + a real call against `compassionate-goldfinch-737` test tenant.

**Friction kill validation**:
After Phase A ships, count daily rejections fleet-wide via hook audit logs (each hook writes to `~/.claude/hook-audit.jsonl`). Target: ≥80% drop in `block`/`forbidden` events on the matching tool names within 7 days of Phase A merge.

---

# 9. Out of scope (not skills, but pre-requisites)

- The latent hooks (`enforce-bu-routing.py`, `enforce-component-brief.py`, `enforce-decisive-messaging.py`, `enforce-delegation.py`, `enforce-iter-message.py`, `enforce-mission-template.py`, `enforce-task-quality.py`) are not wired in `settings.json` today. Either they are dead code, or they are intended to be activated alongside the matching skill. **Recommendation**: when shipping the corresponding skill (`bu-manage`, `component-register`, `mission-template-apply`, etc.), also wire the matching hook in the same PR so the skill is enforced from day one.
- The static-analysis tripwire test shipped in #562 (`scope-guard-coverage.test.ts`) should be extended to assert "every category-defining tool has a skill in the plugin manifest". That guarantees we don't regress coverage when a new tool is added.

---

# 10. Summary

- **5 / 19 buckets** covered today, partially.
- **9 existing skills** + **1 plugin init skill** + **1 pre-compact skill** = ~11 unique skill bodies.
- **84 tools** total; raw-call territory accounts for **~56**.
- **5 hooks** account for ~90% of daily rejections (no-task-in-message, evidence-bound-completion, signature, brief-template, irp-sequence).
- Roadmap = **28 new skills + 4 rewrites = 32 deliverables**, ordered ROI-decreasing, phased A/B/C, no skill excluded.
- Sigma trim of Pi's proposal: `dispatch-message` ✓, `dispatch-task` split into 3, +6 mandatory additions (subagent, mission-bootstrap, identity-set, plus the 4 rewrites of existing skills).

Ship Phase A first → expect ≥80% drop in hook rejections within a week.

Orchestrator: Sigma — VantageOS Team | 2026-05-31
