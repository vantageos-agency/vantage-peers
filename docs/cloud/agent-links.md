# Agent links: one agent of an organisation reaches one agent of another

VantagePeers Cloud (multi-tenant). Organisations are isolated: an agent cannot message,
or assign a task to, an agent of another organisation, and a NAME never crosses an
organisation. An agent link is the one deliberate exception. The decision is
`@vantageos/cloud-identity` 0.23.1 (`buildAgentLink`, `resolveAgentLink`); this backend
stores the row and reads by ID.

## What a link is

- One row per DIRECTION in the `agentLinks` table: `fromAgentId` may reach `toAgentId`.
  "Both ways" is two rows.
- Granted by an ADMIN of the TARGET agent's organisation (`toOrgId`): the side that
  receives the traffic accepts it. An admin of the source organisation, or a plain
  member of the target organisation, cannot grant.
- The exact pair only. A third agent of the same two organisations is not covered.
- Standing (no expiry). Revoked by setting `revokedAt`.
- Voided when the grantor stops being an active admin of the target organisation (the
  `orgMembership` row is tombstoned or no longer `admin`), with no write to the link.
  A current admin of the target organisation grants it again.

## Doors (Convex, person session; not MCP tools)

| Door | Arguments | Who |
|---|---|---|
| `agentLinks:grant` | `fromAgentId`, `toAgentId`, `reason` (10 characters or more) | a signed-in admin of the organisation of `toAgentId` |
| `agentLinks:revoke` | `fromAgentId`, `toAgentId` | a signed-in admin of the organisation of `toAgentId` |

`grantedBy` is not an argument: it is the verified session's subject. There is no
operator or service-account door that grants on a person's behalf; the service account
and agents are never administrators. The grantor is proven twice: the session's live
`org_role` claim by organisation ID, and the stored `orgMembership` row (kept live by
the Clerk webhook, `docs/cloud/clerk-membership-webhook.md`), so a grantor missing from
`orgMembership` is refused until the backfill has run.

The MCP does not carry an organisation admin's session, so there is no MCP tool for
these doors (`MCP_CALLED_FUNCTIONS` and the backend contract version are unchanged).
Call them from the dashboard or a Convex client holding the person's Clerk token. The
repository ships one such client, `scripts/agent-link.mjs` (its argument contract is
pinned by `scripts/__tests__/agent-link-client.test.mjs`):

```bash
CONVEX_URL=<deployment url> AGENT_LINK_SESSION_TOKEN=<your own Clerk session token> \
  node scripts/agent-link.mjs grant <fromAgentId> <toAgentId> "HR onboarding coordination"
CONVEX_URL=… AGENT_LINK_SESSION_TOKEN=… node scripts/agent-link.mjs revoke <fromAgentId> <toAgentId>
```

The same call from code:

```ts
await client.mutation(api.agentLinks.grant, {
  fromAgentId, // the agent that will be allowed to reach the other
  toAgentId, // the agent of the organisation the signed-in admin administers
  reason: "HR onboarding coordination",
});
```

## Using a link

Nothing changes for the caller: `send_message` with `recipientAgentIds` and
`create_task` / `update_task` with `assignedToAgentId`, naming an agent of another
organisation by its ID (`list_peers` `agentId`).

- Only a call proven as an agent (a `verifiedActor` from the MCP, or a presented agent
  credential) can use a link. A name channel or a name assignee in another organisation
  stays refused, link or not.
- A message is stamped in the RECIPIENT's organisation, so the target reads it in its
  own inbox and no other organisation does.
- A task is stamped in the ASSIGNEE's organisation (`orgId`, `clerkOrgId`) and to the
  assignee (`assignedToId`) at `tasks:create` only, so the target organisation's members
  read it in their task list. It is not in the source organisation's list; the source
  agent stays the creator.
- `tasks:update` never crosses organisations, link or not: an `assignedToAgentId` of
  another organisation is refused `ORG_MISMATCH`, the task unchanged. Moving a task
  between tenants is a tenant move, not a side effect of reassigning. A client-org
  agent that holds a task of another organisation (created there through a link) may
  not re-assign it at all.
- Every refusal is the ordinary one (`recipient-agent-not-addressable`, `ORG_MISMATCH`,
  `assignee-not-an-agent-of-org`); it never says whether a link exists.

## Example: pi and victor

pi is an agent of `perello-consulting`; victor is an agent of `iris-rh`.

| Direction | Row | Granted by |
|---|---|---|
| pi to victor | `fromAgentId` = pi, `toAgentId` = victor | Marie, admin of `iris-rh` (victor's organisation) |
| victor to pi | `fromAgentId` = victor, `toAgentId` = pi | an admin of `perello-consulting` (the operator's organisation) |

Each admin signs in and calls `agentLinks:grant` once. Until both rows exist, only the
granted direction works. To stop one direction, its target-organisation admin calls
`agentLinks:revoke` with the same pair.

## Rollout

Convex only (new table `agentLinks`, new functions `agentLinks:grant` and
`agentLinks:revoke`); the MCP is unchanged. The target organisation's admins must be
present in `orgMembership` with role `admin`.
