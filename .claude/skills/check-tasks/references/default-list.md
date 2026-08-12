# Default list — `assignedTo=<role>` happy path

```
User: check tasks
sigma: <runs Step 1-5 with assignedTo=sigma, status=todo, fields=lite, limit=20>

  TASKS (sigma) — todo:7 in_progress:0 review:1 blocked:2

  NEXT  [urgent] Fix DCR scope isolation regression — k7h3m9aa

    1.  [urgent] Fix DCR scope isolation regression — k7h3m9aa
    2.  [high]   Rewrite check-tasks skill for envelope cap — k2b8x14c
    3.  [high]   Audit list_tasks callers for fields=lite — k9k0p2qq
         blocked on: Rewrite check-tasks skill (todo)
    4.  [medium] Sync VR skills to plugin path — k5y4r8ee
    …
```
