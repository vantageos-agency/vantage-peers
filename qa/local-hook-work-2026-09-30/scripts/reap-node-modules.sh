#!/usr/bin/env bash
# reap-node-modules.sh — delete ONE node_modules directory, and only that.
#
# WHY A NAMED SCRIPT. `.claude/rules/post-merge-cleanup.md` ("Call form"): a
# deletion never travels chained with other commands, and the script NAME is what
# appears in the permission allowlist, never a deletion pattern. A chained inline
# `rm -rf` on an absolute path is the form the runtime asks a human about — silent
# for the rest of a warm session, and halting on the first call of a fresh one,
# overnight, when nobody is watching.
#
# WHY node_modules ONLY. Same rule, safe-delete protocol step 4: the weight is
# node_modules, never commits. Deleting reinstallable dependencies frees the space
# and destroys zero work; deleting commits destroys work and frees nothing. This
# script therefore REFUSES any path whose basename is not `node_modules`, so it
# cannot be pointed at a worktree even by mistake.
#
# Usage: reap-node-modules.sh <absolute path ending in /node_modules>
set -uo pipefail

TARGET="${1:?usage: reap-node-modules.sh <path/to/node_modules>}"

die() { echo "REFUSED: $1" >&2; exit 2; }

# The workspace root is DERIVED, never typed, and every deletion must sit under it.
OWN_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"

# A SECOND permitted root: this session's own scratchpad. It is passed in through
# VP_SESSION_SCRATCHPAD rather than written here, because the path contains a
# session id this script cannot derive and must never guess. Unset, it simply does
# not widen anything — the workspace root stays the only permitted root. Anything
# under /tmp that this session did NOT create belongs to another station: it is
# measured and reported, never deleted, however abandoned it looks.
SCRATCH_ROOT="${VP_SESSION_SCRATCHPAD:-}"
if [ -n "$SCRATCH_ROOT" ]; then
  [ -d "$SCRATCH_ROOT" ] || die "VP_SESSION_SCRATCHPAD is set but is not a directory: $SCRATCH_ROOT"
  SCRATCH_ROOT=$(realpath -- "$SCRATCH_ROOT")
fi

case "$TARGET" in
  */node_modules) ;;
  *) die "basename is not 'node_modules' — this script deletes dependencies, never work: $TARGET" ;;
esac
[ -n "$TARGET" ]            || die "empty path"
[ "$TARGET" != "/" ]        || die "root"
case "$TARGET" in *..*) die "traversing path: $TARGET" ;; esac

REAL=$(realpath -m -- "$TARGET")
permitted=no
case "$REAL" in "$OWN_ROOT"/*) permitted=yes ;; esac
if [ -n "$SCRATCH_ROOT" ]; then
  case "$REAL" in "$SCRATCH_ROOT"/*) permitted=yes ;; esac
fi
[ "$permitted" = yes ] || die "path is under neither the workspace root ($OWN_ROOT) nor this session's scratchpad (${SCRATCH_ROOT:-unset}) — measure and report it, never delete it: $REAL"

[ -d "$REAL" ] || { echo "already absent: $REAL"; exit 0; }
[ ! -L "$REAL" ] || die "path is a symlink, refusing to follow it: $REAL"

SIZE=$(du -sh -- "$REAL" 2>/dev/null | cut -f1)
rm -rf -- "$REAL"

# Prove the absence by RE-READING, never by the exit code of the delete.
if [ -d "$REAL" ]; then
  echo "FAILED: still present after delete: $REAL" >&2
  exit 1
fi
echo "reaped $SIZE  $REAL"
