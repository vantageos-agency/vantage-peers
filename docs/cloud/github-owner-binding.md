# GitHub owner binding (VantagePeers Cloud)

Scope: VantagePeers Cloud (multi-tenant). Not applicable to Self-host.

A repo is routed to an organisation only on proof from GitHub, never on first
claim. Without it, org-a could map `org-b/newrepo` and receive org-b's issues.

## What a member may do

`add_repo_mapping` (Convex `githubRepoMapping:add`) from an organisation member
needs ALL of:

1. the `manage-repo-mappings` scope on the org's `client_org_mapping` row;
2. the repo's GitHub owner (the part before `/`, compared case-insensitively)
   bound to the caller's own org in `githubOwnerBindings`;
3. an orchestrator (and reviewers) from the caller's own roster.

A mapping whose owner is not bound to the caller's org is refused with
`RBAC_DENIED` and `reason: "github-owner-not-bound"`. Fleet/master mappings
(no `orgId`) are not subject to the binding.

## How an owner gets bound (self-serve, no operator step)

1. An org ADMIN calls `bind_github_owner` (Convex `githubOwnerBinding:startBinding`).
   The caller is identified BY ID through `@vantageos/cloud-identity`: the Clerk
   session must carry `org_id` (the Clerk org ID, matched against
   `client_org_mapping.clerkOrgId`, which must be set and active) and `org_role`
   equal to `org:admin`. A member, a token with no `org_id` or no `org_role`, and
   the fleet service account are refused `RBAC_DENIED`.
   It returns a single-use `state`, valid 15 minutes, tied to the admin's org. The
   state is `<nonce>.<HMAC-SHA-256>` signed with the App client secret; the setup
   callback verifies the signature (401 on a forged one) before it calls GitHub.
2. The admin installs the VantagePeers GitHub App on the GitHub account that
   owns the repos, with that `state` on the install/setup URL.
3. GitHub redirects to `GET /github/app/setup` with `installation_id`, `code`, `state`.
   The server exchanges `code` (App client secret), calls `GET /user/installations`
   with the user token, and accepts the installation only if that GitHub user can
   see it. The owner written is the `account.login` GitHub returns. Nothing in
   the query string names the owner.
4. `githubOwnerBinding:completeBindingInternal` consumes the state and writes the
   binding. It re-reads the org by its Clerk org ID first: an org removed or
   deactivated since the state was issued binds nothing (`org-not-active`). An
   owner is bound to one org; a second org claiming it is refused.
5. The HMAC-verified `installation` webhook (`deleted` or `suspend`) deactivates
   the bindings of that installation.

## Revocation stops routing

An org-owned mapping routes only while its owner binding is ACTIVE. Once the
binding is inactive (installation deleted or suspended, or deactivated), the
mapping no longer reaches issues, tasks, GitHub comments or deploy state: the
task auto-link, the IRP branch, deploy-task resolution, webhook routing
(`OK - unproven repo mapping`) and issue upsert (`MAPPING_UNPROVEN`) all skip it.
It stays listed by `listUnprovenMappings`.

`unsuspend` does NOT reactivate. The event carries only an installation id; the
account may have been renamed or transferred while suspended, and the proof was
not re-taken. Re-binding (`bind_github_owner`) is one self-serve step and
restores routing.

## Creating the GitHub App (operator checklist, one pass)

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App. `<site>` is
the Convex deployment's HTTP site URL, `https://<deployment>.convex.site` (the
host `convex/http.ts` is served on). Values the code depends on are cited.

