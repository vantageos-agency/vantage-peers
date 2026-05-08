# VantagePeers Release Policy

*VantageOS · Semver strict. Last updated: 2026-05-08.*

All releases follow [Semantic Versioning 2.0.0](https://semver.org/). Version is authoritative in `mcp-server/package.json`.

---

## Version bump types

### PATCH — `X.Y.Z+1`

Bugfixes, internal refactors, documentation corrections, dependency bumps with no API changes.

- **Self-host impact**: zero-touch. Railway cron redeploys at 03:00 UTC, auto-migration runs (no-op for PATCH), new version served.
- **Migration guide**: not required.
- **Release notes**: auto-generated from commit messages via `gh release create --generate-notes`.
- **Schema change rule**: `convex/schema.ts` MUST NOT be modified in a PATCH release. The `schema-vs-version-guard` CI step fails the PR build if a schema diff against `main` is detected. Rationale: self-host clients auto-upgrade via cron without re-running `convex deploy`; a schema change on the published package without a matching deployment causes silent runtime errors. Promote to MAJOR instead.

### MINOR — `X.Y+1.0`

New MCP tools, new Convex tables/fields (additive only), new optional parameters. No removals. No breaking changes to existing tool signatures.

- **Self-host impact**: zero-touch. Same Railway cron path as PATCH. Additive schema changes are safe **only if** the Convex deployment is updated independently.
- **Migration guide**: not required. Release notes MUST document new tools and changed defaults.
- **Release notes**: auto-generated + manually reviewed before tagging.
- **Schema change rule**: `convex/schema.ts` MUST NOT be modified in a MINOR release. Same rationale as PATCH — even additive schema changes (new tables, new fields) require `convex deploy` on the self-host instance, which the auto-upgrade cron does not perform. Promote to MAJOR and include `docs/migrations/v<N>.md` with the required `convex deploy` step.

### MAJOR — `X+1.0.0`

Breaking changes: removed tools, renamed tools, changed required parameters, schema column removals or type changes, auth flow changes.

- **Self-host impact**: MANUAL upgrade required. Clients must follow the migration guide before the cron picks up the new version. Announce at least 7 days before tagging.
- **Migration guide**: MANDATORY. File must exist at `docs/migrations/v<N>.md` before the PR merges. The `semver-check` CI workflow blocks merge if the file is absent.
- **Release notes**: full changelog with "Breaking changes" section at the top.

---

## Release process

1. Bump version in `mcp-server/package.json`.
2. Update `CHANGELOG.md` with the release section.
3. For MAJOR: add `docs/migrations/v<N>.md` (required — CI enforces this).
4. Merge PR to `main`. The `npm-publish-auto` workflow detects the version change and:
   - Runs `cd mcp-server && npm publish --provenance=false --access public`
   - Tags `v<version>` in git
   - Creates a GitHub Release with auto-generated notes
5. Railway cron picks up `@latest` within 24 hours for all self-hosted clients.

---

## Hotfix path

For urgent PATCH releases (security, data-loss bugs):

1. Branch from `main`, fix, bump PATCH, open PR with `[hotfix]` label.
2. Merge immediately after CI green — skip the normal 24-hour review window.
3. npm-publish-auto workflow publishes within minutes of merge.
4. Optionally trigger Railway manual redeploy via Railway dashboard for clients who cannot wait for the 03:00 UTC cron.

---

## Versioning enforcement

The `.github/workflows/semver-check.yml` workflow runs on every PR that touches `mcp-server/package.json` or `convex/schema.ts`:

- Detects the version bump type (PATCH / MINOR / MAJOR / NONE) by comparing HEAD vs base branch.
- **`schema-vs-version-guard` step**: if bump type is PATCH or MINOR and `convex/schema.ts` has changed vs `main`, the build fails with a clear error. MAJOR bumps pass through (migration guide check applies instead). No-bump PRs pass through.
- **MAJOR migration guide check**: fails CI if `docs/migrations/v<N>.md` does not exist.

Both gates are hard — PRs that violate either rule will not pass CI.
