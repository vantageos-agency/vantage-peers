#!/usr/bin/env python3
"""
PreToolUse hook : enforce VantagePeers PLUGIN SKILLS FIRST (Day 93 — 2026-06-06).

Blocks raw `mcp__vantage-peers__*` discovery/search calls when the plugin
already provides a skill that wraps them with envelope-safe defaults.

Trigger Day 93 : Pi called list_tasks raw → 216k tokens payload → context blown.
Plugin v2.7.5 had `/vantage-peers:check-tasks` skill v2.0.0 since Day 89 with
fields="lite" + limit=20 default. Pi never invoked it.

Doctrine (CLAUDE.md §VANTAGE-PEERS PLUGIN — SKILLS FIRST) : raw MCP discovery
calls are banned unless an override marker justifies a gap-product exception.

Phase 1 (Day 93 PM) : WARN-only (stderr message, exit 0). Sensibilisation.
Phase 2 (Day 94+) : BLOCK (exit 2). Post-fleet propagation.

Phase toggle via env var ENFORCE_PLUGIN_SKILL_FIRST_MODE=warn|block (default warn).

Override marker on same call (anywhere in tool_input as serialized JSON) :
  // allow-raw-mcp: <reason linked to gap task or legitimate exception>

Audit log : /tmp/enforce-plugin-skill-first.log (append-only per call).

Hors scope :
- Write tools : create_task, update_task, complete_task, store_memory, etc.
  (those are not envelope-prone discovery calls)
- get_* single-row reads : get_memory, get_mission, get_briefing_note, etc.
- mark_as_read / check_messages : envelope-safe per design
- send_message, dispatch_*, register_*, upsert_* : write paths

In scope (blocked unless override) :
- mcp__vantage-peers__list_tasks
- mcp__vantage-peers__list_tasks_by_mission
- mcp__vantage-peers__list_messages
- mcp__vantage-peers__list_memories
- mcp__vantage-peers__list_briefing_notes
- mcp__vantage-peers__list_missions
- mcp__vantage-peers__list_components
- mcp__vantage-peers__list_diaries
- mcp__vantage-peers__list_issues
- mcp__vantage-peers__list_fix_patterns
- mcp__vantage-peers__recall
- mcp__vantage-peers__hybrid_search
- mcp__vantage-peers__text_search
- mcp__vantage-peers__search_components
- mcp__vantage-peers__search_fix_patterns

Exit 0 = allow
Exit 2 = block (Phase 2 only)
"""
import json
import os
import sys
import time
from pathlib import Path

