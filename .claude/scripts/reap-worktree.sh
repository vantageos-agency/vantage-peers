#!/usr/bin/env bash
# reap-worktree.sh — the NAMED cleanup script post-merge-cleanup.md requires.
#
# ONE path argument. One action. Never chained. The script NAME is what goes in
# the permission allowlist, never a deletion pattern: a chained deletion on an
# absolute path is the command form the runtime asks a human about, and the first
# call of a fresh session is where that halts an autonomous queue overnight.
#
# Nothing about a station or a repository is written here. The perimeter is
# derived from the caller's own checkout and the repository from its remote.
set -u -o pipefail

die() { echo "REFUSED: $*" >&2; exit 2; }

[ $# -eq 1 ] || die "exactly one path argument required, got $#"
target=$1
[ -n "$target" ] || die "empty path"
case $target in
  *..*) die "traversing path: $target" ;;
  /) die "refusing /" ;;
esac

own_top=$(git rev-parse --show-toplevel 2>/dev/null) || die "not run from inside a git checkout — the perimeter cannot be derived"

real=$(realpath -m -- "$target") || die "unresolvable path: $target"
[ "$real" != "/" ] || die "refusing /"
[ "$real" != "$own_top" ] || die "refusing this station's own checkout: $real"
[ -d "$real" ] || die "not a directory: $real"

# THE PERIMETER IS THIS REPOSITORY'S OWN WORKTREE LIST, never a parent directory.
#
# An earlier version derived it as dirname(own_top). On a host where every station
# checks out under one shared parent, that resolves to the parent of ALL of them, so
# this script would have accepted a neighbouring station's worktree and removed it.
# A deletion tool whose perimeter is wider than its caller's own work is the incident
# it exists to prevent. Found by a station reading the script rather than running it.
#
# `git worktree list` from the caller's checkout enumerates exactly the directories
# this repository owns. Another station's worktree belongs to another repository and
# cannot appear in it. A path INSIDE own_top is also legitimate — a scratch directory
# the station created in its own tree.
in_perimeter=no
case $real in
  "$own_top"/?*) in_perimeter="inside this station's own checkout" ;;
esac
if [ "$in_perimeter" = no ]; then
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    wt_real=$(realpath -m -- "$wt" 2>/dev/null) || continue
    if [ "$wt_real" = "$real" ]; then
      in_perimeter="a registered worktree of $(basename -- "$own_top")"
      break
    fi
  done <<EOF
$(git -C "$own_top" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
EOF
fi
[ "$in_perimeter" != no ] || die "outside this station's perimeter: $real is neither inside $own_top nor a registered worktree of this repository"
echo "perimeter: $in_perimeter" >&2

repo=$(git -C "$real" remote get-url origin 2>/dev/null | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')
[ -n "$repo" ] || die "cannot derive the repository from $real — a platform question about an unknown repository answers about nothing"

branch=$(git -C "$real" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)
dirty=$(git -C "$real" status --porcelain 2>/dev/null | wc -l)
[ "$dirty" -eq 0 ] || die "$dirty uncommitted file(s) in $real — decide them first"

if git -C "$real" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  ahead=$(git -C "$real" log --oneline '@{u}..HEAD' | wc -l)
  [ "$ahead" -eq 0 ] || die "$ahead unpushed commit(s) in $real — push or land them first"
else
  sha=$(git -C "$real" rev-parse HEAD) || die "cannot read HEAD of $real"
  landed=no
  if [ "$branch" != "HEAD" ]; then
    merged_pr=$(gh pr list --state merged --head "$branch" -R "$repo" --json number --jq '.[0].number' 2>/dev/null)
    [ -n "${merged_pr:-}" ] && landed="merged PR #$merged_pr"
  fi
  if [ "$landed" = no ]; then
    # Trees identical to main's: there is nothing on this branch to lose.
    # NOT `diff --name-status origin/main <sha> | grep '^A'`, which the earlier version
    # used: that form answers about a MERGE BASE, so on a squash-merge repository it
    # always reports unlanded work, and it also called files absent that `git cat-file -e`
    # found present because they had been merged and later deleted.
    git -C "$real" diff --quiet origin/main "$sha" 2>/dev/null && landed="tree identical to main"
  fi
  if [ "$landed" = no ]; then
    git -C "$real" branch -r --contains "$sha" 2>/dev/null | grep -q . && landed="sha on a remote"
  fi
  [ "$landed" != no ] || die "no upstream, no merged PR, and $sha adds files main lacks — content would be lost"
  echo "landed: $landed" >&2
fi

if [ "$branch" != "HEAD" ]; then
  open_pr=$(gh pr list --state open --head "$branch" -R "$repo" --json number --jq '.[0].number' 2>/dev/null)
  if [ -n "${open_pr:-}" ]; then
    reason=${REAP_ALLOW_OPEN_PR:-}
    [ ${#reason} -ge 6 ] || die "PR #$open_pr is OPEN on $branch — live review sandbox; set REAP_ALLOW_OPEN_PR=<reason> to override"
    echo "OVERRIDE: reaping despite OPEN PR #$open_pr — $reason" >&2
  fi
fi

before=$(df -k --output=avail / | tail -1)
size=$(du -sh -- "$real" 2>/dev/null | cut -f1)
git -C "$real" worktree remove --force -- "$real" 2>/dev/null || command rm -rf -- "$real"

[ -e "$real" ] && die "still present after removal: $real"
after=$(df -k --output=avail / | tail -1)
echo "REAPED $real (was $size) — avail KiB ${before} -> ${after} (freed $((after-before)))"
