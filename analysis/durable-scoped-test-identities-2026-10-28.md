# Durable scoped test identities for live MCP probes — design note

Product: VantagePeers Cloud (multi-tenant).
Task: k177c6v8kpcj4726zt3yx546fd8csfdt. Pi ruling: message k976ga1jtgtgs6n8tt6whbd91h8dhdh2 (five points, quoted in the task).
Pinned at: `origin/main` `abe13c35`. Every line reference below is to that commit.

## 1. The problem, restated against today's code

On 2026-08-19 the fleet was stopped four times by a stale or absent test credential, not by code. When the task was written, the only grantee-capable route was an admin-minted OAuth access token behind the master gate, and the pre-provisioned `ALPHA/BETA/GAMMA` bearers in `.env.local` had gone stale.

That premise has partly expired:

- `grep -cE "^(ALPHA|BETA|GAMMA)_" .env.local` -> `0`. The old test bearers are gone from the station; there is nothing to repair.
- Three pieces landed since, and together they already form a non-master, long-lived, per-org identity:

| Piece | Where | Who mints it | Lifetime |
|---|---|---|---|
| Seat bearer (OAuth access + refresh token, bound to a per-agent scope profile) | `scripts/provision-client-org-agents.mjs:133` (`--ttl-days`, 1..365, default 90, lines 44 and 52) through `oauth:provisionOrganization` (`convex/oauth.ts:748`) | the service account, once per rotation | `--ttl-days` |
| Agent credential (header `x-vantage-agent-credential`, `mcp-server/src/auth.ts:363`) | `agentCredentials:mintAgentCredential` (`convex/agentCredentials.ts:78`) | the org administrator of THAT org (`requireOrgAdminById`), never master | no expiry; rotation only |
| Three-reading probe (own ALLOW, foreign DENY by error, positive control first) | `scripts/prove-cgt-agents.mjs` (`--reverse-bearer-file`) | — | — |

This is the client-onboarding path (`runbooks/onboard-client-org.md`), first used for CGT Alsachimie on 2026-10-06. A test identity therefore needs no new mechanism: it is **a client org that holds no client data**, provisioned by that same runbook.

What does not exist yet: the two test orgs, a stable naming scheme, a dev URL for the probe script (`URLS` holds `prod` only, `scripts/prove-cgt-agents.mjs:29`), the `ORG` constant as an argument (line 30), and an expiry announcement.

## 2. The design, point by point against the ruling

### (1) The master gate stays

Nothing in this design touches `requireMasterAuth` (`convex/oauth.ts:58`, called at `:801`), the master branch of `bearerAuthMiddleware` (`mcp-server/src/auth.ts:1323-1355`), or the deny-by-default `client-generic` profile (`convex/oauth.ts:213-221`, empty `fromAllowList` and prefixes). The service account mints a seat bearer once per rotation. A probe never holds the service account or the master secret.

### (2) Fleet infrastructure, stable names

Two Clerk organisations, created once, used for nothing else:

| Org slug | Agent | Scope profile | Purpose |
|---|---|---|---|
| `probe-tenant-a` | `probe-a` | `probe-a-probe-tenant-a` | the "sees its own rows" pole |
| `probe-tenant-b` | `probe-b` | `probe-b-probe-tenant-b` | the "is refused the other's rows" pole |

Each scope profile follows step 3 of the runbook: read and write `orchestrator/<agent>` and `project/<slug>`, nothing else. The names are stable, so any station can enumerate them (`agents:getAgent`, `agentCredentials:getAgentCredentialStatus`) and report one of three states: PRESENT and valid, EXPIRED (seat past `expiresAt`), or ABSENT (never provisioned, or revoked). An expiry is then a named state, not an empty result.

Secrets live outside every repository, in one place for the fleet: Infisical, project `vantage-peers`, one environment per deployment, keys `PROBE_A_BEARER`, `PROBE_A_AGENT_SECRET`, `PROBE_B_BEARER`, `PROBE_B_AGENT_SECRET`. A probe reads them with `infisical run`. No secret is printed, written to `.env.local`, or carried in a task.

### (3) No client data, two tenants

The two orgs are `orgKind: client` (runbook step 2), with rosters `["probe-a"]` and `["probe-b"]`. Their namespaces hold only probe markers (a memory whose content names the probe run). `setAddressableFleetCoordinators` is not called for either org, so a probe identity cannot message a real station.

### (4) No permission laundering

A probe identity is an ordinary client seat. This design adds no flag, no carve-out, and no code path that widens it. If a proof needs more than a client-org seat can see, it is not taken under a probe identity, and the gap is written into the task that asked for it. The master control reading (section 3) is taken by the master holder separately, never by a probe identity.

### (5) Rotation scheduled, expiry announced

- Seat TTL: 90 days (the script default). Agent credentials do not expire.
- At provisioning, a recurring task assigned to sigma is created to fire 14 days before the seat `expiresAt`. It re-runs runbook step 4 for both orgs, updates the four Infisical keys, re-runs the probe, and closes with the new `expiresAt`.
- The same provisioning announces the expiry date on `broadcast`, so a station planning a probe knows the date before it bites.
- On rotation the old bearer stops at its own `expiresAt`. The agent credential is not re-minted, because a re-mint locks out the live holder (header of `scripts/mint-station-agents.mjs`).

## 3. How a probe reads a grantee row under it — the three readings

Run in this order. The first is the positive control and must pass before the second means anything.

1. **Own tenant ALLOW.** As `probe-a` (bearer A + agent secret A): `store_memory namespace=project/probe-tenant-a content=<run marker>`, then read the marker back. Expected: the marker is returned.
2. **Other tenant DENY.** As `probe-b` (bearer B + agent secret B): read the same marker in `project/probe-tenant-a`. Expected: an ERROR carrying `RBAC_DENIED` (or `AUTH_NAMESPACE_DENIED`). An empty success fails the probe, because it cannot tell a refusal from an absence (`.claude/rules/refusal-is-distinguishable-from-absence.md`).
3. **Master control.** Taken by the master holder, not by a probe identity: the marker exists in `project/probe-tenant-a` (a read in base). This proves reading 2 refused a row that is there.

`scripts/prove-cgt-agents.mjs` already performs readings 1 and 2 with `--reverse-bearer-file`. Two changes make it the fleet probe: `ORG` becomes an argument, and `--env dev` gets a URL. The dev URL is a local `mcp-server` (`node dist/server-http.js`) pointed at the dev deployment `efficient-guineapig-356`, because the only deployed MCP is prod.

## 4. Execution order (Pi's ORDER)

1. This note, reviewed.
2. Pi issues a token to provision on DEV (`efficient-guineapig-356`): two Clerk orgs on the dev Clerk instance, runbook steps 1-7 with `CONVEX_URL` set to dev.
3. The three-reading probe on dev, output pasted into the task.
4. Only after that, a separate Pi token for prod, same steps on `compassionate-goldfinch-737`.

## 5. What this note did not measure

- The four 2026-08-19 stops are taken from the task text; the message log was not re-enumerated.
- Whether the dev Clerk instance accepts the same `POST /v1/organizations` flow as prod (runbook step 1 was run on prod only).
- Whether `oauth:provisionOrganization` and `scripts/provision-client-org-agents.mjs` run unchanged against the dev deployment.
- Whether a local `mcp-server` pointed at dev passes its boot check (`meta:backendContract`); that depends on the dev deployment being at the same contract version.