# Tools that have a skill wrapper in the plugin
# DISCOVERY (read) paths
# WRITE paths — skill wrappers pre-format payload to satisfy fleet hooks
#   (VERIFICATION + TESTS for create_task, delegation triplet, evidence-bound completion, etc.)
GUARDED_TOOLS = {
    # ---- DISCOVERY ----
    "mcp__vantage-peers__list_tasks": "/vantage-peers:check-tasks",
    "mcp__vantage-peers__list_tasks_by_mission": "/vantage-peers:check-tasks",
    "mcp__vantage-peers__list_messages": "/vantage-peers:messages-history",
    "mcp__vantage-peers__list_memories": "/vantage-peers:recall",
    "mcp__vantage-peers__list_briefing_notes": "/vantage-peers:briefing-recall",
    "mcp__vantage-peers__list_missions": "/vantage-peers:mission-bootstrap or /vantage-peers:check-tasks",
    "mcp__vantage-peers__list_components": "/vantage-peers:component-discover",
    "mcp__vantage-peers__list_diaries": "/vantage-peers:diary-discover",
    "mcp__vantage-peers__list_issues": "/vantage-peers:issue-triage",
    "mcp__vantage-peers__list_fix_patterns": "/vantage-peers:fix-pattern-cycle",
    "mcp__vantage-peers__list_peers": "/vantage-peers:peers-discovery",
    "mcp__vantage-peers__list_mandates": "/vantage-peers:mandate-lifecycle",
    "mcp__vantage-peers__list_bus": "/vantage-peers:bu-manage",
    "mcp__vantage-peers__list_repo_mappings": "/vantage-peers:repo-link",
    "mcp__vantage-peers__list_recurring_tasks": "/vantage-peers:recurring-schedule",
    "mcp__vantage-peers__list_broadcast_status": "/vantage-peers:messages-history",
    "mcp__vantage-peers__recall": "/vantage-peers:recall (or /vantage-peers:recall-deep for ensemble)",
    "mcp__vantage-peers__hybrid_search": "/vantage-peers:recall-deep",
    "mcp__vantage-peers__text_search": "/vantage-peers:recall-deep",
    "mcp__vantage-peers__search_components": "/vantage-peers:component-discover",
    "mcp__vantage-peers__search_fix_patterns": "/vantage-peers:fix-pattern-cycle",
    # ---- WRITE (skill pre-formats payload to pass fleet hooks) ----
    "mcp__vantage-peers__create_task": "/vantage-peers:dispatch-task-create",
    "mcp__vantage-peers__start_task": "/vantage-peers:dispatch-task-start",
    "mcp__vantage-peers__complete_task": "/vantage-peers:dispatch-task-complete",
    "mcp__vantage-peers__block_task": "/vantage-peers:task-structure",
    "mcp__vantage-peers__add_task_dependency": "/vantage-peers:task-structure",
    "mcp__vantage-peers__checkout_task": "/vantage-peers:task-structure",
    "mcp__vantage-peers__send_message": "/vantage-peers:dispatch-message",
    "mcp__vantage-peers__store_memory": "/vantage-peers:memory-write",
    "mcp__vantage-peers__soft_delete_memory": "/vantage-peers:memory-edit",
    "mcp__vantage-peers__store_episode": "/vantage-peers:episode-log",
    "mcp__vantage-peers__create_briefing_note": "/vantage-peers:briefing-write",
    "mcp__vantage-peers__update_briefing_note": "/vantage-peers:briefing-write",
    "mcp__vantage-peers__write_diary": "/vantage-peers:write-diary",
    "mcp__vantage-peers__create_mission": "/vantage-peers:mission-bootstrap",
    "mcp__vantage-peers__update_mission_status": "/vantage-peers:mission-bootstrap",
    "mcp__vantage-peers__instantiate_template_into_mission": "/vantage-peers:mission-template-apply",
    "mcp__vantage-peers__create_fix_pattern": "/vantage-peers:fix-pattern-cycle",
    "mcp__vantage-peers__add_fix_attempt": "/vantage-peers:fix-pattern-cycle",
    "mcp__vantage-peers__validate_fix": "/vantage-peers:fix-pattern-cycle",
    "mcp__vantage-peers__link_issue_to_pattern": "/vantage-peers:fix-pattern-cycle",
    "mcp__vantage-peers__update_issue_status": "/vantage-peers:issue-triage",
    "mcp__vantage-peers__verify_issue": "/vantage-peers:issue-triage",
    "mcp__vantage-peers__link_commit_to_issue": "/vantage-peers:issue-triage",
    "mcp__vantage-peers__add_deployment": "/vantage-peers:deploy-track",
    "mcp__vantage-peers__remove_deployment": "/vantage-peers:deploy-track",
    "mcp__vantage-peers__add_repo_mapping": "/vantage-peers:repo-link",
    "mcp__vantage-peers__remove_repo_mapping": "/vantage-peers:repo-link",
    "mcp__vantage-peers__register_component": "/vantage-peers:component-register",
    "mcp__vantage-peers__update_component": "/vantage-peers:component-register",
    "mcp__vantage-peers__delete_component": "/vantage-peers:component-register",
    "mcp__vantage-peers__create_bu": "/vantage-peers:bu-manage",
    "mcp__vantage-peers__update_bu": "/vantage-peers:bu-manage",
    "mcp__vantage-peers__delete_bu": "/vantage-peers:bu-manage",
    "mcp__vantage-peers__create_mandate": "/vantage-peers:mandate-lifecycle",
    "mcp__vantage-peers__accept_mandate": "/vantage-peers:mandate-lifecycle",
    "mcp__vantage-peers__settle_mandate": "/vantage-peers:mandate-lifecycle",
    "mcp__vantage-peers__update_mandate": "/vantage-peers:mandate-lifecycle",
    "mcp__vantage-peers__validate_mandate_spending": "/vantage-peers:mandate-lifecycle",
    "mcp__vantage-peers__create_recurring_task": "/vantage-peers:recurring-schedule",
    "mcp__vantage-peers__update_recurring_task": "/vantage-peers:recurring-schedule",
    "mcp__vantage-peers__pause_recurring_task": "/vantage-peers:recurring-schedule",
    "mcp__vantage-peers__resume_recurring_task": "/vantage-peers:recurring-schedule",
    "mcp__vantage-peers__delete_recurring_task": "/vantage-peers:recurring-schedule",
    "mcp__vantage-peers__update_profile": "/vantage-peers:identity-set",
    "mcp__vantage-peers__set_summary": "/vantage-peers:identity-set",
}

