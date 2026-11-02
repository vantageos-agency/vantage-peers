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

# THE ONE OTHER ACCEPTED CASE: a standalone clone directly under the temp root.
#
# A clone made with `git clone <url> /tmp/<name>` has its own .git and appears in no
# worktree list, so the perimeter above can never admit it, and before this branch it
# had no permitted deletion form at all (31 such leftovers measured on one station).
# It is admitted here only when the script itself proves there is nothing to lose:
# a clean tree, nothing stashed, and every local commit already on origin after a
# fresh fetch. Every proof is a REFUSAL on failure, never a pass.
#
# The root is /tmp. REAP_STANDALONE_ROOT exists for the tests only, and it can only
# NARROW: it is refused unless its realpath is /tmp itself or a directory under /tmp,
# so no setting of it can admit a path outside /tmp.
reap_standalone() {
  local root root_real tmp_real cand name git_dir common_dir top wt_count dirty head \
    stashes tip ref before size after
  tmp_real=$(realpath -e -- /tmp) || die "cannot resolve /tmp"
  root=${REAP_STANDALONE_ROOT:-/tmp}
  case $root in *..*) die "traversing standalone root: $root" ;; esac
  root_real=$(realpath -e -- "$root") || die "unresolvable standalone root: $root"
  case $root_real in
    "$tmp_real" | "$tmp_real"/?*) ;;
    *) die "standalone root $root_real is not /tmp or under it — the root can only narrow" ;;
  esac

  # The path itself: literally <root>/<name>, one component, not the root, not a symlink.
  cand=$target
  while [ "${cand%/}" != "$cand" ] && [ "$cand" != / ]; do cand=${cand%/}; done
  while [ "${root%/}" != "$root" ] && [ "$root" != / ]; do root=${root%/}; done
  [ "$cand" != "$root" ] || die "refusing the standalone root itself: $root"
  name=${cand#"$root"/}
  [ "$name" != "$cand" ] || die "outside this station's perimeter: $real is neither inside $own_top, nor a registered worktree of this repository, nor a standalone clone directly under $root"
  [ -n "$name" ] || die "refusing the standalone root itself: $root"
  case $name in */*) die "not directly under $root (nested path): $cand" ;; esac
  [ ! -L "$cand" ] || die "refusing a symlink: $cand"
  [ "$real" != "$root_real" ] || die "refusing the standalone root itself: $root_real"
  [ "$real" = "$root_real/$name" ] || die "realpath $real is not $root_real/$name"

  # (a) a standalone checkout: its own top level, its own .git directory as common dir.
  [ -d "$real/.git" ] && [ ! -L "$real/.git" ] || die "standalone: $real has no .git directory of its own — not a standalone clone"
  top=$(git -C "$real" rev-parse --show-toplevel 2>/dev/null) || die "standalone: $real is not a git checkout"
  [ "$(realpath -m -- "$top")" = "$real" ] || die "standalone: $real is not the top level of its checkout ($top)"
  git_dir=$(git -C "$real" rev-parse --path-format=absolute --git-dir 2>/dev/null) || die "standalone: cannot read the git dir of $real"
  common_dir=$(git -C "$real" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "standalone: cannot read the common git dir of $real"
  [ "$(realpath -m -- "$git_dir")" = "$real/.git" ] && [ "$(realpath -m -- "$common_dir")" = "$real/.git" ] \
    || die "standalone: $real is a worktree of another repository (common dir $common_dir) — reap it through that repository"
  wt_count=$(git -C "$real" worktree list --porcelain 2>/dev/null | grep -c '^worktree ')
  [ "$wt_count" -eq 1 ] || die "standalone: $real has $((wt_count - 1)) linked worktree(s) of its own — removing it would orphan them"

  # (b) nothing tracked or untracked is changed.
  dirty=$(git -C "$real" status --porcelain --untracked-files=all 2>/dev/null) || die "standalone: cannot read the status of $real"
  [ -z "$dirty" ] || die "standalone: $(printf '%s\n' "$dirty" | wc -l) changed or untracked file(s) in $real — decide them first"

  # (c) a fresh fetch of EVERY origin head, then HEAD must be on one of them.
  #
  # Not `git fetch --prune origin`: a single-branch clone's configured refspec is
  # `+refs/heads/main:refs/remotes/origin/main` only, so that fetch never brings back
  # the branch its HEAD was pushed to and a pushed HEAD would read as lost (measured on
  # real leftovers). Every head is fetched explicitly into a throwaway namespace,
  # whatever the clone's refspec, and only that fresh namespace is trusted: a stale
  # refs/remotes/origin/* entry can no longer vouch for content. The namespace is
  # emptied BEFORE the fetch (a leftover from an earlier run must not pass) and on
  # every exit, refusal included. A failed fetch is a refusal, never a pass.
  git -C "$real" remote get-url origin >/dev/null 2>&1 || die "standalone: $real has no origin remote"
  check_ns=refs/reap-check
  clear_check_ns() {
    git -C "$real" for-each-ref --format='delete %(refname)' "$check_ns/" 2>/dev/null \
      | git -C "$real" update-ref --stdin 2>/dev/null
  }
  clear_check_ns
  [ -z "$(git -C "$real" for-each-ref "$check_ns/" 2>/dev/null)" ] || die "standalone: cannot clear $check_ns/ in $real"
  trap 'clear_check_ns' EXIT
  GIT_TERMINAL_PROMPT=0 timeout 120 git -C "$real" fetch --no-tags --quiet origin "+refs/heads/*:$check_ns/*" >/dev/null 2>&1 \
    || die "standalone: git fetch of every origin head failed in $real — cannot prove its content is on origin"
  head=$(git -C "$real" rev-parse --verify --quiet HEAD) || die "standalone: $real has no HEAD commit"
  [ -n "$(git -C "$real" for-each-ref --contains "$head" --format='%(refname)' "$check_ns/")" ] \
    || die "standalone: HEAD $head of $real is on no origin branch — content would be lost"

  # (d) nothing stashed, and every local branch tip is on an origin branch.
  stashes=$(git -C "$real" stash list 2>/dev/null) || die "standalone: cannot read the stash of $real"
  [ -z "$stashes" ] || die "standalone: $(printf '%s\n' "$stashes" | wc -l) stash entr(y/ies) in $real — content would be lost"
  while IFS=' ' read -r tip ref; do
    [ -n "$tip" ] || continue
    [ -n "$(git -C "$real" for-each-ref --contains "$tip" --format='%(refname)' "$check_ns/")" ] \
      || die "standalone: local branch ${ref#refs/heads/} ($tip) of $real has commits on no origin branch — content would be lost"
  done <<EOF
$(git -C "$real" for-each-ref --format='%(objectname) %(refname)' refs/heads || echo "unreadable refs/heads")
EOF

  echo "perimeter: a clean standalone clone under $root whose content is on origin" >&2
  before=$(df -k --output=avail / | tail -1)
  size=$(du -sh -- "$real" 2>/dev/null | cut -f1)
  trap - EXIT
  command rm -rf -- "$real"
  [ -e "$real" ] && die "still present after removal: $real"
  after=$(df -k --output=avail / | tail -1)
  echo "REAPED $real (was $size) — avail KiB ${before} -> ${after} (freed $((after-before)))"
  exit 0
}

[ "$in_perimeter" != no ] || reap_standalone
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
