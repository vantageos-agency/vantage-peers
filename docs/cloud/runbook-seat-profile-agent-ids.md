# Runbook: seat profiles and scope profiles by agent ID

**VantagePeers Cloud (multi-tenant).** Not a self-host runbook.

Operator ruling 2026-10-13: *identify by id, not by name.*

## What changed

1. **A seat profile names its agent by ID or names none.** `oauth_scope_profiles.agentId`
   is the only thing that selects the agent a seat token acts as
   (`convex/lib/seatAgent.ts`). The label branch is deleted: a profile's allowlisted
   label no longer resolves an agent, in any org.
2. **An unbound one-agent seat refuses, loudly.** A profile bound to an organisation that lists
   exactly one entry (not empty, not `*`) and carries no `agentId` is a *one-agent seat that
   names no agent*. `oauth:createAccessToken` and `oauth:rotateRefreshToken` (the mint and the
   refresh, one door) raise `SEAT_PROFILE_UNBOUND` and write nothing. Every other profile
   (several entries, none, the wildcard, no organisation) is org-level by data and mints an
   org-level token, unchanged.
3. **Name lists gain an ID list beside them.** `oauth_scope_profiles.fromAllowListAgentIds`
   and `oauth_access_tokens.fromAllowListAgentIds` hold the `agents` row IDs. `fromAllowList`
   stays as the display list of the same agents until the contract step. A token takes its IDs
   from its PROFILE at mint and at refresh (never from an argument); an ID of another
   organisation or of a retired agent is dropped. `oauth:getAccessTokenByHash` and
   `oauth:getScopeProfile` return them, and `getAccessTokenByHash` also returns the token's and
   the seat agent's organisation by permanent ID (`clerkOrgId`, `seatAgent.orgClerkId`), which
   the MCP `seatAgentOf` compares instead of the slugs.

## Rollout order (operator, one deployment at a time: DEV first, then PROD)

Every command is an `internalMutation`: it runs with the deployment's admin credential.
Dry-run first, read the report, then apply. Each is idempotent and cursor-paged: repeat with
`cursor` = the returned `continueCursor` until `isDone`.

```
# 1. Bind the agent ID onto every seat profile whose single label resolved before the label
#    branch was deleted. Nothing else is bound.
npx convex run migrations/agentIdentityRows:bindSeatProfileAgentIds '{"dryRun":true,"cursor":null}'
npx convex run migrations/agentIdentityRows:bindSeatProfileAgentIds '{"dryRun":false,"cursor":null}'

# 2. Stamp the live seat tokens that were minted before the stamp existed.
npx convex run migrations/agentIdentityRows:backfillSeatTokenAgentIds '{"dryRun":true,"cursor":null}'

# 3. Fill the agent-ID list of every organisation-bound profile, then copy it onto live tokens.
npx convex run migrations/agentIdentityRows:backfillProfileAgentIdLists '{"dryRun":true,"cursor":null}'
npx convex run migrations/agentIdentityRows:backfillTokenAgentIdLists '{"dryRun":true,"cursor":null}'
```

Run step 1 **immediately after the deploy**: from the deploy until it has run, a refresh of an
unbound seat refuses with `SEAT_PROFILE_UNBOUND`, and a live token minted before the stamp
existed reports no seat agent. Tokens already stamped keep their stamp.

### Reading the step 1 report

`bindSeatProfileAgentIds` returns `{ updated, alreadyBound, notSeat, unbound[] }`.

- `notSeat`: not a one-agent seat (several entries, none, the wildcard, no organisation). Needs no agent.
- `unbound`: one-agent seats it could NOT bind, each with the reason:
  - `profile-id-mismatch`: the profile id does not follow `<agent>-<org>` (the rule the deleted label
    branch required). Bind by hand once the agent is known.
  - `agent-not-found`: no agent of that label in the profile's own organisation.
  - `agent-ambiguous`: two agents of the organisation carry the label. Never picked between.
  - `agent-inactive`: the agent is retired. Reactivate it (by ID) or retire the profile.
  - `agent-other-org`: the label resolves, but to an agent that is not of the profile's organisation by org ID.

Bind one of them by hand, by the agent's ID:

```
npx convex run oauth:bindScopeProfileAgent '{"profileId":"<profileId>","agentId":"<agents row id>"}'
```

### Reading the step 3 report

`backfillProfileAgentIdLists` lists IDs only when EVERY label of a profile resolves to one active
agent of the profile's own organisation. A profile with a label that does not is left unlisted and
reported in `unresolved[]` (`{ profileId, labels[] }`): a half-resolved list is never written.
`notListed` counts the profiles that name no agent (wildcard, empty list, no organisation).

## Writers keep the two lists true to each other

| Door | Behaviour |
|---|---|
| `oauth:upsertScopeProfile` | accepts `fromAllowListAgentIds`; every ID must be an active agent of the profile's own org (`AGENT_NOT_IN_ORG`); a names-only change clears the stored IDs |
| `oauth:patchScopeProfileEmergency` | same; a `fromAllowList` patch without IDs clears them |
| `oauth:bindScopeProfileAgent` | a one-agent seat admits exactly its agent |
| `oauth:provisionOrganization` | stamps the seat profile and its first token with the seat's agent ID |
| `migrations/seed_client_scope_profiles` | accepts `fromAllowListAgentIds`, validated all-or-nothing before any write; a labels drift patch without IDs clears them |
| `oauth:patchClientScopeAndRefreshTokens` | the client's live tokens follow the NEW profile's IDs |

## Not done here (contract step)

`fromAllowList` is still stored and still read where it carries the catalog sentinels (`*`, `external`)
and the display copy. It is removed when the MCP filters decide on `fromAllowListAgentIds`
(`mcp-server/src/auth.ts`, batch D) and the prod backfills above have run.
