---
name: friction-digest
description: "Weekly aggregator of fleet friction memories. Reads VantagePeers `audit/friction` namespace last 7 days, ranks patterns by frequency, identifies top 10, auto-creates improvement missions for top 3 with clear fix path, generates briefing note for Pi+Laurent. Triggers: weekly cron Sunday 22:30 `/friction-digest`, manual 'friction digest', 'weekly friction harvest', 'friction review'."
---

## TL;DR

- Reads VantagePeers memories `namespace=audit/friction` from the last 7 days, aggregates patterns by frequency + area (hook / skill / process / docs / infra).
- Triggered weekly Sunday 22:30 via cron `30 22 * * 0` on pi-chromebook (durable). Manual invocation `/friction-digest` runs same flow anytime.
- Produces: top 3 improvement missions auto-dispatched in VantagePeers + briefing note topic="weekly-friction-digest" participants=[pi, laurent].
- Closes the meta-cognitive loop (RULE #15 AUTO-AMÉLIORATION) — friction observed becomes friction fixed.

---

## WHAT YOU DO

Harvest 7 days of friction signals stored by orchestrators under `audit/friction`, rank them by recurrence + impact, dispatch the top 3 actionable patterns as improvement missions in VantagePeers (hook fix / skill upgrade / process change / docs gap / infra patch), and synthesize the rest in a briefing note for Pi+Laurent review. The skill turns scattered "things that annoyed me this week" memories into shipped improvements.

Friction = anything that made an orchestrator work AROUND the system instead of THROUGH it: silent flag ignored (CronCreate durable=true), tolerated noise (gws decrypt warning), hook false positive bypassed with override, skill workaround documented but root cause never fixed, MCP schema gap forcing gymnastics, doc that didn't exist when needed.

---

## Decision Tree

1. **No friction memories last 7 days** -> create briefing note "Zero friction harvested — either the fleet is silent or the harvest signal is broken" + escalate `[STATUS]` to pi-chromebook (silence is suspicious, not victory).
2. **1-9 friction memories** -> briefing note with full list, no auto-dispatch (volume too low to rank meaningfully, treat each as candidate).
3. **10+ friction memories** -> full ranking + auto-dispatch top 3 with clear fix path + briefing note with all top 10 + deferred items.
4. **Top 3 have no clear fix path** (ambiguous, needs human triage) -> defer dispatch, escalate to briefing note with explicit `[NEEDS-TRIAGE]` flag per item.
5. **Manual invocation with `--dry-run`** -> run full aggregation, print proposed missions + briefing note content, write NOTHING to VantagePeers.
6. **Date arg `YYYY-MM-DD` passed** -> use that date as end-of-window instead of today (backfill).

---

## WORKFLOW

**Step 1 -- Determine window**

End date = `$1` if `YYYY-MM-DD` format, else today (`date +%Y-%m-%d`). Start date = end - 7 days. Window = `[start, end]` inclusive.

**Step 2 -- Query friction memories via VantagePeers**

```
mcp__vantage-peers__list_memories \
  namespace="audit/friction" \
  limit=200
```

Filter client-side by `createdAt` in `[start, end]`. Fall back to `recall query="friction observed system gap workaround" namespace="audit/friction" limit=200` if `list_memories` returns paged result.

**Step 3 -- Parse + categorize each memory**

Each friction memory MUST follow the convention (enforced by `enforce-friction-field` hook on `complete_task`):

```
friction_observed: <one-line description>
area: hook | skill | process | docs | infra | mcp
component: <name of hook/skill/process/file/tool>
workaround_used: <what I did instead>
fix_path: <proposed fix> | unknown
```

Parse each memory content into structured record. If `area` missing -> bucket "uncategorized" and surface in briefing note.

**Step 4 -- Rank by frequency**

Group by `component`. Count occurrences. Sort desc by count, tie-break by recency (most recent first). Tag each pattern with `area` + average `fix_path` clarity (clear / partial / unknown).

**Step 5 -- Pick top 10 patterns**

Output table:

| Rank | Pattern (component) | Area | Count | Fix path | First seen | Last seen |
|---|---|---|---|---|---|---|

**Step 6 -- Auto-dispatch top 3 with clear fix path**

For each of top 3 where `fix_path != unknown`:

```
mcp__vantage-peers__create_mission \
  name="friction-fix-<component>-w<weeknum>" \
  pilot="<best-orchestrator-for-area>" \
  brief="Template utilisé : mission-generic-v1\n\nFriction pattern observed <count> times last 7 days.\n\nComponent: <component>\nArea: <area>\nWorkarounds used by fleet: <summary>\nProposed fix path: <fix_path>\n\nReferences: <memory IDs>\n\nVERIFICATION: friction occurrence drops to 0 in next 7-day digest.\nTESTS: pattern-specific (hook unit test / skill eval / smoke run).\n\nDoctrine: RULE #15 AUTO-AMÉLIORATION." \
  status="execute" \
  createdBy="pi"
```

Pilot routing heuristic:
- area=hook -> pi (Pi owns fleet hooks)
- area=skill -> owning BU orchestrator (lookup via `recall` on skill name) or pi if cross-cutting
- area=mcp + component starts with `vantage-peers` -> sigma
- area=mcp + component starts with `vantage-registry` -> omega
- area=process / docs -> pi
- area=infra -> pi (or theta if VPS-specific)

Send `send_message` to pilot `[META]` with mission ID + reference to top-3 dispatch rationale.

**Step 7 -- Compose briefing note**

```
mcp__vantage-peers__create_briefing_note \
  topic="weekly-friction-digest" \
  title="Weekly friction digest — week of <start> to <end>" \
  participants='["pi","laurent"]' \
  content="$CONTENT" \
  createdBy="pi"
```

Content structure:

```
## Weekly friction digest — <start> to <end>

**Total friction signals**: <N>
**Unique patterns**: <M>
**Top 3 auto-dispatched**: <list of mission IDs>
**Deferred (no clear fix path or rank > 3)**: <count>

### By area
- hook: <count>
- skill: <count>
- process: <count>
- docs: <count>
- infra: <count>
- mcp: <count>
- uncategorized: <count>

### Top 10 patterns ranked
<table from Step 5>

### Top 3 dispatched
1. Mission <id> — pilot <role> — pattern <component> (<count> occurrences) — fix: <fix_path>
2. ...
3. ...

### Deferred items (need triage or rank > 3)
- <component> (count <n>, area <area>): <one-line summary + reason deferred>
- ...

### Orchestrators flagging most friction
<rank by count of friction memories created>

---

Source: VantagePeers `audit/friction` namespace.
Skill: `friction-digest` weekly run (cron `30 22 * * 0`).
Doctrine: RULE #15 AUTO-AMÉLIORATION.
```

**Step 8 -- Store aggregation memory**

```
mcp__vantage-peers__store_memory \
  namespace="audit/friction-digest" \
  type="reference" \
  createdBy="pi" \
  content="Week <start>-<end>: <N> signals, <M> patterns, top3 dispatched: <ids>, briefing <id>"
```

**Step 9 -- Exit silently**

Output briefing note ID + dispatched mission IDs. No console noise unless `--verbose` flag. On `--dry-run`, print proposed payloads, write nothing.

---

## Quick Examples

### Cron weekly fire Sunday 22:30

```
/friction-digest
```

Expected: briefing note ID + up to 3 mission IDs printed. Visible via `list_briefing_notes topic="weekly-friction-digest"`.

### Manual harvest mid-week (sanity check)

```
/friction-digest
```

Same flow. Useful if friction backlog feels heavy before Sunday.

### Dry-run preview

```
/friction-digest --dry-run
```

Prints proposed missions + briefing note content. No writes to VantagePeers.

### Backfill prior week

```
/friction-digest 2026-05-24
```

Uses 2026-05-24 as window end. Useful if previous Sunday cron failed.

---

## When Things Go Wrong

| Problem | Recovery |
|---------|----------|
| Zero friction memories last 7 days | Create briefing note flagging absence + `send_message channel=pi-chromebook [STATUS] friction harvest signal may be broken — investigate enforce-friction-field hook + close-day skill`. Silence != victory. |
| Memories present but `friction_observed:` field missing | Bucket as "uncategorized" + log count in briefing note + open mission to fix `enforce-friction-field` hook coverage. |
| `create_mission` rejected by hook (template missing, missing field) | Retry once with corrected payload. If still fails, escalate to briefing note `[BLOCKER]` + send_message pi-chromebook with raw payload + rejection reason. NEVER bypass with opt-out token (would itself be friction). |
| Pilot routing ambiguous (cross-cutting pattern) | Default to pi as pilot + flag `[NEEDS-PILOT-REASSIGN]` in mission brief. Laurent or Pi reassigns on review. |
| `list_memories` returns paged truncated | Switch to `recall` with broader query + pagination loop. |
| Briefing note creation fails (VP unreachable) | Retry once. If still fails, write content to `logs/friction-digest/<week>-failure.md` for manual recovery + log failure memory. |
| Top 3 all have `fix_path: unknown` | Skip auto-dispatch entirely. Briefing note flags all top 10 as `[NEEDS-TRIAGE]`. Laurent or Pi picks fix paths next session. |

---

## References

**Internal:**
- VantagePeers `audit/friction` namespace — source memories
- VantagePeers `audit/friction-digest` namespace — historical aggregation memories
- `.claude/hooks/enforce-friction-field.py` — PreToolUse `complete_task` requires `friction_observed:` line (or `friction_observed: none`)
- `.claude/skills/close-day/SKILL.md` — friction harvest phase end-of-day (writes friction memories)

**Related skills:**
- `close-day` — produces the friction memories this skill aggregates
- `email-dispatch-summary` — style + workflow reference for digest skills
- `vantage-peers-usage` — VP MCP tools reference (`create_mission`, `create_briefing_note`, `list_memories`, `store_memory`)

**Doctrine:**
- RULE #15 AUTO-AMÉLIORATION (CLAUDE.md) — orchestrators must surface + fix friction, not work around it
- RULE #14 TRUST THE SYSTEM — friction harvest is part of trusting + improving the system
- RULE #11 réponse courte — briefing note stays synthetic, no padding

---

## RULES

- ALWAYS create the briefing note, even on zero-friction weeks (explicit zero is signal, not silence).
- NEVER bypass `create_mission` hook rejections with opt-out tokens — that would itself be friction (capitalize the rejection root cause instead).
- ALWAYS cap auto-dispatch at 3 missions per week (avoid flooding fleet with low-signal improvements). Excess goes to briefing note for human triage.
- NEVER auto-dispatch a mission whose `fix_path == unknown` — defer to briefing note for triage.
- CONFIDENTIALITY: briefing note participants = pi + laurent only. Friction content may reference internal hook/process/client names.
- ATOMICITY: if VP writes fail mid-flow, log to `logs/friction-digest/` + retry next cron. Never silent fail.
- IDEMPOTENCE: if rerun for the same window, dedupe by `(component, week)` — do not create duplicate missions for the same pattern in same week.
- TRACEABILITY: every dispatched mission MUST reference the source friction memory IDs in its brief (audit trail).
- NO HUMAN BOTTLENECK: skill runs fully autonomous on cron — Laurent only consumes the briefing note, never triggers anything manually unless he wants to.

---

## SELLABLE AS

`vantage-fleet-automation` — Part of the meta-cognitive layer of the fleet (RULE #15 AUTO-AMÉLIORATION). Companion to `close-day` (friction harvester) + `enforce-friction-field` hook (friction enforcer). Provides closed-loop continuous improvement without human bottleneck. Part of `perello-dev-studio` plugin or future standalone `vantage-fleet-automation` package. Generalizable to any multi-agent fleet running on VantagePeers — friction harvest + weekly digest + auto-dispatch is the canonical pattern for autonomous system improvement.
