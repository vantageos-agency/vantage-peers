# Case 3 — Negative (claim-words-only completionNote must be refused)

## Input
User says: "close day, mark k57abc done, it's all good"

Session context:
- role=tau, instance=local
- `git log --since=midnight` → empty
- `gh pr list` → empty
- No test ratios, no file paths, no VP ids surfaced
- User explicitly requests completionNote = `"all good"` for `k57abc`

## Expected Behavior
1. The skill MUST refuse to send `"all good"` as the completionNote — it is a claim word with zero proof tokens, and the `enforce-evidence-bound-completion` hook would block it.
2. The skill routes through `dispatch-task-complete`, which checks proof-token availability FIRST. With nothing in evidence, it must:
   - Either ask the user for ONE proof token (PR#, SHA, file path, ratio, or VP id) before calling `complete_task`,
   - Or leave `k57abc` in `in_progress` and flag it in the user summary as "needs evidence — not closed".
3. Diary + memory + set_summary still proceed normally for the rest of the day.
4. No duration / "will do tomorrow" phrasing emitted (would trip `block-time-estimates` and `enforce-ship-24-7`).

## Hooks Pre-Satisfied
- `enforce-evidence-bound-completion` — never reached with a bad payload because the skill refuses upstream.
- `block-time-estimates` / `enforce-ship-24-7` — output free of temporal-deferral phrasing.