AUDIT_LOG = "/tmp/enforce-plugin-skill-first.log"
OVERRIDE_RE = "allow-raw-mcp:"


def audit_log(entry: dict) -> None:
    try:
        with open(AUDIT_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


try:
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")

    if tool_name not in GUARDED_TOOLS:
        sys.exit(0)

    skill_target = GUARDED_TOOLS[tool_name]
    tool_input = data.get("tool_input", {})
    serialized = json.dumps(tool_input, ensure_ascii=False)

    # Override marker check (in any string param of tool_input)
    if OVERRIDE_RE in serialized:
        audit_log({
            "ts": int(time.time()),
            "verdict": "allow",
            "reason": "override-marker",
            "tool": tool_name,
        })
        sys.exit(0)

    mode = os.environ.get("ENFORCE_PLUGIN_SKILL_FIRST_MODE", "warn").lower()

    if mode == "block":
        audit_log({
            "ts": int(time.time()),
            "verdict": "block",
            "reason": "no-override-marker",
            "tool": tool_name,
            "skill_target": skill_target,
        })
        print(
            f"BLOCKED: raw VantagePeers MCP call `{tool_name}` without skill wrapper.\n"
            f"\n"
            f"CLAUDE.md doctrine VANTAGE-PEERS PLUGIN — SKILLS FIRST (Day 93) :\n"
            f"  Plugin v2.7.5+ provides envelope-safe skill wrappers. Raw discovery\n"
            f"  calls are banned (Day 93 incident: list_tasks raw → 216k tokens).\n"
            f"\n"
            f"Use instead: {skill_target}\n"
            f"\n"
            f"Override (rare, requires gap-task reference) :\n"
            f"  Add `// allow-raw-mcp: <reason linked to Sigma improvement task ID>`\n"
            f"  anywhere in the tool input string (e.g. a comment-like field).\n"
            f"\n"
            f"Audit trail: /tmp/enforce-plugin-skill-first.log\n",
            file=sys.stderr,
        )
        sys.exit(2)

    # warn mode — emit notice but allow
    audit_log({
        "ts": int(time.time()),
        "verdict": "warn",
        "reason": "warn-only-mode",
        "tool": tool_name,
        "skill_target": skill_target,
    })
    print(
        f"[hook warn] raw VantagePeers MCP call `{tool_name}` — skill wrapper exists: {skill_target}\n"
        f"  CLAUDE.md doctrine VANTAGE-PEERS PLUGIN — SKILLS FIRST (Day 93).\n"
        f"  Phase 1 = warn-only. Phase 2 (Day 94+) will BLOCK without override marker.\n"
        f"  Override: add `// allow-raw-mcp: <reason>` to tool input.\n",
        file=sys.stderr,
    )
    sys.exit(0)

except Exception as e:
    print(f"[hook warning] enforce-plugin-skill-first: {e}", file=sys.stderr)
    sys.exit(0)
