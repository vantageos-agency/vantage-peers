#!/usr/bin/env bash
# pre-push — refuse to publish a ref that carries a client identity.
#
# NOT INSTALLED BY THIS REPO. Hook files are Pi's single-writer domain (RULE #30).
# Handed over, not installed. To install:
#     cp artifacts/pre-push-guard-client-refs.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push
#
# WHY A PRE-PUSH AND NOT A PRE-COMMIT
# A branch name is harmless on your laptop and PUBLISHED the instant you push: it shows
# up in `git ls-remote`, in the PR title, in every notification e-mail, and in the branch
# dropdown, to anyone on earth. The commit is not the publication event. The push is.
#
# Day 128: four branches named after clients reached the PUBLIC repo. The code inside
# them was clean. THE LEAK WAS THE NAME. They were renamed by hand — and hands do not
# scale, because the next one is always the one nobody remembered to look at.
#
# FAIL-CLOSED, DELIBERATELY. If the client vocabulary cannot be resolved (no host config
# on this machine), the guard exits 2 and the push is REFUSED. That is not pedantry: a
# machine with no host config is exactly the kind of machine where an unreviewed branch
# gets created, and "I could not check" must never be waved through as "this is clean".
#
# The override exists, is loud, and is on the record:
#     SKIP_CLIENT_REF_GUARD=1 git push ...
# Use it and you own the ref you publish.

set -euo pipefail

if [[ "${SKIP_CLIENT_REF_GUARD:-0}" == "1" ]]; then
  echo "pre-push: client-ref guard SKIPPED by explicit override. You own this push." >&2
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel)"
guard="${repo_root}/scripts/guard_git_refs.py"

if [[ ! -f "$guard" ]]; then
  echo "pre-push: ${guard} is missing — refusing to push rather than pretend it was checked." >&2
  echo "A guard that cannot find itself must not report success." >&2
  exit 1
fi

# stdin gives: <local ref> <local sha> <remote ref> <remote sha>
refs=()
while read -r local_ref _ _ _; do
  [[ -z "${local_ref}" ]] && continue
  [[ "${local_ref}" == "(delete)" ]] && continue   # deleting a bad ref is the CURE, never block it
  refs+=("${local_ref#refs/heads/}")
done

# Nothing to judge (e.g. a tag-only push) -> say so, do not silently succeed.
if [[ ${#refs[@]} -eq 0 ]]; then
  echo "pre-push: no branch refs in this push; nothing to check." >&2
  exit 0
fi

python3 "$guard" "${refs[@]}" --repo "$repo_root"
