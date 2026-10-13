# Railway MCP ships LAST, under the rollout token; the boot check refuses a backend that is behind

Always loaded. Fleet-wide, every change that crosses the Convex backend and the MCP server: a new Convex function or argument the MCP calls, or a change to a Convex return shape the MCP `tools.ts` reads.

Class of failure addressed: the vantage-peers MCP server (Railway) and the Convex backend ship **independently**, so any change that spans both has a skew window. Two incidents, opposite directions:

- Day-156 P0 (reader behind): a PR changed the `checkNewMessagesEnvelope` return AND its MCP reader in one commit; the MCP was behind a provider that no longer returned a field it read, and `check_messages` threw `undefined ... .length` for every orchestrator.
- 2026-10-12 (MCP ahead of Convex): Railway auto-deployed `main` on merge. The new MCP called `oauth:rotateRefreshToken` and passed new arguments while Convex prod was still an older build; clients failed for hours. (task k1716jehh2mhy4xah4js2804g58g4nsc)

The second is what auto-deploy-on-merge guarantees whenever the MCP merge precedes the Convex rollout. So the order is now fixed and enforced twice: by process (the rollout token) and by code (the boot check).

## The rule

1. **The MCP server does NOT auto-deploy on merge.** Auto-deploy of `main` on the vantage-peers Railway service is OFF: Pi deleted the service's GitHub deployment trigger (id 5c691157-235c-4cac-9761-c741357d487e, repo vantageos-agency/vantage-peers, branch main) on 2026-10-13 through the Railway GraphQL API (`deploymentTriggerDelete`), and `deploymentTriggers` reads back empty. Merging to `main` ships nothing to Railway. The MCP ships **only as the last step of a rollout token**, after the Convex rollout and its read-back. The `railway` CLI on the VPS is unauthorized: do not `railway up`, do not `railway login`. Shipping the merged commit is an explicit redeploy by the holder of the rollout token: the Railway GraphQL mutation `serviceInstanceRedeploy` (or `serviceInstanceDeployV2` for a specific commit) with a project token, or the dashboard's Deploy button. Read back the new deployment's commit and `/health` after it.

   **The MCP refuses an incompatible backend at boot.** Before it binds a port (HTTP, `mcp-server/server-http.ts`) or opens a transport (stdio, `mcp-server/server.ts`), the MCP calls `meta:backendContract` (`convex/meta.ts`) on the backend it is pointed at and requires: the manifest exists, `contractVersion >= REQUIRED_CONTRACT_VERSION`, and every function in `MCP_CALLED_FUNCTIONS` (`mcp-server/src/backendContract.ts`) is in the manifest. On any failure it logs `BACKEND INCOMPATIBLE (<reason>)`, **naming the missing functions**, and exits 1 before listening, so Railway's healthcheck fails the new deployment and the **previous deployment keeps serving**. A backend that predates the manifest door is itself a refusal ("backend has no contract manifest"). This is the safety net under the process, not a substitute for it: the check sees a missing function, **not** a changed argument (a new argument to an existing function requires bumping `BACKEND_CONTRACT_VERSION` in `convex/lib/backendManifest.ts` and `REQUIRED_CONTRACT_VERSION` together), and it runs at boot only. The manifest is generated (`node scripts/gen-backend-manifest.mjs`) and the MCP's called-function list is pinned to its source; both drift tests fail the build, so a call site added without updating the list cannot merge.

   **A merge no longer ships the MCP, and it never shipped CONFIGURATION.** An environment variable does not merge. Three stations once spent an evening hunting a Railway credential to set one variable on the vantage-peers service: no station holds one that authenticates, and the hunt was for something this rule deliberately forbids. The identical gap was measured independently on the vantageos-crm service. So:

   - A change to a **deployed service's configuration** — an environment variable, a scaling setting, a domain — has **no path through a merge** and therefore no path through any station. It belongs to the operator's dashboard, or to a project token minted on purpose for that service, knowing it opens a door this rule otherwise closes.
   - **A station that cannot reach it says so and stops.** It does not hunt for a credential, and it does not widen the rule for one variable. An hour was lost to the first; the second is how a deliberate closure becomes an accidental opening.
   - **A variable NAMED like a credential is not a credential, and finding one does not reopen this door.** A station's environment may hold a Railway-shaped value that authenticates as nothing, which is worse than plain absence: the NAME alone will convince the next reader this rule is wrong and buy it the same hour. Before treating any such variable as a way in, probe it with the query ITS OWN TYPE answers — a project-scoped token cannot answer an account-identity query, so a refusal there says nothing about validity — and run the same probe against a deliberately bogus value. A refusal identical to the bogus one's is the measurement; a refusal on the wrong query is a non-result.
   - **Prefer moving the decision INTO the code — and ONLY for a default whose safe value is identical in every deployment.** A default that must be corrected by configuration is a default reachable only by whoever holds the dashboard; a fail-closed default written in the source reaches production by the path that already works, reviewable and testable. The bound is not optional: this licenses a FAIL-CLOSED DEFAULT and never a secret, never an endpoint, never any per-deployment value. Without it the clause reads as permission to hardcode production configuration, which is the opposite of what it is for.
