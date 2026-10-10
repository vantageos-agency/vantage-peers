# Onboard a client organisation and its agents (VantagePeers Cloud)

Use this when a **client** (not our own fleet) gets its own organisation on VantagePeers with one or more agents, each running in a workspace under the client's own Unix user. For an orchestrator of our own fleet, use `runbooks/onboard-orchestrator.md` instead.

First use: CGT Alsachimie, 2026-10-06, task k17bnmfdan9xgxgyy3ny61ebps8fr0gw. The agents are neo, hal and mimir.

## What the client ends up with

- A Clerk organisation, where its people sign in.
- A `client_org_mapping` row (`orgKind: client`). Its roster is the agent names.
- Per agent:
  - a scope profile `<agent>-<org>` bound to the org, which reads and writes `orchestrator/<agent>` and `project/<org>`;
  - its own seat bearer;
  - an `agents` row registered by ID in the org, with its own agent credential;
  - a `profiles` row, which makes it a message recipient.
- Two credential files per agent: `/home/<client-user>/.vantage-agent-secrets/<agent>.bearer` and `<agent>.secret`. The owner is the client user; the directory is 0700 and the files are 0600.

## Steps

Every write is on prod (`compassionate-goldfinch-737`). Run them from the vantage-memory repo root on a synced main, with `CONVEX_DEPLOYMENT` unset. Never print a secret.

1. **Create the Clerk organisation, with our org admin as `org:admin`.** Use Clerk's Backend API, `POST /v1/organizations` with `{name, slug, created_by: $CLERK_ORG_ADMIN_USER_ID_VANTAGE_PEERS}`. Send the secret key from a 0600 curl config file (`curl -K`), never on the command line. Read back the memberships, and keep the returned `org_…` id for step 4.

2. **Create the org mapping, then mark it as a client org.**
   ```
   CONVEX_DEPLOY_KEY=<prod key> npx convex run tenantOrgSeed:seedClientOrgMapping \
     '{"clerkOrgSlug":"<slug>","displayName":"<name>","allowedOrchestrators":["<a>","<b>"],"scopes":["view-own-tasks","view-own-missions"]}'
   CONVEX_DEPLOY_KEY=<prod key> npx convex run clientOrgMapping:setOrgKind '{"clerkOrgSlug":"<slug>","orgKind":"client"}'
   ```
   Name every agent now (this is the label roster). The roster that decides is stored by agent ID (module M1): the agents are registered in step 4, so once step 4 is done, fill the ID roster with `CONVEX_DEPLOY_KEY=<prod key> npx convex run migrations/backfillRosterAgentIds:backfillRosterAgentIds` (a dry run: read the `unknown` and `ambiguous` lists, nothing is guessed), then again with `'{"dryRun":false}'`. To add an agent later, append its ID (append-only, client orgs only, an active agent of this org; never an operator agent): `CONVEX_DEPLOY_KEY=<prod key> npx convex run clientOrgMapping:addRosterMembers '{"clerkOrgSlug":"<slug>","agentIds":["<agents id>"]}'`. To let the client message an operator coordinator, store its ID: `npx convex run clientOrgMapping:setAddressableFleetCoordinators '{"clerkOrgSlug":"<slug>","agentIds":["<operator agent id>"]}'`.

3. **Create one scope profile per agent, bound to the org.**
   ```
   CONVEX_DEPLOY_KEY=<prod key> npx convex run oauth:upsertScopeProfile \
     '{"profile":{"profileId":"<agent>-<slug>","description":"Seat <agent> in org <slug>","fromAllowList":["<agent>"],"namespaceReadPrefixes":["orchestrator/<agent>","project/<slug>"],"namespaceWritePrefixes":["orchestrator/<agent>","project/<slug>"],"clerkOrgSlug":"<slug>"}}'
   ```

