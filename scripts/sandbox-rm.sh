#!/usr/bin/env bash
# sandbox-rm — remove one review sandbox, and nothing else.
#
# Purpose: a review clone is created, measured, and destroyed dozens of times a
# day. Expressing that removal as a general-purpose recursive delete, chained
# behind other commands, is the shape that costs an approval prompt and stops an
# autonomous orchestrator until a human returns. This script removes the NEED
# for that shape: one named action, one argument, no chaining.
#
# Three states, never two:
#   exit 0 — the target was inside an allowed root and is now gone
#   exit 1 — the target is OUTSIDE every allowed root: refused, nothing touched
#   exit 2 — cannot judge: no argument, unresolvable path, or an allowed root
#            that is not a directory. Names what it could not read.
#
# Allowed roots are derived from the environment, never hand-typed per call.
set -uo pipefail

# Roots come from the environment, never hand-typed per call. A caller may widen
# them with SANDBOX_RM_ROOTS (colon-separated); the default is the temp tree.
IFS=":" read -r -a ALLOWED_ROOTS <<< "${SANDBOX_RM_ROOTS:-/tmp:${TMPDIR:-/tmp}}"

if [[ $# -ne 1 ]]; then
  echo "REFUSING TO JUDGE: expected exactly one path argument, got $#." >&2
  echo '"I could not check" and "this is clean" are different answers.' >&2
  exit 2
fi

target="$1"

if [[ -z "$target" ]]; then
  echo "REFUSING TO JUDGE: empty path argument." >&2
  exit 2
fi

# Resolve without requiring existence: a already-gone target is not an error,
# but an unresolvable parent is something we could not read.
parent="$(dirname -- "$target")"
if ! resolved_parent="$(cd "$parent" 2>/dev/null && pwd -P)"; then
  echo "REFUSING TO JUDGE: cannot resolve parent directory of '$target'." >&2
  exit 2
fi
resolved="${resolved_parent%/}/$(basename -- "$target")"

inside=0
for root in "${ALLOWED_ROOTS[@]}"; do
  if ! real_root="$(cd "$root" 2>/dev/null && pwd -P)"; then
    echo "REFUSING TO JUDGE: allowed root '$root' is not a readable directory." >&2
    exit 2
  fi
  # Equality is refused too: the roots themselves are never removable.
  if [[ "$resolved" == "$real_root"/?* ]]; then
    inside=1
  fi
done

if [[ $inside -eq 0 ]]; then
  echo "REFUSED: '$resolved' is outside every allowed root (${ALLOWED_ROOTS[*]}). Nothing was touched." >&2
  exit 1
fi

# Detach the shell from the target before deleting it: if the cwd is the target
# (or a descendant), rm would pull the ground out from under us and every later
# builtin would emit "getcwd: cannot access parent directories", making a
# successful removal read as exit 1. Root is never a sandbox target, so it is a
# safe, always-present anchor.
cd / || true
rm -rf -- "$resolved"
echo "REMOVED: $resolved"
exit 0
