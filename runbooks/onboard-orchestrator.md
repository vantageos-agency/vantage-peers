# Onboard a new orchestrator station (VantagePeers Cloud)

Use this when a new orchestrator (a new workspace under `/root/coding/<name>-workspace`) must reach
VantagePeers and VantageRegistry. One command does it, and nothing has to be looked up.
`vps-workspace-setup` calls this script rather than restating it.

## The command

From the `vantage-memory` repo root, as the Unix user the station runs under:

```bash
scripts/onboard-orchestrator.sh <role> /root/coding/<role>-workspace --dry-run   # plan only
scripts/onboard-orchestrator.sh <role> /root/coding/<role>-workspace             # do it
scripts/onboard-orchestrator.sh <role> /root/coding/<role>-workspace \
    --repo <owner>/<role>-workspace --project <project-slug>                     # do it, and route its repo
```

Pass `--repo` and `--project` whenever the station has a GitHub repository. They always go together.

It ends with `OK: <role> onboarded`. Anything else is a failure, and the script names the step that failed.

## First-launch check (the operator, before opening the station)

```bash
cd /root/coding/<role>-workspace && claude mcp list
```

`vantage-peers` and `vantage-registry` must both read `Connected`. Anything else means: do not launch, re-run the script, and read its error.

## What it does, and the trap each step closes

Vitruve took four launches on 2026-10-05 (friction memory j571rgt58mdzv734b42fcxe87n8fqy3p). Each trap below is now a step of the script.

### 1. Credential: the agent does not exist

- **Fails:** `set_summary` returns `AGENT_IDENTITY_MISMATCH`, and every write is refused.
- **Check:** the mint plan says `REGISTER+MINT`, `SKIP` (already live) or `BLOCKED` (deactivated row).
- **Fix applied:** `scripts/mint-station-agents.mjs` runs under our org-admin identity (`CLERK_SECRET_KEY_VANTAGE_PEERS` and `CLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS` from the gitignored `.env.local`), against prod `compassionate-goldfinch-737`. The org comes from the admin JWT and is always `perello-consulting-1782214787064836324`. The secret is written only to `<secrets-dir>/<role>.secret`, mode 600. The run is idempotent; rotating a credential is `--rotate` on the mint script.

### 2. Wiring: no VantagePeers server in the workspace

- **Fails:** the station has no `vantage-peers` or `vantage-registry` tools at all.
- **Fix applied:** the script installs `.claude/scripts/mcp-headers.sh` with `ROLE` set to the role, and adds both http servers to `.mcp.json` with that helper. The workspace's other servers are kept, and the file is set to mode 600. The workspace never holds a secret; the helper reads it at connect time.

### 3. Trust: the helper never runs

- **Fails:** in an untrusted workspace Claude Code does not execute `headersHelper`. The servers then connect with no headers, or fall back to OAuth and get a 404.
- **Check:** `~/.claude.json` → `projects["<workspace>"].hasTrustDialogAccepted` is `true`.
- **Fix applied:** the script sets it, with an atomic rewrite that keeps the file mode.

### 4. Approval: the servers wait for a click

- **Fails:** servers from `.mcp.json` show `⏸ Pending approval` and never connect in an unattended session.
- **Check:** `.claude/settings.local.json` → `enabledMcpjsonServers` lists every server in `.mcp.json`.
- **Fix applied:** the script writes the union of the servers already listed and every server in `.mcp.json`. It makes sure `.claude/settings.local.json` is gitignored, and fails if it is not.

### 5. Needs-auth cache: one failed start poisons the others

- **Fails:** after one failed start, Claude Code records the server name in `~/.claude/mcp-needs-auth-cache.json`. Every later session of that Unix user then skips it as "authentication required", in every workspace, because the key is the server name.
- **Fix applied:** the script removes the `vantage-peers` and `vantage-registry` entries.

### 6. Profile: nobody can write to the station

- **Fails:** `send_message channel=<role>` returns `recipient error … ne correspond à aucun destinataire`, because recipients come from `profiles` rows.
- **Fix applied:** the script runs `set_summary` under the station's own credential and fails unless the response is a success.

### 7. Repo mapping: GitHub events never reach the station

- **Fails:** webhook events and review routing for the station's repo go nowhere, because no `githubRepoMapping` row names the role.
- **Check:** `githubRepoMapping:getByRepo` returns the row with the role and the project.
- **Fix applied** (with `--repo` and `--project`): `scripts/add-repo-mapping.mjs` upserts the row and reads it back. The mutation needs master or service-account scope, and the org-admin JWT is refused with `RBAC_DENIED`. The MCP tools `add_repo_mapping` and `list_repo_mappings` are disabled on the production server. So the script calls Convex directly as the service account (`CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS` in `.env.local`).

### 8. Proof

- Over HTTP, both ways: `whoami` with the credential returns `agentName: <role>`, and a forged credential returns HTTP 401.
- Through the real client: `claude mcp list` in the workspace must show both servers `Connected`.

## Rules

- **No secret on a command line.** Any local user can read `/proc/<pid>/cmdline`, including another tenant's account. The script feeds the helper's output to python on stdin and gives curl its headers from 0600 files in a 0700 temporary directory, removed on exit. Measured on 2026-10-05: zero secret occurrences in about 25,000 `ps` samples taken during a run; the positive control detected its value.
- Never print a secret value. The script prints only ids, paths, HTTP codes and connection states.
- New orchestrators of our own fleet go in our org. A client's own orchestrators belong to the client's org; that is a different procedure and not this script.
- Record the onboarding in the task: the `agents._id` from the mint, the whoami line, the forged-credential 401 and the `claude mcp list` lines.

## Known gap, being closed

Every station currently runs as the Unix user `elpi` and shares `/home/elpi/.vantage-agent-secrets`, so any station can read any agent's credential. Task k17es28ny4frcyc7xaqcxd86rs8fpe1b moves each station to its own Unix user, with its credential in its own space. When that lands, this script creates the user too. Until then, run it as `elpi`.

## Reference

- Mint mechanism: `convex/agentCredentials.ts` (`mintAgentCredential`, org admin only) and `scripts/mint-station-agents.mjs`.
- First use: Vitruve, 2026-10-05, task k17286xty4h7zenrejawaz72818fq6m5, agents row `r57a9p30axjj5mk1ww323aspqh8fqwj8`.
