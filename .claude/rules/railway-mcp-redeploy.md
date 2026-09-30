# Railway MCP redeploy is reader-first; the merge is the trigger

Always loaded. Fleet-wide, every change to a Convex return shape that the MCP `tools.ts` reads.

Class of failure addressed: the vantage-peers MCP server (Railway) and the Convex backend deploy **independently**. A PR that changes the `checkNewMessagesEnvelope` return AND its MCP reader in one commit creates a skew window. If the reader (MCP) is behind — still reading a field the provider (Convex) no longer returns — `check_messages` throws `undefined ... .length` for **every orchestrator, fleet-wide** (Day-156 P0).

## The rule

1. **The MCP server auto-deploys on merge to `main`** (Railway GitHub integration). There is no manual redeploy. The `railway` CLI on the VPS is unauthorized — do not `railway up`, do not `railway login`.

   **"The merge is the trigger" is true of CODE and FALSE of CONFIGURATION.** An environment variable does not merge. Three stations once spent an evening hunting a Railway credential to set one variable on the vantage-peers service: no station holds one that authenticates, and the hunt was for something this rule deliberately forbids. The identical gap was measured independently on the vantageos-crm service. So:

   - A change to a **deployed service's configuration** — an environment variable, a scaling setting, a domain — has **no path through a merge** and therefore no path through any station. It belongs to the operator's dashboard, or to a project token minted on purpose for that service, knowing it opens a door this rule otherwise closes.
   - **A station that cannot reach it says so and stops.** It does not hunt for a credential, and it does not widen the rule for one variable. An hour was lost to the first; the second is how a deliberate closure becomes an accidental opening.
   - **A variable NAMED like a credential is not a credential, and finding one does not reopen this door.** A station's environment may hold a Railway-shaped value that authenticates as nothing, which is worse than plain absence: the NAME alone will convince the next reader this rule is wrong and buy it the same hour. Before treating any such variable as a way in, probe it with the query ITS OWN TYPE answers — a project-scoped token cannot answer an account-identity query, so a refusal there says nothing about validity — and run the same probe against a deliberately bogus value. A refusal identical to the bogus one's is the measurement; a refusal on the wrong query is a non-result.
   - **Prefer moving the decision INTO the code — and ONLY for a default whose safe value is identical in every deployment.** A default that must be corrected by configuration is a default reachable only by whoever holds the dashboard; a fail-closed default written in the source reaches production by the path that already works, reviewable and testable. The bound is not optional: this licenses a FAIL-CLOSED DEFAULT and never a secret, never an endpoint, never any per-deployment value. Without it the clause reads as permission to hardcode production configuration, which is the opposite of what it is for.
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
