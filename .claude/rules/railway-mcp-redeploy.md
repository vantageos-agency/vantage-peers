# Railway MCP redeploy is reader-first; the merge is the trigger

Always loaded. Fleet-wide, every change to a Convex return shape that the MCP `tools.ts` reads.

Class of failure addressed: the vantage-peers MCP server (Railway) and the Convex backend deploy **independently**. A PR that changes the `checkNewMessagesEnvelope` return AND its MCP reader in one commit creates a skew window. If the reader (MCP) is behind — still reading a field the provider (Convex) no longer returns — `check_messages` throws `undefined ... .length` for **every orchestrator, fleet-wide** (Day-156 P0).

## The rule

1. **The MCP server auto-deploys on merge to `main`** (Railway GitHub integration). There is no manual redeploy. The `railway` CLI on the VPS is unauthorized — do not `railway up`, do not `railway login`.

   **"The merge is the trigger" is true of CODE and FALSE of CONFIGURATION.** An environment variable does not merge. On 2026-09-30 three stations spent an evening hunting a Railway credential to set one variable on the vantage-peers service; none exists, by this rule, and the hunt was for something the doctrine deliberately forbids. Theta measured the identical gap on the vantageos-crm service. So:

   - A change to a **deployed service's configuration** — an environment variable, a scaling setting, a domain — has **no path through a merge** and therefore no path through any station. It belongs to the operator's dashboard, or to a project token minted on purpose for that service, knowing it opens a door this rule otherwise closes.
   - **A station that cannot reach it says so and stops.** It does not hunt for a credential, and it does not widen the rule for one variable. An hour was lost to the first; the second is how a deliberate closure becomes an accidental opening.
   - **A variable NAMED like a credential is not a credential, and finding one does not reopen this door.** `sigma-vps` carries `RAILWAY_ACCOUNT_TOKEN` in its `.env.local`, 36 characters, UUID-shaped — and it authenticates as nothing. Probed on the query its own type answers, against a negative control on the same probe: `{"query":"query { projectToken { projectId environmentId } }"}` returns `Project Token not found` for the station's token and `Project Token not found` for the all-zeros token, byte for byte. A `me` query returns `Not Authorized` for both. So the station's credential is INDISTINGUISHABLE FROM ABSENT, which is worse than absent: the next station to find that name will read it as proof this rule is wrong and spend the same hour. Before treating any such variable as a way in, run the probe its own type answers WITH a negative control — a refusal on the wrong query proves nothing, and a refusal identical to a bogus token's is the measurement.
   - **Prefer moving the decision INTO the code.** A default that must be corrected by configuration is a default reachable only by whoever holds the dashboard; a default corrected in the source reaches production by the path that already works. That is the resolution taken for `VANTAGE_ACTOR_CREDENTIAL_MODE` rather than continuing to chase the variable.
2. **Reader-first order.** For any envelope/return-shape change the MCP reads: merge → let Railway redeploy the MCP reader → **verify by OBSERVING `check_messages` behavior** (the changed block is gone/tolerant while Convex is still old = zero crash window) → **then** deploy Convex prod. Never Convex-first, never both-at-once for a breaking change.
3. **Verify by behavior, not timing.** Confirm the reader redeployed by the tool's own output, never by assuming the deploy finished.
4. **Convex prod deploy** is from repo ROOT, named key inline, `# pi-authorized: k<id>`, with an identity read-back (`convex run checkNewMessagesEnvelope`) and a second-orchestrator confirmation.
5. **A messaging return carries only messages** — never a derived task list. A "pending on me" view is a dedicated opt-in tool, not `check_messages`.

## Banned

- `railway up` / interactive `railway login` from an orchestrator VPS (unauthorized; the merge is the trigger).
- Deploying Convex prod before observing the MCP reader has redeployed.
- A breaking envelope change shipped both-at-once across the two systems.
- Reading a deploy exit code as activation instead of a read-back + 2-orchestrator check.

## Reference
Runbook: `runbooks/railway-mcp-redeploy.md`. Siblings: `deploy-target-explicit.md`, `deploy-dev-and-prod-are-two-tasks.md`, `measurement-integrity.md`.

*Origin: Day-156 `check_messages` P0 (PR #1148, task k174bz6h7hx7jpxy40t4nzhds58bvqrx).*
