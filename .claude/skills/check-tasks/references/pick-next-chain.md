# Pick-next chain

```
User: pick the next one
sigma: <Step 3 → Step 5 → Step 6 chain to dispatch-task-start with taskId=k7h3m9aa>

  NEXT picked: [urgent] Fix DCR scope isolation regression — k7h3m9aa
  → handing off to dispatch-task-start.
```

Only fires on explicit PICK-NEXT intent ("pick the next one", "start next", "auto-pick", "take the next task"). Never writes from this skill — delegates to `dispatch-task-start` so the `enforce-irp-sequence` hook owns the transition.
