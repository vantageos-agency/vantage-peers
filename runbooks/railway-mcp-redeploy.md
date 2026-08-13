# Runbook — Railway MCP redeploy + anti-skew envelope changes (v0.2)

Living doc, first written from the Day-156 `check_messages` P0 deploy (PR #1148 @cd4cc6e).

## Ground facts (measured firsthand)
1. The vantage-peers MCP server (Railway) AUTO-DEPLOYS on merge to `main` via Railway's GitHub integration. No manual redeploy step — the merge is the trigger.
2. **Access to a Railway project is PROBED BY THE OPERATION, never by an identity command.** `railway whoami`, `railway list` and `railway status` interrogate the ACCOUNT. They can refuse while an operation scoped to a single project succeeds, because a project-scoped credential is not an account-scoped one. To answer "can I set a variable on this service?", the probe is the corresponding read on that service — list its variable NAMES. It answers: you have access. It refuses: you are blocked, and only then.
   Two statements that are never interchangeable: **"this station carries no credential"** is a fact about the station. **"the CLI cannot do it"** is a fact about the tool. The first never demonstrates the second, and a station with no credential proves nothing about a station that has one.
3. Convex prod (`compassionate-goldfinch-737`) deploys SEPARATELY via `npx convex deploy` with a named prod key. MCP (Railway) and Convex are two INDEPENDENT deploys — the source of every skew hazard.

## Anti-skew READER-FIRST order (mandatory for any Convex return-shape change the MCP tools.ts reads)
If the reader (MCP) is behind — still reading a field the provider (Convex) no longer returns — it throws `undefined ... .length` fleet-wide (the Day-156 P0). Deploy reader-first:
1. Merge the PR to `main` (new tools.ts + new Convex land together). Pi merge token.
2. Railway auto-redeploys the MCP reader. VERIFY BY OBSERVING BEHAVIOR (not timing): call `mcp__vantage-peers__check_messages` — if the changed block is gone/tolerant while Convex is still OLD, the reader has redeployed and tolerates the old provider → zero crash window. If still present, wait and re-observe; do NOT proceed.
   A tool schema is frozen at client connection: a client already connected serves the schema it loaded, not the one the server now serves. Read a changed tool surface through a FRESH connection, never through the current client's cache.
3. THEN Convex prod, from repo ROOT, named key inline, pi-authorized:
   `CONVEX_DEPLOY_KEY='prod:compassionate-goldfinch-737|<KEY>' npx convex deploy --yes # pi-authorized: k<prod-task-id>`
   RETURNED identity must be `compassionate-goldfinch-737` (else RED, stop).
4. READ-BACK (activation, not exit code): `... npx convex run messages:checkNewMessagesEnvelope '{...}'` → confirm new keys.
5. Two-orchestrator verification: a 2nd orchestrator confirms via its own check_messages. Only then is activation closed.

## Pitfalls
- **Concluding "no access" from an identity command.** The most expensive one, because it fossilises: written down once, every station reproduces it and the false negative defends itself. Probe the operation, scoped to the service.
- **Generalising one station's credential state into a property of the tool.** Name which station was measured.
- Convex-first or both-at-once breaking change = fleet-wide crash window (Day-156 P0).
- Assuming the redeploy finished instead of observing check_messages output.
- Reading a tool surface through an already-connected client, whose schema is frozen at connection time.
- Quoted key with `|`: with `# pi-authorized:` marker a quoted key is fine; for the auth hook's dev/prod-prefix detection (no marker) use unquoted escaped pipe `prod:name\|<key>` (a quoted `|` is read as opaque and blocked).
- A messaging return carries ONLY messages — never a derived task list.
- DEV-then-PROD are two tasks (deploy-dev-and-prod-are-two-tasks).

## Changelog
- **v0.2.0** — Ground fact 2 replaced. It previously stated, as a measured fact, that the Railway CLI is unauthorized on an orchestrator VPS and that manual deploy is impossible. That conclusion came from an identity command, which does not measure operation capability, and generalised one station's credential state into a property of the tool. Written down, it made every station reproduce the same false negative and read it as confirmation. The fact now carries the probe instead of the conclusion. Adds the frozen-tool-schema pitfall, from the same measurement family.
- **v0.1.0** — First version, from the Day-156 deploy.

## Reference
Rule `.claude/rules/railway-mcp-redeploy.md`. Siblings: deploy-target-explicit, deploy-dev-and-prod-are-two-tasks, measurement-integrity, cite-the-command.