---
name: vercel-env-audit
description: >
  Audit every fleet Vercel project for VERCEL_FORCE_NO_BUILD_CACHE on Production, Preview and Development, write a conformity report with paste-ready remediation commands, and notify the owner of each non-conformant project.
  Use this skill whenever the user says "vercel env audit", "audit vercel projects",
  "vercel build cache", "cache poisoning audit", "check VERCEL_FORCE_NO_BUILD_CACHE" --
  even if they don't say "vercel-env-audit" explicitly.
---

Audit layer of rule `vercel-build-cache-policy` v1.0.0. The reactive layer is the hook
`enforce-vercel-cache-policy.py`, which refuses a `vercel deploy` on a target where the
variable is not listed.

## Preconditions — measure them, never assume them

1. `command -v vercel` prints a path. If not: stop, the audit is NOT MEASURED.
2. `vercel whoami` prints an account. If it refuses: stop, NOT MEASURED. Do not hunt for a
   token in other stations' environments; report the missing access as a blocker task.
3. `vercel teams ls` lists the scopes to cover. Each scope is audited with `--scope <slug>`.

A report produced without these three is not an audit. Say which one failed, by its output.

## Workflow

**Step 1 — Inventory the projects, from the platform**

```bash
vercel project ls --scope <team>
```

The inventory is the platform's list, not a remembered list. A project named in a brief
but absent from `project ls` is reported as such.

**Step 2 — Measure each project on each target**

For each project, from a directory linked to it (`vercel link --yes --project <name> --scope <team>`
in a throwaway directory under `/tmp`, removed with the named cleanup script afterwards):

```bash
vercel env ls production  --scope <team>
vercel env ls preview     --scope <team>
vercel env ls development --scope <team>
```

A target is conformant when the listing contains the exact name `VERCEL_FORCE_NO_BUILD_CACHE`
(whole word; `VERCEL_FORCE_NO_BUILD_CACHE_OLD` is not a match). The CLI shows values
encrypted, so the audit proves the variable is SET, not that it equals `1` — the report says so.
A listing that errors is `UNMEASURED`, never `N`.

**Step 3 — Write the report**

`analysis/vercel-cache-audit-<YYYY-MM-DD>.md`, one row per project:

| project | scope | production | preview | development | conformant |
|---|---|---|---|---|---|

Cells: `Y`, `N`, or `UNMEASURED (<exit code / first error line>)`. Below the table, for every
`N`, the remediation commands ready to paste:

```bash
vercel env add VERCEL_FORCE_NO_BUILD_CACHE production  --scope <team>   # value: 1
vercel env add VERCEL_FORCE_NO_BUILD_CACHE preview     --scope <team>   # value: 1
vercel env add VERCEL_FORCE_NO_BUILD_CACHE development --scope <team>   # value: 1
```

Head the report with the command identity: `vercel --version`, `vercel whoami`, the date, and a
`not_measured:` line naming every project or target that could not be read (or `none`).

**Step 4 — Notify owners**

For each non-conformant project, `dispatch-message` to its owning orchestrator: the audit row
and the three remediation commands. The owner applies them; the auditor does not change
another project's configuration.

**Step 5 — Close**

The task's completionNote cites the report path, the ratio `conformant/audited`, the count of
`UNMEASURED` cells, and the message IDs sent.

## Rules

- `UNMEASURED` is a third state. Never fold it into `N` or `Y`.
- The project list comes from `vercel project ls`, never from memory.
- Adding the variable is the owner's act; the audit only measures and notifies.
- A missing CLI or credential stops the audit and becomes a blocker task; it is never worked
  around.
