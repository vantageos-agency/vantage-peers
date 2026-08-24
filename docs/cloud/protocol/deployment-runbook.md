# Deploying the protocol layer — DEV then PROD

VantagePeers Cloud only. This page is the protocol-layer (`agents`/`agent_relations`/`agent_credentials`/`requireAgentCredentialMatch`) executor checklist. It points at the general deployment doctrine rather than restating it — read `runbooks/railway-mcp-redeploy.md` and `.claude/rules/railway-mcp-redeploy.md` first; this page adds only what is specific to shipping this layer.

## The cap's deployment sequence — pointer, not a restatement

`analysis/le-cap/le-cap.md @ e3c1ffd6` §5 "Déployer un client" sets the general two-step Convex sequence (dev proof by activation read-back, then prod under the deployment-authorization token, from repo root on a full checkout, target named on the command, identity read back). This runbook does not restate that text — see the cap directly for the prose. What follows is what an executor of THIS layer needs on top of it.

## Provider-first ordering for THIS layer

`agents.ts`, `agentRelations.ts`, `agentCredentials.ts`, and the `requireAgentCredentialMatch` lock in `convex/lib/auth.ts` are Convex-side only — none of them change an MCP `tools.ts` return shape that a reader depends on for THIS PR. That means the general anti-skew reader-first rule (`.claude/rules/railway-mcp-redeploy.md`) does not create a crash window for this specific change **unless** a companion PR also changes `mcp-server/src/tools.ts` to expose these mutations/queries as MCP tools — if it does, treat that companion change under the SAME reader-first order: merge → observe the MCP reader has redeployed (behavior, not timing) → only then deploy Convex prod.

## DEV — `convex dev --once`, activation read-back

1. From the repo root, on a full checkout of this branch:
   ```
   npx convex dev --once
   ```
2. **Prove the change by activation, not by exit code.** Read back the schema/table presence with a query that NAMES the deployment the tool actually reports, e.g.:
   ```
   npx convex run agents:listAgentsByOrg '{"orgSlug":"<dev-org-slug>"}'
   ```
   Confirm the returned deployment name in the CLI output is the DEV deployment you targeted — never assume it from the command you typed.
3. Exercise the lock end-to-end in dev before touching prod: mint a credential (`agentCredentials:mintAgentCredential`), present it on a guarded surface (e.g. `tasks:create` with `agentCredentialSecret` + `callerOrchestrator`), and confirm both poles — matching name passes, mismatched name refuses `AGENT_IDENTITY_MISMATCH`.

## PROD — provider-first, named target, Pi-authorized token, identity read-back

1. **MCP/Railway auto-redeploys on merge to `main`** — there is no manual redeploy step (`.claude/rules/railway-mcp-redeploy.md`). If this change ships with a companion `tools.ts` edit, wait for and OBSERVE that redeploy (via `check_messages` or an equivalent live call) before step 2. If it does not, proceed directly.
2. **THEN deploy Convex prod** — from the repository root, on a full checkout, the target NAMED inline, under the Pi authorization marker:
   ```
   CONVEX_DEPLOY_KEY='prod:compassionate-goldfinch-737|<KEY>' npx convex deploy --yes # pi-authorized: k<prod-task-id>
   ```
3. **Read the RETURNED identity** — it must be `compassionate-goldfinch-737`. A returned name that differs is a stop, not a retry (deploy-target-explicit doctrine).
4. **Activation read-back** — run a prod query/mutation whose RESULT proves the new table/mutation is live, e.g.:
   ```
   CONVEX_DEPLOY_KEY=prod:compassionate-goldfinch-737\|<KEY> npx convex run agents:listAgentsByOrg '{"orgSlug":"<prod-org-slug>"}'
   ```
   A successful call that returns `[]` for a real, already-provisioned org is NOT proof of a fresh empty table by itself — see "the two-zeros rule" below.
5. **Second-orchestrator confirmation** — a second orchestrator re-runs the same read-back independently before the activation is considered closed (mirrors the `railway-mcp-redeploy.md` two-orchestrator step).

## The two-zeros rule

An empty result and a never-deployed table are NOT the same zero. `agents:listAgentsByOrg` returning `[]` for an org that has zero registered agents (a real, present, empty table) must be distinguished from a call that fails outright because the `agents` table/mutation does not exist yet in that deployment (a schema not yet pushed). Confirm presence by a call that would ERROR on a genuinely absent table/function (e.g. an unknown-function error, not a valid empty array) before reading an empty array as "deployed and empty."

## What is NOT yet true — do not imply done

- **The prod scoped-identity smoke test** (mint a real per-agent credential in prod, present it on a guarded surface, confirm both `AGENT_IDENTITY_MISMATCH` poles against prod data) has **not** been run as of this writing.
- **Org-admin self-service** for provisioning (an org-admin, not master, calling `provisionOrganization`) is a separate, already-approved change (PR #1224 area) — not part of this protocol layer's scope, and not to be conflated with it.
- Both of the above fold into task `k17fnztpwqgppgdbjebbjcdyh58d3kbq`. This runbook does not claim they are done; it names them so nothing is silently implied complete.
