# Case 2 — Edge (Pi orchestrator, zero commits, dispatch-only day)

## Input
User says: "wrap up"

Session context:
- role=pi, instance=chromebook, date=2026-05-31
- `git log --since=midnight --oneline` → 0 commits (Pi orchestrates, doesn't commit)
- `gh pr list` → 0 PRs authored by Pi
- 1 in_progress task: `k57xyz` "review eta verdicts" → completed today
- Dispatched task closures pulled earlier via check-messages: includes verdict task ids `k57v01`, `k57v02`

## Expected Behavior
1. Skill must NOT skip diary or memory just because git is empty — Pi's evidence comes from VP ids (verdict taskIds) and peer-message references.
2. Step 2 routes `k57xyz` through `dispatch-task-complete` with completionNote citing verdict taskIds `k57v01`, `k57v02` (VP ids count as proof tokens).
3. Step 3 diary highlights cite `k57v01`, `k57v02` and any briefing memory id like `j57dy30…`.
4. Step 4 memory mentions "no commits authored — orchestration day" plus next-up taskId.
5. Step 5 `set_summary` reflects `1 completed / 0 in_progress / 0 blocked`.

## Hooks Pre-Satisfied
- `enforce-evidence-bound-completion` — VP ids (`k…`, `j…`, `m…`) are accepted proof tokens.
- One-question rule preserved.
