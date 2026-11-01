# Onboard a client organisation and its agents (VantagePeers Cloud)

Use this when a **client** (not our own fleet) gets its own organisation on VantagePeers with one or more agents, each running in a workspace under the client's own Unix user. For an orchestrator of our own fleet, use `runbooks/onboard-orchestrator.md` instead.

First use: CGT Alsachimie, 2026-10-06, task k17bnmfdan9xgxgyy3ny61ebps8fr0gw. The agents are neo, hal and mimir.

## What the client ends up with

- A Clerk organisation, where its people sign in.
- A `client_org_mapping` row (`orgKind: client`). Its roster is the agent names.
- Per agent:
  - a scope profile `<agent>-<org>` bound to the org, which reads and writes `project/<org>` and, once the agent is registered, `orchestrator/<agent ID>` (the agents-row ID, never the name: agent names are unique per org, not fleet-wide);
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
     '{"profile":{"profileId":"<agent>-<slug>","description":"Seat <agent> in org <slug>","fromAllowList":["<agent>"],"namespaceReadPrefixes":["project/<slug>"],"namespaceWritePrefixes":["project/<slug>"],"clerkOrgSlug":"<slug>"}}'
   ```

4. **Mint the seat bearers and the agent credentials.** This uses the service account for the seats, and an org-admin JWT minted **for this org** for the agent registry.
   ```
   bun run scripts/provision-client-org-agents.mjs --org <slug> --clerk-org-id <org_…> \
     --agents <a>,<b> --stage-dir /home/elpi/.vantage-client-secrets/<slug> --ttl-days 90
   ```
   The environment comes from `.env.local`: `CLERK_SECRET_KEY=$CLERK_SECRET_KEY_VANTAGE_PEERS`, plus `CONVEX_URL` set to the prod URL and `CLERK_DOMAIN` set to the prod Clerk frontend domain (there is no default: unset, the script exits 1 before any write).

   **The org is checked before anything is written.** A sign-in ticket opens a session on the admin's *active* Clerk org (the last one created), and the registry takes its org from the token. So the script makes `--clerk-org-id` the session's active org, requests the `convex` JWT template token (override with `CLERK_ORG_ADMIN_JWT_TEMPLATE`), and refuses unless the token's `org_id` equals `--clerk-org-id`. On a mismatch it exits 1 with `ORG_MISMATCH: … org_id=<got> but the requested Clerk org is <wanted>`, and nothing is registered, seats included. Read the line `org-admin token verified: org_id = <org_…>` in the output.

   **4b. Set each agent's owner (operator command, mandatory).** `registerAgent` and `mintAgentCredential` do not set `agents.ownerPersonId`, and without it every agent credential is refused (`AGENT_CREDENTIAL_INVALID`). `agents:setAgentOwner` is an *internal* mutation, so no JWT can call it and the script cannot either. The script ends by printing the exact command (agent IDs and the org admin's Clerk user ID, no secret); run it with the deploy key of the deployment you are provisioning:
   ```
   CONVEX_DEPLOY_KEY=<prod key> npx convex run agents:setAgentOwner \
     '{"agentIds":["<agents id>"],"ownerPersonId":"<org admin user_…>","reason":"client org <slug>: onboarding, owner is the org admin that registered the agent"}'
   ```
   Re-running it with the same owner changes nothing. Do step 5 and the proof (step 7) only after it.

   **4c. Add the agent IDs to the seat profiles (operator).** A seat is admitted to `orchestrator/<its agent ID>` only, and the MCP refuses a namespace its profile does not list. The operator script reads through the prod guard (`oauth:listScopeProfiles`, `data agents`, `data client_org_mapping`) and writes through it (`oauth:upsertScopeProfile`, one JSON object per profile). Dry run first, read the per-org counts, the sample profile ids and the skipped reasons, then write:
   ```
   node scripts/seat-profile-agent-namespace.mjs
   node scripts/seat-profile-agent-namespace.mjs --apply
   ```
   It appends `orchestrator/<agent ID>` to the read and write prefixes of each profile bound to an active client org whose single `fromAllowList` entry is not `*` and names exactly one active agent of that org; anything else is skipped and counted (`ambiguousAgent`, `noAgentInOrg`, `operatorOrg`, ...). Idempotent. The guard's allow list must name `run oauth:listScopeProfiles` besides `run oauth:upsertScopeProfile`, `data agents` and `data client_org_mapping`.

   **When does a seat see the new prefix?** A token carries the prefixes it was minted with. Measured (`mcp-server/test/seat-refresh-picks-up-profile-prefix.test.ts`): a refresh (`/token`, `refresh_token` grant) mints the new access token from the LIVE profile, so a seat that renews through OAuth refresh picks the prefix up at its next refresh with nothing to do. A seat that uses the static bearer file written by `provision-client-org-agents.mjs` (a 90-day access token) never refreshes: it keeps the old list until it is re-minted. For those seats the OPERATOR re-runs `scripts/provision-client-org-agents.mjs --org <slug> --clerk-org-id <org_…> --agents <a>,<b> --stage-dir <dir>` after step 4c (it now registers or finds each agent first and mints `orchestrator/<agent ID>` into the token), and the CLIENT's user replaces the `<agent>.bearer` file in their store with the new one. Until then that seat's `orchestrator/*` calls are refused at the MCP.

   **4a. Adding an agent to an org that already exists.** Name the new agent in `--agents` (the existing ones may stay in the list). If a name is not yet on the org's roster, the script registers it by ID (`agents:registerAgent`, org-admin of this org), mints nothing for any agent, prints `ROSTER_STEP_REQUIRED`, and exits 3. Run the two printed operator commands in order, then re-run the script. The roster is written by agent ID, never by writing a label:
   ```
   CONVEX_DEPLOY_KEY=<prod key> npx convex run clientOrgMapping:addRosterMembers '{"clerkOrgSlug":"<slug>","agentIds":["<agents id>"]}'
   CONVEX_DEPLOY_KEY=<prod key> npx convex run agents:setAgentOwner '{"agentIds":["<agents id>"],"ownerPersonId":"<org admin user_…>","reason":"client org <slug>: onboarding, owner is the org admin that registered the agent"}'
   ```
   `addRosterMembers` is internal (operator only), append-only, and refuses an agent of another organisation (`AGENT_NOT_IN_ORG`).

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
   sudo -u <user> node scripts/prove-cgt-agents.mjs --env prod --agents <a>,<b> --secrets-dir /home/<user>/.vantage-agent-secrets
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

A person uses the VantagePeers connector at `https://mcp.vantagepeers.com/mcp`. They sign in with Clerk on the authorize page, as a member of the client's Clerk organisation, and land in that org. The org is joined on its slug (`orgKeyOf` = slug, else id).

- **Needed from the client:** each person's email. Invite each person to the Clerk organisation, with the role the client decides:
  ```
  CLERK_SECRET_KEY=$CLERK_SECRET_KEY_VANTAGE_PEERS node scripts/invite-client-people.mjs \
    --clerk-org-id <org_…> --role org:member --email <a> --email <b>          # dry run, sends nothing
  … --send                                                                     # sends the invitations
  ```
  The dry run is the default. An invitation is an email to a real person, so it goes out only on an explicit `--send`. For CGT Alsachimie, the operator ruled that it is sent on site, with the client.
- A person's session reads `team/<slug>` and `project/<slug>` (the agents' shared memory), and writes `team/<slug>` only. This was ruled by Pi on 2026-10-06 and is implemented in the MCP server: PR sigma/person-reads-org-project.

## Person onboarding

One path, one command: `scripts/onboard-person.mjs`. Nobody hand-runs prod writes. Run it from the checkout that owns `.claude/scripts/convex-prod.sh` and its `.env.local`.

```
CLERK_CURL_CONFIG=<0600 curl config>  node scripts/onboard-person.mjs \
  --org-slug <slug> --org-name "<Org name>" --name "<Person>" --email <person@client.tld> \
  --agents "Milo:claude,Sacha:chatgpt,Esteban:chatgpt,Alma:grok" --lang fr          # dry run: reads, prints the plan, writes nothing
… --send                                                                            # executes
```

- **Agents:** one per AI client and per account, `label:client`. Labels are unique per organisation. **Ask the client the name of each agent BEFORE sending any connection step** (the name shows on the consent page and in every write); a rename later is possible but costs a step. The label is written exactly as given: the scope filter compares labels case-sensitively and attributes writes to the stored label.
- **Order (`--send`):** Clerk org (no `created_by`, so the operator does not join a client org), invitation (`org:admin`, `notify:false`, `redirect_url`), mapping, `orgKind: client`, `clerkOrgId` on the mapping, then the agents (one `seedSeatAgents`, every existing id carried as the keep-list, trap F14), the exact label roster (`tenantOrgSeed:setOrgRoster`), then one email invite recorded per agent.
- **Returns:** JSON with the invitation URL, the Clerk org id, every agent id (`created` true/false) and `reconnectNeeded`. The command never emails: send the URL to the person yourself, in `--lang` (recorded on the invitation and on each agent for the template).
- **Idempotent:** re-running for the same email and slug changes nothing and reports the existing ids and the pending invitation URL. Adding an agent later appends (existing ids kept). Person tokens snapshot the label roster at mint, so after an agent is added to an org the person already connected, `reconnectNeeded` is true: they disconnect and reconnect each assistant once.
- **Binding is automatic.** Each agent carries the invited email (`agents.personalAgentInvite`). When the Clerk membership webhook reports a member of that org, the backend reads the user from the Clerk API and binds the agents whose invited email is one of the user's VERIFIED addresses (`personalAgentBind`). No name is matched. If it fails (no `CLERK_SECRET_KEY` on the Convex deployment, Clerk error), nothing is bound; re-run the command to retry.
- **What the person does:** opens the invitation URL, signs up, then connects each assistant to `https://mcp.vantagepeers.com/mcp` and picks the agent on the consent page. Per-assistant steps: [docs/cloud/connect-assistants.md](../docs/cloud/connect-assistants.md) (FR: [connect-assistants.fr.md](../docs/cloud/connect-assistants.fr.md); public page https://www.vantagepeers.com/docs/cloud/connect). After a VantagePeers update, disconnect and reconnect once (tool definitions are cached at connect time).
- **Refusal "agents autorisés par la connexion : …"** on a write: the agent label is missing from the organisation's label roster (or the token predates it). Fix: re-run the command (it appends the exact label), then the person reconnects.
- **Joining an existing organisation:** pass the existing `--org-slug` and the same command adds the person to it. The dry run must print `clerk org <slug>: exists` and `mapping <slug>: exists`; if it prints `create` (Clerk org) or `seed` (mapping), the slug is wrong — stop, never create a second organisation for the same client. Existing agents are kept and the new labels are appended to the roster. Name the labels per person and client (e.g. `Patricia-Claude:claude,Patricia-ChatGPT:chatgpt`) so they stay unique in the organisation. One invited address per person: invite the address the person signs in with on their AI clients, not every address they have.
- **Invitation landing page:** the default redirect is `<CLERK_DOMAIN>/sign-up` (Clerk-hosted); override with `--redirect-url`. Clerk's own email is suppressed (`notify:false`), because it linked to the MCP URL, which answers `Missing Authorization header` and consumes no ticket.

- **Renaming an agent:** `agents:renameAgent` is a public mutation that needs an org-admin session OF THAT organisation (`resolveSessionCaller` + `assertOrgAdmin`, `convex/agents.ts`); the deploy key cannot call it. Path: (1) collision check first — list the organisation's agent names (`convex-prod.sh data agents`) and stop if the new name exists; (2) if the org-admin user is not `org:admin` of the client org, add it (Clerk `POST /v1/organizations/<org_…>/memberships`, role `org:admin`); (3) mint its `convex`-template JWT with `mintOrgAdminToken` (`scripts/lib/org-admin-token.mjs`, the org claim is checked) and call `agents:renameAgent { agentId, newName }`, then read the name back with `agents:getAgent`; (4) rewrite the label roster with the new names and the SAME ids (`tenantOrgSeed:setOrgRoster`) and read it back; (5) remove any membership added in (2) and read the member count back — the operator never stays in a client org. Ids, invitations and bindings are unchanged by a rename. Known gap: the org-admin user is currently the operator's own Clerk account (task k1798j70y2916me9874z54jpnx8hcjym).
- **Claude Free allows ONE custom connector.** Say it in the welcome email: a Free person connects VantagePeers as that one connector (or uses the plugin), and a second custom connector is refused by Claude, not by us.
- **A host without dynamic client registration** (Antigravity, Mistral Le Chat) gets a pre-registered confidential client, one per host and per person: `POST https://mcp.vantagepeers.com/register` with `token_endpoint_auth_method: client_secret_post` and the host's exact redirect URI (Antigravity `https://antigravity.google/oauth-callback`, Mistral `https://callback.mistral.ai/v1/integrations_auth/oauth2_callback`). The client id and secret travel by the credential handover below, never in an email body. Hosts that register themselves (Claude, ChatGPT, OpenCode) need nothing.

## Handing a credential to a person

Every password, client secret or other credential given to a person (for example the OAuth client ID and secret a pre-registered client such as Google Antigravity needs) goes through **https://eu.onetimesecret.com/**, never in an email body, a chat message, a task or a document.

1. Create the secret on https://eu.onetimesecret.com/ with a passphrase and the shortest expiry that fits the handover (the link can be opened once).
2. Send the link on one channel (for example the welcome email) and the passphrase on a **different** channel (for example SMS or a call). Never both in the same message.
3. Record in the task that the secret was handed over, by which two channels, and its expiry — never the secret, the link or the passphrase.
4. If the person reports the link as already opened or expired, treat the credential as exposed: rotate it, then send the new one the same way.

The invitation URL of the Person onboarding flow is not a credential in this sense (single use, bound to the invited address) and travels in the welcome email.

## Renewal

The seat bearer expires after `--ttl-days`, 90 days by default. Re-run step 4, then step 5. The agent credentials do not expire. Step 4 mints them only once: if the `.secret` file already exists in the stage dir, it is kept.

## Known gaps

- The raw Clerk-JWT bearer branch (`mcp-server/src/auth.ts`, about line 1331) looks up the mapping by `org_id`. Mappings are keyed by slug, so that branch refuses client orgs with `RBAC_DENIED: org "org_…" not in client_org_mapping`. It does not affect the person sign-in path or the agents.
- Roster edits are append-only: `clientOrgMapping:addRosterMembers` adds agents by ID (step 4a). No path removes a roster member.
