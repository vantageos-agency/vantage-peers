# Runbook — fleet open-task counts CSV (per orchestrator, TRUE totals)

VP task: `k17f9ssm4jbpc4jyfwembkdmnd8dfekn`.

## Problem this fixes

The MCP `list_tasks` tool paginates and stops at a ~200-row page cap. When a
station's open queue exceeds that cap, the tool can only ever report a floor
("at least N"), never a true total — this is exactly how a client incident
sat urgent+open for 40 days without anyone seeing the real count. This
runbook produces a CSV of **server-side, streamed, never-page-capped** open
task counts, one row per orchestrator, computed entirely inside a Convex
query (`stats:openTaskCountsByOrchestrator`) via `for await` streaming — the
query never calls `.collect()`, so it cannot silently drop rows above any
cap and cannot OOM regardless of table size.

## What "OPEN" means here

Four task statuses are counted as open: `todo`, `in_progress`, `blocked`,
`review`. Terminal statuses (`done`, `cancelled`, `failed`) are read during
the same pass but not counted.

## Prerequisites

- `CONVEX_URL` — the target deployment's HTTPS URL (e.g.
  `https://efficient-guineapig-356.convex.cloud` for dev, or the prod
  deployment URL for a prod read). **Never** point this at prod without
  Pi/Laurent authorization per the fleet Cloud-vs-Self-host and deploy-target
  doctrine.
- The deployment's Convex functions must already include
  `stats:openTaskCountsByOrchestrator` (push with
  `CONVEX_DEPLOY_KEY=<key> npx convex dev --once` for dev, or the standard
  prod deploy flow for prod — never as part of this runbook).
- `CLERK_SECRET_KEY` and `CLERK_SERVICE_ACCOUNT_USER_ID` set in the shell
  environment (same values already used by the MCP server — see
  `mcp-server/src/serviceAccountAuth.ts`). The query is gated behind
  `withOrgScope`'s master-scope check (`view-stats-aggregated`), which
  requires a verified Clerk identity. The script mints a short-lived
  service-account JWT via the same mechanism the MCP server uses in
  production and attaches it automatically — no separate step is needed
  beyond having those two env vars set. If you only need to read
  `mcp-server/dist/src/serviceAccountAuth.js`, run `npm run build` inside
  `mcp-server/` first (the script imports the compiled output).
- Never print `CONVEX_DEPLOY_KEY`, `CLERK_SECRET_KEY`, or any other token to
  the console or into the CSV.

## Command

```bash
CONVEX_URL=https://<deployment>.convex.cloud \
CLERK_SECRET_KEY=<secret> \
CLERK_SERVICE_ACCOUNT_USER_ID=<user_id> \
node scripts/vp-fleet-stats.mjs --csv qa/fleet-open-task-counts-<YYYY-MM-DD>.csv
```

This is read-only and idempotent — re-running overwrites the same path with
fresh counts. It performs no writes to Convex.

### Direct Convex CLI equivalent (no CSV, JSON only)

```bash
npx convex run stats:openTaskCountsByOrchestrator
```

Note: `npx convex run` has no built-in Clerk-identity flag, so a bare CLI
invocation will be rejected with `RBAC_DENIED` unless the CLI session itself
resolves to a master identity. Prefer the `scripts/vp-fleet-stats.mjs --csv`
path above for a real run — it handles the service-account auth for you.

## Where the CSV lands

`qa/fleet-open-task-counts-<YYYY-MM-DD>.csv` (directories are created
automatically if missing). Pick the date the count was taken, not the date
of an incident it's investigating.

## Reading the CSV

One header row + one row per orchestrator:

| column | meaning |
|---|---|
| `orchestrator` | the value of `tasks.assignedTo` (or a `profiles.orchestratorId` with zero open tasks — see positive control below) |
| `todo` | count of open tasks in `todo` status |
| `in_progress` | count of open tasks in `in_progress` status |
| `blocked` | count of open tasks in `blocked` status |
| `review` | count of open tasks in `review` status |
| `total_open` | sum of the four columns above — the TRUE total open queue size for this orchestrator |
| `oldest_open_iso` | ISO-8601 timestamp of the oldest open task's `_creationTime`; empty string if `total_open` is 0 |
| `oldest_open_age_days` | age of that oldest open task in days at the time the CSV was generated; empty string if `total_open` is 0 |
| `count_date` | ISO date (`YYYY-MM-DD`) the count was taken — use this to compare CSVs generated on different days |

**Positive control**: an orchestrator with a peer profile (a row in
`profiles`) but zero open tasks still appears in the CSV, as an explicit
`0,0,0,0,0` row with empty `oldest_open_*` fields — it is never silently
absent. A row that is genuinely missing from the CSV means that
orchestrator has neither a peer profile nor any task ever assigned to it —
distinguishable from "checked and found zero."

**Reading `total_open` above the 200-row MCP page cap**: any `total_open`
value greater than ~200 is proof the mechanism is not page-capped — the MCP
`list_tasks` path could never report that number. If you need to
double-check a specific station's number against a second source, compare
it against `npx convex run stats:fleetStats` (which streams the same table)
rather than any MCP `list_tasks` call.

## Prod read (separate, read-only follow-up)

Proving the >200-station TRUE total in production is a deliberate follow-up,
not part of this runbook's dev verification: point `CONVEX_URL` at the prod
deployment URL and re-run the same command. This is read-only and requires
no code changes, but follow the fleet deploy-target-explicit doctrine (name
the target explicitly, never deploy as a side effect of running this
script — this script never deploys anything).
