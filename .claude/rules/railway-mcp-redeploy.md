# Railway MCP redeploy is reader-first; the merge is the trigger

Always loaded. Fleet-wide, every change to a Convex return shape that the MCP `tools.ts` reads.

Class of failure addressed: the vantage-peers MCP server (Railway) and the Convex backend deploy **independently**. A PR that changes the `checkNewMessagesEnvelope` return AND its MCP reader in one commit creates a skew window. If the reader (MCP) is behind — still reading a field the provider (Convex) no longer returns — `check_messages` throws `undefined ... .length` for **every orchestrator, fleet-wide** (Day-156 P0).

## The rule

1. **The MCP server auto-deploys on merge to `main`** (Railway GitHub integration). The merge is the trigger — no manual redeploy step is needed. **Access to a Railway project is probed BY THE OPERATION, never by an identity command:** `railway whoami`/`list`/`status` interrogate the ACCOUNT and can refuse while an operation scoped to a single project succeeds. `"this station carries no credential"` is a fact about the station; `"the CLI cannot do it"` is a fact about the tool — the first never proves the second. Name the station you measured.
2. **Reader-first order.** For any envelope/return-shape change the MCP reads: merge → let Railway redeploy the MCP reader → **verify by OBSERVING `check_messages` behavior** (the changed block is gone/tolerant while Convex is still old = zero crash window), and read a changed tool surface **through a FRESH connection** — a client's tool schema is frozen at connection, so an already-connected client serves the schema it loaded, not the one the server now serves → **then** deploy Convex prod. Never Convex-first, never both-at-once for a breaking change.
3. **Verify by behavior, not timing.** Confirm the reader redeployed by the tool's own output, never by assuming the deploy finished.
4. **Convex prod deploy** is from repo ROOT, named key inline, `# pi-authorized: k<id>`, with an identity read-back (`convex run checkNewMessagesEnvelope`) and a second-orchestrator confirmation.
5. **A messaging return carries only messages** — never a derived task list. A "pending on me" view is a dedicated opt-in tool, not `check_messages`.

## Banned

- Concluding "no access" from an identity command (`whoami`/`status`), or generalising one station's credential state into a property of the tool — probe the operation, scoped to the service, and name the station measured.
- Reading a changed tool surface through an already-connected client, whose schema is frozen at connection time — use a fresh connection.
- Deploying Convex prod before observing the MCP reader has redeployed.
- A breaking envelope change shipped both-at-once across the two systems.
- Reading a deploy exit code as activation instead of a read-back + 2-orchestrator check.

## Reference
Runbook: `runbooks/railway-mcp-redeploy.md`. Siblings: `deploy-target-explicit.md`, `deploy-dev-and-prod-are-two-tasks.md`, `measurement-integrity.md`.

*Origin: Day-156 `check_messages` P0 (PR #1148, task k174bz6h7hx7jpxy40t4nzhds58bvqrx).*
