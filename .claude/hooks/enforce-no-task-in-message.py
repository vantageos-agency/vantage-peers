#!/usr/bin/env python3
"""
PreToolUse hook on mcp__vantage-peers__send_message.
Blocks inter-orchestrator messages that contain imperative verbs or
numbered-action-lists (>=3 items) without referencing an existing task ID.

Skip rules (priority order):
  1. tool_name != "mcp__vantage-peers__send_message"   -> allow
  2. channel in CHANNEL_EXEMPT                          -> allow
  3. content short (<120 chars) + no verb + no list    -> allow (ack)
  4. content matches TASK_REF_PATTERNS                  -> allow
  5. content matches INFO_MARKERS                       -> allow
  6. no imperative verb AND no action-list (>=3 items) -> allow
  7. otherwise                                          -> block (exit 2)

Fail-open: any unexpected exception -> sys.exit(0).

Spec: analysis/no-task-in-message-hook-spec-2026-04-24.md
Version: 1.0.0
"""
import json
import re
import sys

IMPERATIVE_VERBS_PATTERN = re.compile(
    r"\b("
    # French + English imperatives
    r"fais|faire|"
    r"exécute|execute|"
    r"amende|amend|"
    r"crée|create|"
    r"mets?\s+à\s+jour|update|"
    r"corrige|fix|"
    r"déploie|deploy|"
    r"merge|mergez?|"
    r"installe|install|"
    r"configure|configurez?|"
    r"renomme|rename|"
    r"supprimer|supprime|delete|remove|"
    r"ajoute|ajouter|add|"
    r"modifie|modifier|modify|"
    r"retire|retirer|"
    r"applique|appliquer|apply|"
    r"vérifie|verify|check|"
    r"génère|generate|"
    r"construis|construire|build|"
    r"écris|écrire|write|"
    r"push|pushe|poussez?|pousse|"
    r"pull|pulle|tirez?|"
    r"commit|commits?|"
    r"rebase|rebasez?|"
    r"run|lance|lancez?|démarre|start|"
    r"stop|arrête"
    r")\b",
    re.IGNORECASE,
)

NUMBERED_LIST_PATTERN = re.compile(
    r"(?:^|\n)\s*\d+\.\s+[A-Za-zÀ-ÿ]",
    re.MULTILINE,
)

TASK_REF_PATTERNS = [
    re.compile(r"task\s+k[a-z0-9]{15,}", re.IGNORECASE),
    re.compile(r"taskId\s*[:=]", re.IGNORECASE),
    re.compile(r"task\s+ID\s*[:=]", re.IGNORECASE),
]

INFO_MARKERS = [
    re.compile(r"^\s*\[INFO\s*ONLY\]", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^\s*\[STATUS\]", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^\s*\[DONE\]", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^\s*Info\s*:", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^\s*Status\s*:", re.IGNORECASE | re.MULTILINE),
]

CHANNEL_EXEMPT = {
    "pi-chromebook",  # Laurent-facing channel
    "pi-vps",         # Pi herself (self-dispatches aren't task assignments)
    "broadcast",      # Announcements, not task dispatches
}

STDERR_MSG = (
    "BLOCKED: Message contains action instructions without a task reference.\n\n"
    "Inter-orchestrator messages that ask the recipient to EXECUTE work must either:\n"
    "  (a) reference an existing task via `task k...` / `taskId: ...` / `Task ID: ...`, OR\n"
    "  (b) be tagged `[INFO ONLY]`, `[STATUS]`, or `[DONE]` at line start (status/ack only), OR\n"
    "  (c) be sent to the pi-chromebook channel (Laurent-facing exempt).\n\n"
    "Why: free-form \"do X then do Y\" text bypasses the task system — no VERIFICATION, no TESTS,\n"
    "no traceability, no completionNote audit trail. Work gets lost.\n\n"
    "Fix (2 minutes):\n"
    "  1. Call `mcp__vantage-peers__create_task` for each distinct action. Each task has\n"
    "     title + assignedTo + description with VERIFICATION: and TESTS: blocks.\n"
    "  2. Re-send this message with `task k<id>` or `taskId: k<id>` referencing the new task(s).\n"
    "  3. The recipient picks up the task via list_tasks + executes per the IRP template.\n\n"
    "Opt-out (rare): prefix the message with `[INFO ONLY]` or `[STATUS]` if it's purely\n"
    "informational (no action requested). Use sparingly — the default is \"task, not message\"."
)

try:
    data = json.load(sys.stdin)
    # TOOL_NAME_GUARD_PI_FIX Day 113 — fleet deadlock fix (matcher=* fires every tool)
    if data.get("tool_name") != "mcp__vantage-peers__send_message":
        sys.exit(0)
    tool_name = data.get("tool_name", "")
    if tool_name != "mcp__vantage-peers__send_message":
        sys.exit(0)

    tool_input = data.get("tool_input", {})
    channel = tool_input.get("channel", "")
    content = tool_input.get("content", "")

    if not isinstance(content, str) or not content.strip():
        sys.exit(0)
    if isinstance(channel, str) and channel in CHANNEL_EXEMPT:
        sys.exit(0)

    has_verb = bool(IMPERATIVE_VERBS_PATTERN.search(content))
    numbered_lines = len(NUMBERED_LIST_PATTERN.findall(content))
    has_action_list = numbered_lines >= 3

    if len(content) < 120 and not has_verb and not has_action_list:
        sys.exit(0)

    for pat in TASK_REF_PATTERNS:
        if pat.search(content):
            sys.exit(0)

    for pat in INFO_MARKERS:
        if pat.search(content):
            sys.exit(0)

    if not has_verb and not has_action_list:
        sys.exit(0)

    print(STDERR_MSG, file=sys.stderr)
    sys.exit(2)

except SystemExit:
    raise
except Exception:
    sys.exit(0)
