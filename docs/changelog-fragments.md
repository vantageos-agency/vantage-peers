# Changelog fragments (`changelog.d/`)

Applies to this repository (VantagePeers Cloud backend + MCP server). Contributor process doc.

## Why

Every pull request used to add its entry at the top of `CHANGELOG.md`, under `## [Unreleased]`.
Every merge then made every other open pull request CONFLICTING on that file, and each one paid
a rebase plus a full re-gate for a conflict that carried no meaning. One file per PR cannot
conflict with another PR's file.

## The rule

1. A pull request adds **one new file** `changelog.d/<pr-or-branch-slug>.md`
   (for example `changelog.d/pr-1406-okf-namespace.md` or `changelog.d/sigma-changelog-fragments.md`).
2. A pull request **never edits `CHANGELOG.md`**. Only the release step writes it.
3. The fragment starts with a frontmatter naming its section, followed by a non-empty body:

   ```markdown
   ---
   section: Fixed
   ---
   - **One-line headline.** What changed, why, and its evidence (tests, PR, task id).
   ```

   `section` is exactly one of `Added`, `Changed`, `Fixed`, `Security`. The body is copied
   verbatim, so write it as the bullet(s) you want in the changelog.
4. Validate before pushing: `node scripts/changelog-assemble.mjs --check`.
   Exit 0 when every fragment is well-formed; exit 2 naming each malformed file
   (missing frontmatter, unknown section, missing `section` key, empty body).

`changelog.d/README.md` and files starting with `_` or `.` are ignored by the assembler.

## Release time

```bash
node scripts/changelog-assemble.mjs --version 2.19.0 [--date 2026-10-01]
```

- Validates every fragment first; any malformed one aborts with exit 2 and writes nothing.
- Inserts `## [2.19.0] — <date>` into `CHANGELOG.md` directly after the `## [Unreleased]` block,
  grouped by section in the fixed order Added, Changed, Fixed, Security, and by filename
  (codepoint order) within a section — the output does not depend on merge order.
- Deletes the folded fragments. With no fragments it writes nothing and exits 0, so a re-run
  is a no-op.
- Node built-ins only, no dependency. Tests: `scripts/__tests__/changelog-assemble.test.mjs`.

## Enforcement (docs-in-PR)

`.claude/hooks/enforce-pr-docs-sync.py` (RULE #25 DOCS-CONTEXT-LOOP) blocks a pull request whose
diff touches code but no documentation. From v1.2.0 a `changelog.d/<slug>.md` fragment counts as
the documentation update, alongside `README.md`, `CHANGELOG.md`, `docs/**` and `changes/*.md`.
Only a top-level `changelog.d/*.md` counts: a nested path, another extension or a look-alike
directory does not. A code-only pull request is still blocked. Tests:
`.claude/hooks/tests/test_enforce_pr_docs_sync.py`.

## Existing `[Unreleased]` content

The entries already under `## [Unreleased]` in `CHANGELOG.md` stay where they are. The first
assembled release is inserted after them; moving them under a version header is a one-time
editorial decision for whoever cuts that release.
