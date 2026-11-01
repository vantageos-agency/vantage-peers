# Runbook: org identity by Clerk org ID, expand phase (VantagePeers Cloud)

Product: VantagePeers Cloud (multi-tenant). Not applicable to Self-host.

Rule: an organisation is identified by its permanent Clerk org id (`org_...`), never by its
slug (a label that can be renamed). The id is ADDED and BACKFILLED here; the doors listed in
`security-multi-tenant.md` section 4.12 already decide by id when both sides carry one, the others
still compare slugs.

## Deploy order (each step is its own task, target named explicitly)

1. Deploy the schema and functions (columns are optional, nothing reads them yet).
2. Fill the mappings, dry run first:
   `node scripts/fill-mapping-clerk-org-id.mjs --target prod` (reads inventory, writes nothing),
   then `--apply`. Rows reported CONFLICT or UNRESOLVED are fixed by hand, never guessed.
3. Inventory: `npx convex run migrations/backfill_org_clerk_id:inventory` (every mapping must
   carry an id, the operator org included).
4. Backfill, one table at a time, dry run first:
   `npx convex run migrations/backfill_org_clerk_id:run '{"table":"missions"}'`, repeat with
   `cursor` until `isDone`, continue with `nextTable`; then the same with `"dryRun":false`.
   `run` is age-guarded: a row whose slug mapping was created AFTER the row (the slug changed
   hands) or is inactive is never written and is listed in `undecidableRows` as
   `mappingNewerThanRow` / `inactiveMapping`; resolve those by hand, never by a retry.
   `messages` and `messageReceipts` (tenantOrgId), `tasks` and `oauth_scope_profiles` also have
   dedicated counters: `migrations/tenantOrgIdCoverage` and `migrations/clerkOrgIdCoverage`
   (`count`, then `backfill`), which apply the same guard.
5. Re-run step 4 as a dry run: `toFill` must be 0; `undecidableRows` lists what needs a decision.

The backfill covers 19 tables, `githubRepoMapping` and `issues` included. Its slug-to-ID
derivation is `@vantageos/cloud-identity`'s `resolveOrgIdForLabelBackfillOnly`: this migration is
the only place an org is resolved from its label.

Before any prod deploy of the ID-only readers (module M4: no label fallback on any request path),
step 3 must show every mapping with an id AND step 5 must report `toFill` 0 on every table. On
those readers a credential without an `org_id` claim, an `org_id` no mapping holds, and a row
without an id are all refused: there is no slug fallback left to serve them.

A new organisation's mapping has no id until step 2 is run for it; until then its members are
refused (`org-mapping-not-found`), so step 2 is part of onboarding an organisation.

## Cutover: Clerk dev instance -> Clerk production instance (`restamp_clerk_ids`)

Product: VantagePeers Cloud. After the switch every Clerk org ID and user ID changes, while M4 keys
organisations by `clerkOrgId` and the fleet service row by `agents.authSubject`. The IDs are
restamped from a map the operator passes as arguments (`{"orgs":[{"from":"org_..","to":"org_.."}],
"users":[{"from":"user_..","to":"user_.."}]}`); it is never read from the environment or the source.
Order, each phase its own task with the target named:

1. **P1, build the map** from the dev and production Clerk instances (one `from`/`to` per org and per
   user). A duplicate, chained, malformed or empty map is refused by every function below.
2. **P2, restamp the data (still on the dev Clerk instance):**
   a. `migrations/restamp_clerk_ids:inventory` per table (walk `cursor`/`nextTable`): every
      `unmappedRows` entry and every `conflicts` line is decided before any write.
   b. `migrations/restamp_clerk_ids:run` per table, dry run first (default), then `"dryRun":false`,
      starting with `client_org_mapping`.
   c. `migrations/restamp_clerk_ids:restampServiceAccount` dry run, then `"dryRun":false`: corrects
      the linked service row's `authSubject`, and only when it equals a `from` of the map.
   d. `migrations/restamp_clerk_ids:readBack` per table: the sum of `remaining` must be 0.
   e. `migrations/restamp_clerk_ids:revokeList` per table: OAuth access/refresh tokens, codes, bearer
      tokens and embed sessions bound to a dev user are NOT rewritten and NOT revoked by the
      migration; revoke the listed ids in the switch window so they are re-minted.
3. **P3, switch the environment** to the production Clerk instance (JWT issuer, keys, webhook secret)
   and redeploy. A re-run of step 2 after the switch is a no-op (`alreadyRestamped`).

Left as written on purpose: `credentialsAuditLog` (append-only record of dev-instance actors) and the
`user:<subject>` actor labels embedded in task/message/mission text columns, which no door compares
against a live subject.
