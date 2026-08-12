# close-day — Examples

## Sigma EOD on VPS (autonomous)

```
User: close day

sigma:
  Step 1: role=sigma, instance=vps-prod, date=2026-05-31
          git log → 4 commits: ededcf5, aaced95, 6bbc2ad, f294578
          gh pr list → #562, #561, #560, #559
          files: mcp-server/dist/src/auth.js, mcp-server/dist/src/tools.js
  Step 2: list_tasks(in_progress) → 3 tasks
          - k57abc… "P0 cross-tenant fix" → completed today
            → Skill({skill: "dispatch-task-complete"}) → assembles
              completionNote="Shipped via #562 (commit ededcf5), 18/18 tests pass,
              auth.js + tools.js hardened. Evidence: mcp-server/dist/src/auth.js"
              → complete_task PASSES enforce-evidence-bound-completion hook
          - k57def… "DCR scope tests" → partially done → leave in_progress
          - k57ghi… "doctrine briefing" → completed → dispatch-task-complete
            cites memory j57dy3049btafda9m2f5d2ggk987ph3f
  Step 3: write_diary content embeds commits ededcf5/aaced95/6bbc2ad/f294578,
          PRs #562/#561/#560/#559, completed k57abc…/k57ghi…
  Step 4: store_memory namespace=orchestrator/sigma — "Day 88 shipped #562
          cross-tenant fix. k57def carrying forward. Next: k57jkl bulk-list audit."
  Step 5: set_summary "Session closed — 2026-05-31 — 2 completed / 1 in_progress / 0 blocked"

Output:
  Day closed. 2 tasks completed, 1 carrying forward, diary written, summary stored.
```

## Pi EOD on Chromebook (human)

```
User: wrap up

pi:
  Step 1: role=pi, instance=chromebook, date=2026-05-31
          git log → 0 commits (Pi orchestrates, doesn't commit)
          dispatched task closures pulled via check-messages earlier today
  Step 2: list_tasks(in_progress) → 1 task (k57xyz "review eta verdicts")
          → completed → dispatch-task-complete cites verdict task ids
  Step 3: "Key moments today?" → Laurent: "Day 88 doctrine locked, sigma shipped #562"
          → write_diary highlights cite #562 + memory j57dy30…
  Step 4: store_memory — "Day 88 closed. Sigma #562 merged. Eta queue clear.
          Tomorrow: kick off Day 89 mission planning, taskId k57nnn top of queue."
  Step 5: set_summary "Session closed — 2026-05-31 — 1 completed / 0 in_progress / 0 blocked"

Output:
  Day closed. 1 task completed, 0 carrying forward, diary written, summary stored.
```
