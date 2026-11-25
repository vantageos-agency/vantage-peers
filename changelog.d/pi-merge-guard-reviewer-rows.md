---
section: Security
---
- **The Pi merge guard refuses four reviewer-measured bypass routes (task k17cm51e8c1m3qv0w45pxybmx18jxsnr, REVISE on PR #1771 @ 0a19f93b).** `gh api -X PUT repos/{owner}/{repo}/pulls/N/merge` resolves the placeholder repo from the cwd's git remote and is refused when none can be read; `curl` at `API.GITHUB.COM` (any case, trailing dot or `:443`) is matched; a merge into a branch (`gh api repos/<o>/<r>/merges`, or the GraphQL `mergeBranch` mutation) is refused without the Pi token, since no pull request carries a verdict. Pinned by `.claude/hooks/tests/test_pr_merge_guard_reviewer_rows.py` (RED at 73811791: 8 failed, 17 passed; GREEN at c618a230: 150 passed across the merge-guard files).