| Field | Value | Why / where the code reads it |
|---|---|---|
| GitHub App name | `VantagePeers Cloud` (any free name; its slug builds the install URL `https://github.com/apps/<slug>/installations/new?state=<state>`) | not read by code |
| Homepage URL | your product page, e.g. `https://vantagepeers.com` | required by GitHub, not read by code |
| Callback URL | `<site>/github/app/setup` | the route `convex/http.ts:880` (`path: "/github/app/setup"`, GET); it reads `state`, `code`, `installation_id` at `convex/http.ts:889-891` |
| Request user authorization (OAuth) during installation | **ON** | without it GitHub sends no `code`, and `convex/http.ts:889-894` answers 400. With it ON GitHub redirects to the Callback URL and the Setup URL field is unavailable (leave it empty) |
| Setup URL | leave empty (disabled by the option above) | |
| Redirect on update | **OFF** | the callback needs a fresh single-use `state` issued by `bind_github_owner` (`convex/githubOwnerBinding.ts`, `startBinding`); an update redirect carries none and would only be answered 409 `state-unknown` |
| Expire user authorization tokens | leave ON (default); the token is used once, in the same request | `convex/http.ts:895-910` |
| Webhook: Active | ON | |
| Webhook URL | `<site>/github/webhook` (the existing route, `convex/http.ts:28`) | the installation lifecycle is handled at `convex/http.ts:79-93` |
| Webhook secret | the SAME value as the deployment's `GITHUB_WEBHOOK_SECRET` | the HMAC is verified at `convex/http.ts:36-70` with `process.env.GITHUB_WEBHOOK_SECRET`; a delivery whose signature differs is refused 401, and with no secret set, 503 |
| SSL verification | Enabled | |

**Permissions (minimal set the code needs today).** Derived by grep of the GitHub
calls in `convex/`: `GET https://api.github.com/user/installations` and
`GET https://api.github.com/user` (`convex/http.ts:909,923`) run with the
authorising user's own OAuth token and need no App permission. Every REST call
that reads or comments on a repo (`convex/githubComments.ts:19,32`,
`convex/http.ts:336,627`) authenticates with the separate `GITHUB_TOKEN`
variable, not with the App, so the App needs NO write permission:

| Scope | Permission | Level | Needed for |
|---|---|---|---|
| Repository | Metadata | Read-only (mandatory, GitHub forces it) | any App |
| Repository | Issues | Read-only | delivery of the `issues` and `issue_comment` events the webhook reads (`convex/http.ts:162,364,371,391,397,403,485`) |
| Repository | Pull requests | Read-only | delivery of `pull_request` and `pull_request_review` (`convex/http.ts:508,554,576`) |
| Organization | none | | |
| Account | none | | |

If a later change moves comments or file listing from `GITHUB_TOKEN` to an
installation token, add Issues: Read and write (comments) and Contents or Pull
requests: Read (PR files) then, not before.

**Subscribe to events:** Issues, Issue comment, Pull request, Pull request review.
`installation` (deleted, suspend) is delivered to every GitHub App without a
subscription, and is the only one the binding logic reads (`convex/http.ts:79`).

**Where to set the secrets.** Convex dashboard → the deployment → Settings →
Environment Variables (names exactly as read by the code):

- `GITHUB_APP_CLIENT_ID` — the App's "Client ID" (`convex/http.ts:883`)
- `GITHUB_APP_CLIENT_SECRET` — "Generate a new client secret" on the App page
  (`convex/http.ts:884`)
- `GITHUB_WEBHOOK_SECRET` — already set for the repo webhook; the App's webhook
  secret must equal it (`convex/http.ts:36`)

Without the first two, `/github/app/setup` answers 501 and no binding can be
created (fail closed, `convex/http.ts:883-887`).

Install URL handed to an org admin after `bind_github_owner`:
`https://github.com/apps/<slug>/installations/new?state=<state from the tool>`.

## Existing mappings without proof

`get_github_owner_bindings` (master) also lists `unprovenMappings`: org-owned
mapping rows whose owner is not bound, or bound to another org
(`githubOwnerBinding:listUnprovenMappings`). They are reported, not silently kept.

Both reads are cursor-paginated (`limit` default 100, max 500) and return
`{ items, nextCursor }`. `get_github_owner_bindings` takes `limit`, `cursor` (bindings)
and `unprovenCursor` (unproven mappings) and returns `nextCursor` and
`unprovenNextCursor`: a string means more remain (pass it back as the matching
cursor), `null` means that list is exhausted. An unproven-mappings page scans
`limit` mapping rows, so a page may hold fewer items than `limit` (or none) while
its cursor is still a string.
