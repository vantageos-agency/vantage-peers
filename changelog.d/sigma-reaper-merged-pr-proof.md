---
section: Changed
---
- **`reap-worktree.sh` accepts a standalone clone whose content landed without an origin head containing it.** For a ref (HEAD, a local branch) that no freshly fetched origin head contains, the reaper now also accepts a merged pull request whose head branch is that branch AND whose `headRefOid` equals the ref's tip exactly (squash merges mint a new SHA), and for a tag, the same object id under `refs/tags/<name>` on origin (`git ls-remote`). A merged PR with a different head does not admit later local commits. Any `gh` or `ls-remote` failure is a refusal. Each acceptance prints `proof: merged PR #N at <sha>` or `proof: tag <name> on origin` on stderr. All existing refusals are unchanged. Task k179xb0q29ypgxdvwwvt9kcfgs8heymg.
