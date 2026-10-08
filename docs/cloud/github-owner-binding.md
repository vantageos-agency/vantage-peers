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

## How an owner gets bound

Not in this release. The self-serve door (`bind_github_owner`, Convex
`githubOwnerBinding:startBinding`), the signed install state, the
`/github/app/setup` callback and the writer of `githubOwnerBindings` moved to a
follow-up that restores them through a cloud-identity admin primitive. Until it
ships, no function writes a binding, so a client org cannot add a mapping (the
owner is never bound to it); fleet/master mappings are unaffected. What this
release does: it reads bindings (`get_github_owner_bindings`), reports mappings
without proof, and the HMAC-verified `installation` webhook (`deleted` or
`suspend`) deactivates the bindings of that installation.

## Revocation stops routing

An org-owned mapping routes only while its owner binding is ACTIVE. Once the
binding is inactive (installation deleted or suspended, or deactivated), the
mapping no longer reaches issues, tasks, GitHub comments or deploy state: the
task auto-link, the IRP branch, deploy-task resolution, webhook routing
(`OK - unproven repo mapping`) and issue upsert (`MAPPING_UNPROVEN`) all skip it.
It stays listed by `listUnprovenMappings`.

`unsuspend` does NOT reactivate. The event carries only an installation id; the
account may have been renamed or transferred while suspended, and the proof was
not re-taken. Re-binding restores routing (the binding door returns in the follow-up).

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
