---
name: dispatch-task-complete
description: >
  Close a VantagePeers task with an auto-assembled proof-token completionNote so the evidence-bound-done hook never blocks. Use this skill whenever the user says "complete task <id>", "mark done", "close <id>", "finish task", "task done", "wrap task", "close task", or asks to move a task to done/review -- even if they don't say "dispatch-task-complete" explicitly.
description_fr: >
  Cloturez une tache VantagePeers avec un completionNote assemble automatiquement a partir des jetons de preuve (commit SHA, numero de PR, identifiant VP, chemin de fichier), afin que le hook evidence-bound-done ne bloque jamais l'appel. Mobilisez ce skill des que votre utilisateur dit "complete task <id>", "mark done", "close <id>", "finish task", "task done", "wrap task", "close task", ou demande de passer une tache en done/review -- meme sans citer "dispatch-task-complete".
allowed-tools: "mcp__vantage-peers__complete_task, mcp__vantage-peers__update_task"
metadata:
  version: "1.1.0"
  user-invocable: true
license: Proprietary
---

# dispatch-task-complete

Close a VantagePeers task safely. Wraps `mcp__vantage-peers__complete_task` and `mcp__vantage-peers__update_task` with auto-assembly of a `completionNote` containing at least one proof token (commit SHA, PR#, VP id, test ratio, artifact path, URL). The Day 76 Evidence-Bound Done hook (`enforce-evidence-bound-completion.py`) rejects claim-only notes — this skill ensures every close ships with a verifiable jeton de preuve.

## When to use

- User says: "complete task <id>", "mark done", "close <id>", "finish task", "task done", "wrap up task".
- You finished work tracked by a VP task and need to move it to `done` or `review`.
- You want to chain a `[DONE]` notification to the creator with the same proof tokens.

## When NOT to use

- Task is blocked — use `block_task` instead.
- Task hasn't been started — use `start_task` first.
- You have zero evidence and refuse to fabricate any — stop and surface the gap to the user.

## Inputs

- `taskId` (required) — Convex id, format `k[a-z0-9]{32}`.
- `intent` (optional, default `done`) — one of `done` | `review`.
- `summary` (optional) — one-sentence description of what was accomplished. If omitted, the skill drafts one from recent context.
- `extraProof` (optional) — proof tokens the user wants to force-include (URL, SHA, PR#, ratio, path).

## Workflow

### 1. Resolve taskId + intent

If the user said "close k7abc..." extract the id verbatim. If they said "close the auth task" and only one in-flight task matches, use that. Otherwise ask once via AskUserQuestion.

Default `intent = done`. If the user said "for review", "send to review", or the task's mission requires review gating, set `intent = review`.

### 2. Scan recent context for proof tokens

Walk the recent transcript (last ~50 turns is plenty) and harvest tokens with these patterns:

- **Commit SHA**: `\b[a-f0-9]{7,40}\b` — accept 7-40 hex chars. Filter out obvious non-SHAs (all-zero, dictionary words).
- **PR / issue number**: `#\d{1,5}\b` — prefer those mentioned alongside "PR", "merged", "opened".
- **VP / Convex ids**: `\b[kjm][a-z0-9]{32}\b` — message ids, memory ids, task ids, mission ids, briefing ids.
- **Test / gate ratios**: `\b\d{1,4}\/\d{1,4}\b` — e.g. `311/314`, `69/69`.
- **Artifact counts**: `\b\d+\s+(rows?|tests?|files?|commits?|messages?|memories?)\b`.
- **File paths**: anything matching `[\w./-]+\.(md|ts|js|py|json|yaml|yml|sh|tsx)` under repo roots.
- **URLs**: `https?://\S+` — PR links, deploy dashboards, Convex dashboard.

Deduplicate. Prefer the most recent / most specific tokens.

### 3. Gate: at least one proof token

If the harvested set is empty AND `extraProof` is empty:

- Do NOT call `complete_task`. The hook will reject and the user will lose context.
- Use AskUserQuestion to request a single proof token.
- If the user refuses or has nothing, abort with a one-line message citing Day 76 doctrine.

### 4. Compose the completionNote

Shape:

```
<one-sentence work summary>. Evidence: <token1>, <token2>, <token3>.
```

Rules:

- ≥ 40 characters total (hook minimum).
- Include 1-4 proof tokens, comma-separated, in the `Evidence:` clause.
- Never use claim-only words alone (`done`, `merged`, `PASS`, `all good`) — they must accompany a token.
- If `intent = review`, phrase the summary as "Ready for review:" not "Completed:".

See `references/examples.md` for accepted note shapes and rejected anti-patterns.

### 5. Call the MCP tool

For `intent = done`:

```
mcp__vantage-peers__complete_task
  taskId: <taskId>
  completionNote: <composed note>
```

For `intent = review`:

```
mcp__vantage-peers__update_task
  taskId: <taskId>
  status: review
  completionNote: <composed note>
```

If the call fails with the evidence-bound hook block, do NOT retry blindly. Read the hook stderr, identify which token was missing/rejected, ask the user, recompose.

### 6. Chain a [DONE] notification to the creator

After a successful close, look up the task's `createdBy` field. If `createdBy != self`, dispatch a message:

```
mcp__vantage-peers__send_message
  to: <createdBy>
  subject: [DONE] <short task title>
  body: Task <taskId> closed. <composed completionNote>
```

The `[DONE]` marker is the convention other orchestrators' inbox skills key on. Reuse the same proof tokens — do not re-harvest.

If the task has a parent mission, no broadcast is needed (mission roll-ups handle it). If it's standalone and high-priority, also store a memory with the completion summary.

### 7. Output

Return a compact confirmation:

- taskId closed
- intent (`done` / `review`)
- proof tokens attached
- creator notified (yes/no + message id)

Do not paste the full tool JSON. The user wants a one-liner.

## Anti-patterns — do not do these

- **Claim-only notes**: `completionNote="done"` — hook rejects, you waste a turn.
- **Fabricating SHAs / PR#s**: never invent a token. If you don't have one, ask.
- **Closing without reading the task first**: if you don't know the title or createdBy, fetch it before composing the note.
- **Skipping the [DONE] notification**: orchestrator awareness depends on it (Day 88 doctrine).
- **Re-opening to add proof**: if the hook blocks, fix the note BEFORE the call.

## Doctrine references

- Day 76 Evidence-Bound Done: `decisions/doctrine-evidence-bound-done-2026-05-20.md` (ElPi-Corp commit 5bd0ccd).
- Hook: `.claude/hooks/enforce-evidence-bound-completion.py` v1.0.0, contentHash `fb62f24e1658f52794b642256500c370bfc1987c4dd5fb9c43217e7848326ab1`.
- Opt-out: `// allow-no-evidence: <reason>` — rare, prefer fixing the source.

## SELLABLE AS

"Close tasks with proof attached — never get hook-blocked again. Auto-harvests commit SHAs, PR numbers, VP ids, and test ratios from your recent work, composes a Day 76-compliant completionNote, closes the task, and pings the creator with a `[DONE]` marker. Refuses to fabricate evidence; asks once if the context is dry."
