# Case 1 — Happy Path (sigma autonomous EOD)

## Input
User says: "close day"

Session context:
- role=sigma, instance=vps-prod, date=2026-05-31
- `git log --since=midnight --oneline` → 2 commits: `ededcf5`, `aaced95`
- `gh pr list` → PR `#562` merged today
- 2 in_progress tasks: `k57abc` (completed), `k57def` (partial)
- 0 blocked, 1 todo (`k57jkl`)

## Expected Behavior
1. Step 1 silently collects identity + git/PR evidence.
2. Step 2 routes `k57abc` through `dispatch-task-complete` with completionNote citing `#562` + commit `ededcf5` (≥ 40 chars, ≥ 1 proof token).
3. `k57def` stays in_progress (no call).
4. Step 3 asks exactly ONE question: "Key moments today?".
5. `write_diary` content embeds `ededcf5`, `aaced95`, `#562`, `k57abc`.
6. Step 4 `store_memory` namespace=`orchestrator/sigma`, type=`project` mentions `#562` and next-up `k57jkl`.
7. Step 5 `set_summary` formatted exactly: `Session closed — 2026-05-31 — 1 completed / 1 in_progress / 0 blocked`.
8. Final user output: one line starting `Day closed.`

## Hooks Pre-Satisfied
- `enforce-evidence-bound-completion` — completionNote has SHA + PR# tokens.
- `block-time-estimates` / `enforce-ship-24-7` — no duration phrasing emitted.
