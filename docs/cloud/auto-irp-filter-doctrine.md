# Auto-IRP Filter Doctrine

**Audience:** orchestrators reading or extending the auto-IRP error filter.
**Scope:** which production errors create GitHub issues + IRP missions, and which
do not. Canonical filter code lives in `convex/errorMonitorFilters.ts`.

---

## TL;DR

The auto-IRP bot creates GitHub issues + 13-task IRP missions for **unexpected
errors** only. Typed business errors (`Uncaught ConvexError:`) are the
contract's deliberate refusals (`CLIENT_REVOKED`, `TASK_BLOCKED`,
`UNAUTHORIZED`, `NOT_FOUND`, etc.) — they belong in audit logs + occurrence
counters, not in the IRP cascade.

Severity ladder (returned by `evaluateFilter`):

| Severity | Behavior | When used |
|---|---|---|
| `skip` | error not even recorded in catalogue | rare — transient envelope errors that succeeded on retry |
| `log-only` | error stored in catalogue + occurrence counter, NO GitHub issue | typed business errors (Day 98 Cat D) — audit trail kept |
| `create-issue` | error stored + GitHub issue + 13-task IRP mission spawned | real unhandled crashes (`Uncaught Error:` without `ConvexError:`) |

## ConvexError vs Uncaught Error

The Convex runtime distinguishes two error families at the platform-log layer:

- **`Uncaught ConvexError: <payload>`** — a `throw new ConvexError({code,...})`
  from inside a handler. The function returned successfully (from the platform's
  perspective) by throwing a typed contract refusal. The caller receives a
  structured error with a `data` field. **These are not bugs.**

- **`Uncaught Error: <message>`** — a thrown `Error` instance (or any non-Convex
  exception). The function genuinely crashed. The caller receives a generic
  500. **These are real bugs.**

The auto-IRP filter encodes this distinction. The wildcard rule

```ts
{
  functionName: "*",
  errorMessageRegex: /Uncaught ConvexError:/,
  reason: "Typed ConvexError business error — expected contract refusal, not a bug. Day 98 Cat D k17fzba8.",
  severity: "log-only",
  priority: 90,
}
```

matches any function and demotes typed-ConvexError occurrences to log-only.

The D90 transient classifier (priority 100) outranks the D98 ConvexError rule
so `Server Error\nRequest ID: ...\nUncaught ConvexError: ...` envelope shapes
that succeeded on caller-side retry are still fully skipped.

## Known typed-ConvexError catalogue (informative)

These typed errors appear regularly in the platform log and are by design.
Adding a new typed error code to a handler does NOT require updating the
filter — the wildcard rule already covers it.

| Code | Source | Meaning |
|---|---|---|
| `CLIENT_REVOKED` | `oauthDcr:*` | OAuth client `revokedAt` is set; token exchange refused. |
| `TASK_START_BLOCKED` | `tasks:start` | Task's `dependsOn` chain has at least one non-`done` predecessor. |
| `TASK_DELETE_UNAUTHORIZED` | `tasks:deleteTask` | Caller is not the task creator (RBAC). |
| `NOT_FOUND` | several | A row referenced by id does not exist. |
| `REASON_TOO_SHORT` | mandates, audit | Free-text justification missed minimum length. |

If a typed-ConvexError occurrence ever needs to escalate to a GitHub issue,
add an explicit higher-priority rule (priority > 90) targeting the specific
`functionName` and a regex tighter than `Uncaught ConvexError:`. See the
`errorMonitorFilterRules` runtime table for hot-reloadable overrides.

## Adding a new filter rule

1. Decide severity (`skip` vs `log-only`). Default to `log-only` for anything
   storage-worthy.
2. Decide priority (default 0; D98 ConvexError = 90; D90 transient = 100).
   Higher wins on tie.
3. Either edit `DEFAULT_FILTER_RULES` in `convex/errorMonitorFilters.ts` (ships
   with code; survives table wipe) OR insert into `errorMonitorFilterRules`
   table at runtime via the seeded mutation (hot-reloadable; rolls back at
   restart unless re-seeded).
4. Add a positive + negative test in `convex/errorMonitorFilters.test.ts`.
5. Update this doc's "Known typed-ConvexError catalogue" if introducing a new
   code.

## References

- `convex/errorMonitorFilters.ts` — canonical filter code + `evaluateFilter()`.
- `convex/errorMonitorFilters.test.ts` — 105 tests covering all rules.
- Day 98 Cat D friction memory: `j574pb2q3y6dfd6pzm1cww7kkh88cprm`.
- Day 90 transient classifier issue #632.
- Day 76 doctrine — "any automation that creates work must resolve it"
  (`decisions/doctrine-evidence-bound-done-2026-05-20.md`).
