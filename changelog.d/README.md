# changelog.d — one fragment per pull request

Add ONE new file here per PR, named after the PR or branch (`changelog.d/<pr-or-branch-slug>.md`).
Never edit `CHANGELOG.md` directly: fragments are folded into it at release time by
`node scripts/changelog-assemble.mjs --version <x.y.z>`.

```markdown
---
section: Fixed
---
- **One-line headline.** What changed and why, with its evidence.
```

`section` is one of `Added`, `Changed`, `Fixed`, `Security`. Validate with
`node scripts/changelog-assemble.mjs --check` (exit 2 names any malformed file).
Full convention: `docs/changelog-fragments.md`. This README is ignored by the assembler.
