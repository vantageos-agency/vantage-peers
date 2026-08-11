# Runbook — Railway MCP redeploy + anti-skew envelope changes (v0.1)

Living doc, first written from the Day-156 `check_messages` P0 deploy (task `k174bz6h7hx7jpxy40t4nzhds58bvqrx`, PR #1148 `@cd4cc6e`). Base agent: `dev-railway-expert`.

## Ground facts (measured firsthand, not assumed)

1. **The vantage-peers MCP server (Railway) AUTO-DEPLOYS on merge to `main`** via Railway's GitHub integration. There is **no manual redeploy step** — the merge is the trigger.
2. **The `railway` CLI on the orchestrator VPS is UNAUTHORIZED** (`railway status` → `Unauthorized. Please login with railway login`). You **cannot** `railway up` manually, and you **must not** attempt interactive `railway login`. Rely on the GitHub auto-deploy.
3. **Convex prod (`compassionate-goldfinch-737`) deploys SEPARATELY** via `npx convex deploy` with a named prod key. The MCP server (Railway) and the Convex backend are **two independent deploys** — this is the source of every deploy-skew hazard below.

## The anti-skew (READER-FIRST) order — mandatory for any change to a Convex return shape that the MCP `tools.ts` reads

Class of failure: a PR changes the Convex `checkNewMessagesEnvelope` return (removes/renames a field) AND updates the MCP `tools.ts` reader in the same PR. Because the two systems deploy independently, there is a window where one is new and the other old. If the **reader (MCP) is behind** — still reads a field the **provider (Convex) no longer returns** — it throws (`undefined is not an object ... .length`) fleet-wide. That is exactly the Day-156 P0.

Deploy **reader-first** so the reader tolerates BOTH old and new provider before the provider changes:

1. **Merge the PR to `main`** (both the new `tools.ts` and the new Convex code land together). Requires the Pi merge token.
2. **Railway auto-redeploys the MCP server** with the new `tools.ts`. **VERIFY BY OBSERVING BEHAVIOR**, never by timing/assumption: call `mcp__vantage-peers__check_messages`. If the changed rendering is gone/tolerant (e.g. the removed block no longer appears) **while Convex prod is still the OLD envelope**, the MCP reader has redeployed and tolerates the old provider → **zero crash window**. If the block is still present, the redeploy has not landed yet — wait and re-observe; do NOT proceed to step 3.
3. **THEN deploy Convex prod** — from the repository **ROOT**, named key **inline**, with the Pi-authorized marker:
   ```
   CONVEX_DEPLOY_KEY='prod:compassionate-goldfinch-737|<KEY>' npx convex deploy --yes # pi-authorized: k<prod-task-id>
   ```
   Read the **RETURNED** identity — it must be `compassionate-goldfinch-737`. If the returned name differs, verdict RED, stop (deploy-target-explicit).
4. **READ-BACK (activation, not the deploy exit code)**:
   ```
   CONVEX_DEPLOY_KEY=prod:compassionate-goldfinch-737\|<KEY> npx convex run messages:checkNewMessagesEnvelope '{"recipient":"<role>","recipientInstanceId":"<inst>"}'
   ```
   Confirm the new envelope keys (e.g. `['messages','nextSince','staleInProgress','truncated']`, no removed field).
5. **Two-orchestrator verification**: a second orchestrator confirms via its own `check_messages` that the removed block is gone. Only then is the activation officially closed.

## Pitfalls (each cost real time or an incident)

- **`railway` CLI unauthorized** → no manual redeploy; the merge is the only trigger. Don't burn time trying to `railway up`.
- **Convex-first (or a both-at-once breaking change)** = fleet-wide crash window. This IS the Day-156 P0. Always reader-first.
- **Assuming the redeploy finished** instead of observing `check_messages` output → you deploy Convex into a stale reader and recreate the crash.
- **Quoted key + `|`**: for a Convex deploy carrying `# pi-authorized: k<id>`, a quoted key `'prod:...|...'` is fine (the auth hook reads the marker). For commands that rely on the auth hook's **dev/prod-prefix detection** (no marker), the key must be **unquoted with an escaped pipe** `prod:name\|<key>` — a quoted value with `|` is read as opaque and blocked (`deploy-target-explicit` regex stops at `|`).
- **A messaging return must carry ONLY messages** — never a derived task list. The pendingOnYou block that caused this incident was removed entirely; a "pending on me" view belongs in a dedicated opt-in tool, not `check_messages`.
- **DEV-then-PROD are two tasks** (`deploy-dev-and-prod-are-two-tasks`): DEV verify + Pi firsthand + a separate prod task with token.

## Reference
- Incident memory (global): `check_messages P0 fleet-wide outage — reader-first cross-system deploy`.
- Rule: `.claude/rules/railway-mcp-redeploy.md` (always-loaded short form).
- Sibling rules: `deploy-target-explicit.md`, `deploy-dev-and-prod-are-two-tasks.md`, `measurement-integrity.md`.
