# Runbook — Railway MCP rollout: Convex first, MCP last, boot check (v0.2)

Living doc, first written from the Day-156 `check_messages` P0 (task `k174bz6h7hx7jpxy40t4nzhds58bvqrx`, PR #1148 `@cd4cc6e`), revised (v0.2) after the 2026-10-12 outage in which Railway auto-deployed an MCP that called Convex functions prod did not have yet (task `k1716jehh2mhy4xah4js2804g58g4nsc`). Base agent: `dev-railway-expert`.

## Ground facts (measured firsthand, not assumed)

1. **The vantage-peers MCP server (Railway) does NOT auto-deploy on merge.** Auto-deploy of `main` is turned OFF on the service (a Railway dashboard setting; no station can change it). A merge to `main` ships nothing to Railway. The MCP ships only as the **last step of a rollout token**, after the Convex rollout and its read-back, triggered from the Railway dashboard by the token holder.
2. **The `railway` CLI on the orchestrator VPS is UNAUTHORIZED** (`railway status` → `Unauthorized. Please login with railway login`). You **cannot** `railway up`, and you **must not** attempt interactive `railway login`. The MCP ships through the token holder's dashboard action.
3. **Convex prod (`compassionate-goldfinch-737`) deploys SEPARATELY** via `npx convex deploy` with a named prod key. The MCP server (Railway) and the Convex backend are **two independent deploys** — this is the source of every deploy-skew hazard below.

## The rollout order: Convex first, MCP last — and the boot check under it

The MCP calls Convex functions by name. An MCP that goes out before the Convex build that has those functions (or arguments) fails on every call that touches them. So one rollout token covers both systems, in this order:

1. **Merge the PR to `main`** (the new `tools.ts` and the new Convex code land together). Requires the Pi merge token. Nothing reaches Railway.
2. **Regenerate the manifest if you touched the public surface**: `node scripts/gen-backend-manifest.mjs` (the drift test `convex/__tests__/backendContract.test.ts` fails otherwise). If the MCP now calls a new function, add it to `MCP_CALLED_FUNCTIONS` in `mcp-server/src/backendContract.ts` (`mcp-server/test/backend-compat-boot.test.ts` fails otherwise). If the MCP now passes a NEW ARGUMENT to a function that already exists, bump `BACKEND_CONTRACT_VERSION` and `REQUIRED_CONTRACT_VERSION` together: a name list cannot see that skew.
3. **Deploy Convex prod** — from the repository **ROOT**, named key **inline**, with the Pi-authorized marker (see `.claude/rules/deploy-target-explicit.md`). Read the **RETURNED** identity — it must be `compassionate-goldfinch-737`. If it differs, verdict RED, stop.
4. **READ-BACK (activation, not the deploy exit code)**: run a prod query whose RESULT proves the new thing is live. For the contract itself: `meta:backendContract` as the service account lists the new function. A second orchestrator confirms.
5. **THEN ship the MCP** (Railway dashboard, deploy the merged commit). **VERIFY**: `railway logs` shows `backend compatible: N called functions present, contract vN`, the healthcheck passes, and a live tool call (`check_messages`) works.

### What the boot check does when the order was wrong

`server-http.ts` (and stdio `server.ts`) call `meta:backendContract` BEFORE binding a port. If the backend lacks the manifest, is older than `REQUIRED_CONTRACT_VERSION`, or lacks any function in `MCP_CALLED_FUNCTIONS`, the process logs `BACKEND INCOMPATIBLE (<reason>) -- BOOT CHECK refused to serve: ...` naming the missing functions, and exits 1. The new deployment fails its healthcheck; Railway keeps the previous deployment serving. The reasons are distinct on purpose:

| reason | meaning | action |
|---|---|---|
| `missing-functions` | named functions absent from the backend | deploy Convex first |
| `no-manifest` | backend predates `meta:backendContract` | deploy Convex first |
| `version-too-old` | backend contract version below the MCP's requirement | deploy Convex first |
| `refused` | the door raised `RBAC_DENIED`: wrong identity | credential problem, not a deploy-order problem |
| `cannot-authenticate` | the MCP could not mint its service-account identity | Clerk env on Railway |
| `unreachable` | no answer after 4 attempts (1s, 2s, 4s backoff) | backend / network |
| `malformed` | the answer is not a manifest | investigate, do not retry blindly |

Limits, stated: the check sees a missing function, not a changed argument (rule above); it runs at boot only, so a Convex deploy that removes a function under a running MCP is not detected until the next boot.

### A change that REMOVES or renames something the running MCP reads (Day-156 class)

Between step 3 and step 5 the OLD MCP is live against the NEW backend. If the Convex change drops a field the old MCP reads, `check_messages`-style crashes return. Split it: **expand** (additive Convex change; the MCP tolerates both shapes) → ship MCP → **contract** (the removal, in a later rollout). Never remove and consume in one rollout.

## Pitfalls (each cost real time or an incident)

- **`railway` CLI unauthorized** → no CLI deploy. Don't burn time trying to `railway up`; the token holder ships from the dashboard.
- **MCP-first (or both-at-once)** = the 2026-10-12 outage: the MCP calls functions the backend does not have. The boot check now refuses to serve in that case; do not rely on it as the plan.
- **Removal and consumer in one rollout** = the Day-156 P0 (old MCP against new backend). Expand, ship, contract.
- **Assuming the Convex deploy finished** instead of reading back the new function → you ship the MCP into a backend that is not ready, and the boot check (correctly) refuses it.
- **Quoted key + `|`**: for a Convex deploy carrying `# pi-authorized: k<id>`, a quoted key `'prod:...|...'` is fine (the auth hook reads the marker). For commands that rely on the auth hook's **dev/prod-prefix detection** (no marker), the key must be **unquoted with an escaped pipe** `prod:name\|<key>` — a quoted value with `|` is read as opaque and blocked (`deploy-target-explicit` regex stops at `|`).
- **A messaging return must carry ONLY messages** — never a derived task list. The pendingOnYou block that caused this incident was removed entirely; a "pending on me" view belongs in a dedicated opt-in tool, not `check_messages`.
- **DEV-then-PROD are two tasks** (`deploy-dev-and-prod-are-two-tasks`): DEV verify + Pi firsthand + a separate prod task with token.

## Reference
- Incident memory (global): `check_messages P0 fleet-wide outage — reader-first cross-system deploy`; 2026-10-12 MCP-ahead-of-Convex outage, task `k1716jehh2mhy4xah4js2804g58g4nsc`.
- Code: `mcp-server/src/backendContract.ts`, `convex/meta.ts`, `convex/lib/backendManifest.ts`, `scripts/gen-backend-manifest.mjs`.
- Rule: `.claude/rules/railway-mcp-redeploy.md` (always-loaded short form).
- Sibling rules: `deploy-target-explicit.md`, `deploy-dev-and-prod-are-two-tasks.md`, `measurement-integrity.md`.