2. **Convex first, MCP last, one rollout token.** Merge, then the Convex prod rollout, then a **read-back** (the new function answers; a second orchestrator confirms), and **only then** the MCP. Never MCP-first, never both-at-once. The boot check makes a wrong order fail closed rather than serve broken.
3. **Verify by behavior, not timing.** Confirm Convex by a read-back of the thing that changed, and the MCP by its own boot line (`backend compatible: N called functions present`) in `railway logs` plus a live tool call. Never by assuming the deploy finished.
4. **A change that REMOVES or renames something the running MCP reads is not one rollout.** Between the Convex rollout and the MCP rollout the OLD MCP is live against the NEW backend (that is the Day-156 window). Split it: expand (additive Convex change, the MCP reads both), MCP ships, then contract (the removal, in a later rollout). Convex-first is safe for additive changes only.
5. **Convex prod deploy** is from repo ROOT, named key inline, `# pi-authorized: k<id>`, with an identity read-back (`convex run checkNewMessagesEnvelope`) and a second-orchestrator confirmation.
6. **A messaging return carries only messages** — never a derived task list. A "pending on me" view is a dedicated opt-in tool, not `check_messages`.

## Banned

- `railway up` / interactive `railway login` from an orchestrator VPS (unauthorized).
- Turning auto-deploy back on, or shipping the MCP before the Convex read-back of the same rollout.
- Silencing or bypassing the boot check to get a deploy through. (`VP_BOOT_CHECK_OFFLINE=1` exists only for the stdio postbuild smoke, `mcp-server/scripts/boot-check.mjs`; the HTTP entry has no switch.)
- Adding a Convex call to the MCP without adding it to `MCP_CALLED_FUNCTIONS`, or passing a new argument to an existing function without bumping the contract version.
- A removal or rename of something the running MCP reads shipped in the same rollout as the MCP change.
- Reading a deploy exit code as activation instead of a read-back + 2-orchestrator check.

## Reference
Runbook: `runbooks/railway-mcp-redeploy.md`. Code: `mcp-server/src/backendContract.ts`, `convex/meta.ts`, `convex/lib/backendManifest.ts`. Siblings: `deploy-target-explicit.md`, `deploy-dev-and-prod-are-two-tasks.md`, `measurement-integrity.md`.

*Origin: Day-156 `check_messages` P0 (PR #1148, task k174bz6h7hx7jpxy40t4nzhds58bvqrx); revised after the 2026-10-12 MCP-ahead-of-Convex outage (task k1716jehh2mhy4xah4js2804g58g4nsc).*