4. **Mint the seat bearers and the agent credentials.** This uses the service account for the seats, and the org-admin JWT of **this** org for the agent registry.
   ```
   bun run scripts/provision-client-org-agents.mjs --org <slug> --clerk-org-id <org_…> \
     --agents <a>,<b> --stage-dir /home/elpi/.vantage-client-secrets/<slug> --ttl-days 90
   ```
   The environment comes from `.env.local`: `CLERK_SECRET_KEY=$CLERK_SECRET_KEY_VANTAGE_PEERS`, plus `CONVEX_URL` set to the prod URL.

5. **Hand the files to the client user.**
   ```
   sudo install -d -o <user> -g <user> -m 700 /home/<user>/.vantage-agent-secrets
   sudo install -o <user> -g <user> -m 600 <stage>/<agent>.{bearer,secret} /home/<user>/.vantage-agent-secrets/
   ```

6. **Create each agent's profile row**, with its own credential. Without a profile row, nobody can send the agent a message.
   ```
   sudo -u <user> node scripts/client-agent-set-profile.mjs /home/<user>/.vantage-agent-secrets <a> <b>
   ```

7. **Prove it.**
   ```
   sudo -u <user> node scripts/prove-cgt-agents.mjs --env prod --agents <a>,<b>
   ```
   Per agent, the script checks:
   - whoami lands in the org;
   - the agent's own memory round-trips;
   - a message to a sibling agent is accepted;
   - a write to `orchestrator/sigma` is refused;
   - a read of `project/vantage-peers` is REFUSED with an error (an empty success fails the probe: it cannot tell a refusal from an absence);
   - with `--reverse-bearer-file`: a marker is first written to `project/<slug>` by the first agent and read back (the positive control), then the foreign bearer's read of it must be refused.

   It must exit 0. For another org, the `ORG` constant in the script names the org; make it an argument if you reuse the script.

   **A portal seat** (a client web app relaying to its agents) is minted with `--seat-only --agents <slug>`: a bearer and no agent credential. Its profile's `fromAllowList` is `[<slug>]`, so the portal MUST send `from: "<slug>"` (CGT: `from: "cgt-alsachimie"`). Any other `from` is refused. Since PR #1470 it reaches only the org's own roster.

8. **Wire the workspaces.** The `vantage-peers` server in each workspace's `.mcp.json` sends `Authorization: Bearer <agent>.bearer` and `x-vantage-agent-credential: <agent>.secret`. Use a headersHelper that reads the two files, so the secret stays out of `.mcp.json`.

## People: Claude.ai and ChatGPT

A person uses the VantagePeers connector at `https://vantage-peers-production.up.railway.app/mcp`. They sign in with Clerk on the authorize page, as a member of the client's Clerk organisation, and land in that org. The org is joined on its slug (`orgKeyOf` = slug, else id).

- **Needed from the client:** each person's email. Invite each person to the Clerk organisation, with the role the client decides:
  ```
  CLERK_SECRET_KEY=$CLERK_SECRET_KEY_VANTAGE_PEERS node scripts/invite-client-people.mjs \
    --clerk-org-id <org_…> --role org:member --email <a> --email <b>          # dry run, sends nothing
  … --send                                                                     # sends the invitations
  ```
  The dry run is the default. An invitation is an email to a real person, so it goes out only on an explicit `--send`. For CGT Alsachimie, the operator ruled that it is sent on site, with the client.
- A person's session reads `team/<slug>` and `project/<slug>` (the agents' shared memory), and writes `team/<slug>` only. This was ruled by Pi on 2026-10-06 and is implemented in the MCP server: PR sigma/person-reads-org-project.

## Renewal

The seat bearer expires after `--ttl-days`, 90 days by default. Re-run step 4, then step 5. The agent credentials do not expire. Step 4 mints them only once: if the `.secret` file already exists in the stage dir, it is kept.

## Known gaps

- The raw Clerk-JWT bearer branch (`mcp-server/src/auth.ts`, about line 1331) looks up the mapping by `org_id`. Mappings are keyed by slug, so that branch refuses client orgs with `RBAC_DENIED: org "org_…" not in client_org_mapping`. It does not affect the person sign-in path or the agents.
- No write path edits an org's roster after it is created.
