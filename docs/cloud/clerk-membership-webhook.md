# Clerk membership webhook (VantagePeers Cloud)

Keeps `orgMembership` in step with Clerk, so the owner-membership lookup (`ownerMembershipLookups`, `convex/lib/actingPrincipal.ts`) can rely on it. The table is never read to decide org-admin status (that stays the verified `org_role` claim).

## Environment (Convex deployment, set from the Convex dashboard)

| Variable | Used by | Form |
|---|---|---|
| `CLERK_WEBHOOK_SECRET` | `POST /clerk/webhook` | `whsec_<base64>`, the signing secret of the Clerk endpoint below |
| `CLERK_SECRET_KEY` | `orgMembership:backfillFromClerk` only | Clerk Backend API key (`sk_...`), never logged |

Without `CLERK_WEBHOOK_SECRET` (or with one not in `whsec_` form) every delivery is refused with HTTP 500 and nothing is written. A missing header, a timestamp more than 5 minutes off, or a signature no `v1,` candidate matches is HTTP 401.

## Clerk dashboard (operator step, once per Clerk instance)

1. Webhooks, Add Endpoint. URL: `https://<convex-site>/clerk/webhook` (the deployment's `.convex.site` host, not `.convex.cloud`).
2. Subscribe to exactly: `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted`.
3. Copy the endpoint's Signing Secret into `CLERK_WEBHOOK_SECRET`.

Any other event type is answered 200 and ignored.

## Roles

Clerk `org:admin` is stored as `admin`; every other role is stored as `member`. Rows are keyed by (`clerkOrgId`, `clerkUserId`); the slug is stored from the payload and refreshed when it changes.

## Ordering and removal

Events are ordered by event time (`data.updated_at` when the payload has it, else the `svix-timestamp` header in ms), not by arrival. A removed member is kept as a tombstone (`deletedAt` set) that every reader treats as absent; an event at or before the applied time is answered 200 and ignored, so a late `created` cannot re-add a removed member, and a newer one revives it. A `deleted` is timed max(`updated_at`, `svix-timestamp`) and wins a tie with the applied state (a create or update at exactly a delete's time stays ignored), so a removed admin cannot stay live on equal times. An event without `updated_at` has only second resolution: two such events in the same second are ordered as equal and the second is ignored.

## One-time backfill

Run after the webhook is live (events before that were never delivered). Dry run by default, it writes nothing:

```
npx convex run orgMembership:backfillFromClerk '{}'
npx convex run orgMembership:backfillFromClerk '{"dryRun": false}'
```

It returns `{ dryRun, orgs, memberships, upserted, removed, failedOrgs }`. A member Clerk no longer reports becomes a tombstone (not a hard delete) and one it reports is revived, both stamped with the run's start time. Tombstoning happens only for organisations whose full member list was read; an organisation whose read failed is left untouched and listed in `failedOrgs`. Re-run it to close any gap from missed deliveries.

## Who consumes the membership

Since item 4b of task k1778c2hvae8e8vz9f5bbbbbb98g62hw, `agentCredentials:resolveAgentCredential` (the MCP agent-credential login) reads it. After the secret finds the agent row, `@vantageos/cloud-identity` `resolveCallerFromAgentCredential` requires that the agent's `ownerPersonId` is a live member of the agent's organisation, read through `ownerMembershipLookups` by (`clerkOrgId`, `clerkUserId`). A missing row, a row of another organisation and a tombstoned row (`deletedAt` set) all refuse the credential `RBAC_DENIED` (`agent-owner-not-member`); an agent with no owner is refused `owner-missing`.

Operational consequence: this webhook and `orgMembership:backfillFromClerk` now keep agent logins alive. A member removed in Clerk stops their agents authenticating as soon as the delete event is applied; a missed delivery leaves them working until the backfill runs. Before deploying, give every active agent an owner (`agents:listAgentsWithoutOwner`, `agents:setAgentOwner`) and run the backfill, or those agents are refused.
