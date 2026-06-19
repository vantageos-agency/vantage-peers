---
name: dispatch-subagent
description: >
  Compose and dispatch a Claude Code subagent (the `Agent` tool) with the
  correct brief template marker pre-injected so the
  `enforce-brief-template` hook never blocks. Use this skill whenever the
  user says "dispatch a subagent", "agent for X", "spawn agent",
  "delegate to subagent" — even if they don't say "dispatch-subagent"
  explicitly.
description_fr: >
  Composez et expédiez un sous-agent Claude Code (l'outil `Agent`) avec
  le bon marqueur de modèle de brief pré-injecté, pour que le hook
  `enforce-brief-template` ne bloque jamais. Mobilisez ce skill quand
  l'utilisateur dit "lance un sous-agent", "agent pour X", "spawn agent",
  "délègue à un sous-agent", même sans dire "dispatch-subagent"
  explicitement.
allowed-tools: "Agent"
metadata:
  version: "1.1.0"
  user-invocable: true
license: Proprietary
---

Wrap every `Agent` (Claude Code subagent) invocation with the correct brief template reference (`brief-ui.md`, `brief-backend.md`, or `agent-brief-template.md`) so the `enforce-brief-template.py` hook always passes on first try.

**Canonical source**: VantageRegistry (`get_skill_content name=dispatch-subagent`). The local `.claude/skills/dispatch-subagent/SKILL.md` in each workspace MUST be a byte-exact mirror of the VR canonical content. Fetch from VR; do not edit locally.

PRINCIPLE — Every subagent dispatch carries a `Template:` marker as its first line. The hook `enforce-brief-template.py` inspects the prompt passed to `Agent` and BLOCKS if no known template name is referenced. This skill guarantees the marker is present and the template matches the work domain. Improvising a name (e.g. "brief-generic", "ui-template", "frontend") gets the call rejected — only the three canonical names are valid.

## WORKFLOW

**Step 1 — Collect inputs**

1. `role` — one of: `frontend`, `backend`, `research`, `review`, `other`.
   - `frontend`: React/Next.js/Tailwind/UI, a11y, CSS, design system.
   - `backend`: Convex functions, server routes, MCP server, hooks, data model, auth, embeddings, scheduled jobs.
   - `research`: exploration, recall, doc reading, decision drafting, codebase mapping.
   - `review`: code review, PR review, security review, drift detection.
   - `other`: anything else (ops, infra glue, one-off scripts).
2. `task description` — self-contained brief: target files, expected behavior, constraints, success criteria.
3. `return shape` — file path, JSON, plain text, diff, evidence tokens. Default: "Return findings as plain text in your final assistant message. Include absolute file paths for any files inspected or modified."

If `role` is missing, infer from keywords (`tsx`/`component`/`Tailwind`/`a11y` → frontend; `convex`/`mutation`/`query`/`hook`/`MCP tool` → backend; `recall`/`analyze`/`compare`/`draft decision` → research; `review`/`audit`/`drift` → review). If ambiguous, use `other`.

**Step 2 — Select the template name**

Fixed mapping — never improvise:

| role       | template name                |
|------------|------------------------------|
| `frontend` | `brief-ui.md`                |
| `backend`  | `brief-backend.md`           |
| `research` | `agent-brief-template.md`    |
| `review`   | `agent-brief-template.md`    |
| `other`    | `agent-brief-template.md`    |

These are the ONLY three valid template names. Any other string fails the hook.

**Step 2.5 — Pre-flight grep verify (v1.1.0)**

Before composing the final prompt, scan the assembled task description for **path-like references** (`convex/foo.ts`, `mcp-server/src/bar.ts:42`, `tests/baz/qux.test.ts`, any token shaped `path/to/file.ext` with ≥1 slash and a known extension). For each reference, verify it exists on disk relative to the orchestrator's working directory.

Rationale — Day 107 friction-capture (task `k173as8n0zj8bmbznhvy9ch4a588yrp7`): a brief that names a phantom file path (renamed since the writer's last refresh, never created, or hallucinated) wastes the sub-agent's whole turn. The sub-agent reads the brief, looks for the file, fails to find it, and either fabricates a plausible-looking patch or aborts. Either outcome is more expensive than catching the phantom path before dispatch.

How to apply:
- The hook `enforce-brief-grep-verify.py` (PreToolUse on `Agent`) runs this check automatically. If a path-like ref is missing on disk, it BLOCKS with the list of MISSING paths and a `Verified X/Y` ratio. The orchestrator then fixes the brief (renamed path? typo? hallucination?) before retrying.
- If a path is intentional — e.g. a file the sub-agent is about to CREATE — append the marker `// allow-missing-refs: <reason>` anywhere in the prompt. The hook lets it through. Use sparingly; the default is "fix the brief".
- URLs (`https://example.com/foo.ts`), deps (`node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`, `.git/`), and canonical doc placeholders (`path/to/`, `your/`, `foo/`, `bar/`) are ignored — they're not real path claims.
- Agent types `Explore`, `Plan`, `claude-code-guide`, `statusline-setup` are exempt (read-only / planning roles that don't act on the paths).

When the orchestrator is composing manually (without the dispatch-subagent skill wrapping the Agent call), the hook still runs as the safety net. The skill's job is to do the verify EARLY so the orchestrator catches the problem at brief-writing time, not at dispatch time.

**Step 3 — Compose the prompt**

Exact shape:

```
Template: <template-name>

<task description>

<return shape instruction>
```

- First line MUST be `Template: <name>` with `<name>` one of `brief-ui.md`, `brief-backend.md`, `agent-brief-template.md`. No leading whitespace, no markdown heading prefix.
- Blank line after `Template:`, then task, blank line, then return shape.
- Do NOT wrap the prompt in code fences. The hook reads the raw string.
- Do NOT add a signature line — subagents are intra-orchestrator; `enforce-signature` does not apply here. (A subagent that later calls `send_message` handles its own signature via the `send-message` skill.)

**Step 4 — Call the `Agent` tool**

Invoke the Claude Code `Agent` tool with the composed prompt. Pass through any model / subagent-type preference the orchestrator already specified; otherwise use the default subagent type.

**Step 5 — Return output verbatim**

The subagent's final assistant message is the return value. Hand it back unchanged — do not summarize, do not re-format, do not strip file paths. The orchestrator is responsible for downstream parsing.

If the subagent failed (tool error, hook block, empty output), surface the error verbatim along with the composed prompt so the orchestrator can diagnose.

## RULES

- NEVER call `Agent` without a `Template:` marker as the first line. `enforce-brief-template.py` blocks every such call.
- NEVER invent a template name. Only `brief-ui.md`, `brief-backend.md`, `agent-brief-template.md` are accepted.
- One subagent per skill invocation. Fan-out = invoke this skill once per branch (parallel tool calls).
- Do NOT add a cross-orchestrator signature — subagents are intra-orchestrator; `enforce-signature` does not match `Agent`.
- If the task description is <~200 chars or lacks success criteria, expand it before dispatch. Vague briefs waste a turn.
- Return subagent output verbatim. Summarizing here loses evidence tokens (file paths, SHAs, IDs) needed for `complete_task`.
- This skill is the ONLY sanctioned way to invoke `Agent`. Raw `Agent` calls inside other skills must be migrated to call this skill instead.
- **v1.1.0**: every path-like reference in the brief MUST exist on disk before dispatch, OR the prompt MUST carry `// allow-missing-refs: <reason>`. The `enforce-brief-grep-verify.py` hook is the deterministic safety net; this skill's Step 2.5 is the proactive catch.

## Changelog

- **v1.1.0 (Day 107, 2026-06-19)** — Added Step 2.5 pre-flight grep verify and the companion `enforce-brief-grep-verify.py` PreToolUse hook. Captures Day 107 friction `j57103m9` (sub-agent brief-vs-reality drift on phantom Clerk JWT cache path) — task `k173as8n0zj8bmbznhvy9ch4a588yrp7`. Hook reports `Verified X/Y path-like references — N MISSING` and blocks the dispatch until the brief is fixed or `// allow-missing-refs: <reason>` is added.
- **v1.0.x** — Initial skill: template marker enforcement (`brief-ui.md` / `brief-backend.md` / `agent-brief-template.md`) so `enforce-brief-template.py` passes on first try.

## EXAMPLES

See `references/examples.md` for full worked frontend, backend, and research dispatch examples (composed prompts and expected output shape).

## CANONICAL SOURCE

This skill lives in VantageRegistry. Fetch the body via `mcp__vantage-registry__get_skill_content name=dispatch-subagent`. Re-sync local copies byte-exact whenever VR is updated — never edit a workspace SKILL.md directly. The fleet stays aligned by pulling, not by hand-copy propagation.

## SELLABLE AS

`vantage-peers` plugin — guarantees every Claude Code `Agent` dispatch carries the canonical brief-template marker, eliminating the `enforce-brief-template` hook reject loop and standardizing how the fleet delegates work to subagents.
