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
   It returns a single-use `state`, valid 15 minutes, tied to the admin's org.
2. The admin installs the VantagePeers GitHub App on the GitHub account that
   owns the repos, with that `state` on the install/setup URL.
3. GitHub redirects to `GET /github/app/setup` with `installation_id`, `code`, `state`.
   The server exchanges `code` (App client secret), calls `GET /user/installations`
   with the user token, and accepts the installation only if that GitHub user can
   see it. The owner written is the `account.login` GitHub returns. Nothing in
   the query string names the owner.
4. `githubOwnerBinding:completeBindingInternal` consumes the state and writes the
   binding. An owner is bound to one org; a second org claiming it is refused.
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

## Configuration this needs (not present until set)

- GitHub App with "Request user authorization (OAuth) during installation" on,
  setup URL `https://<deployment>.convex.site/github/app/setup`, the
  `installation` webhook event enabled on the existing `/github/webhook`.
- Deployment env: `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`.
  Without them `/github/app/setup` answers 501 and no binding can be created
  (fail closed).

## Existing mappings without proof

`get_github_owner_bindings` (master) also lists `unprovenMappings`: org-owned
mapping rows whose owner is not bound, or bound to another org
(`githubOwnerBinding:listUnprovenMappings`). They are reported, not silently kept.
