#!/usr/bin/env python3
"""Refuse a git ref that carries a client identity. A branch name is publication.

Day 128: four branches named after clients were pushed to the PUBLIC repo. The code
inside them was clean. The LEAK WAS THE NAME — visible in every `git ls-remote`, every
PR title, every GitHub notification e-mail, and in the repo's branch dropdown, to anyone
on earth. Pi renamed them by hand. Hands do not scale, and the next one is always the one
nobody remembered to look at.

WHY THIS IS NOT JUST THE LEAK GUARD AGAIN
-----------------------------------------
The leak guard reads FILES. A ref is not a file: it exists in `.git`, it is never
scanned, it never appears in a diff, and it survives every content purge ever run. It is
the third surface, after file contents and file names, and it is the one that publishes
itself the moment you type `git push`.

The vocabulary is the SAME resolved host-side config the leak guard uses — never
hardcoded here. A hand-typed client list rots at every new client, and the next one is
always the one nobody remembered to add. If the vocabulary cannot be resolved, this
refuses to judge rather than waving the push through: "I could not check" and "this is
clean" must not produce the same exit code.

WHY THE BOUNDARY MATTERS HERE MORE THAN ANYWHERE
------------------------------------------------
Branch names are built out of exactly the characters a naive `\\b` treats as word
characters or as boundaries in the wrong direction:

    fix/marie-iris-rh-drop-global    -> a real branch that was pushed
    feat/cedric-onboarding           -> a real branch that was pushed

`_`, `-`, `/` and `.` are ALL separators in a ref, and the matcher must see through every
one of them. It must equally NOT fire on a benign name that merely contains those letters
inside a longer word — a guard that blocks `fix/summaries-pagination` gets uninstalled
within the day, and an uninstalled guard blocks nothing at all.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from client_identity_config import (  # noqa: E402
    ClientIdentityConfigError,
    resolve_client_data_patterns,
)


def offending_patterns(ref: str, patterns: list[tuple[str, str]]) -> list[str]:
    """Reasons this ref is unpublishable. Never returns the matched text itself:
    reporting a leak by quoting it republishes it, and this output goes to stderr,
    to CI logs, and to anyone watching the terminal."""
    return [reason for rx, reason in patterns if re.search(rx, ref, re.IGNORECASE)]


def local_refs(repo: Path) -> list[str]:
    p = subprocess.run(
        ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"],
        cwd=repo, capture_output=True, text=True,
    )
    if p.returncode != 0:
        raise RuntimeError("`git for-each-ref` failed — refusing to guess at the ref list")
    return [line.strip() for line in p.stdout.splitlines() if line.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("refs", nargs="*", help="refs to check. Default: every local branch.")
    ap.add_argument("--repo", default=".")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()

    # FAIL CLOSED. A guard that cannot resolve its vocabulary must not wave the push
    # through — that is the whole defect class this repo has spent a week closing.
    try:
        patterns = resolve_client_data_patterns()
    except ClientIdentityConfigError as exc:
        print(f"REFUSING TO JUDGE: {exc}", file=sys.stderr)
        print(
            "A ref guard that cannot resolve its client vocabulary must not report a "
            "clean push. 'I could not check' and 'this is clean' are different answers.",
            file=sys.stderr,
        )
        return 2

    try:
        refs = args.refs or local_refs(repo)
    except RuntimeError as exc:
        print(f"REFUSING TO JUDGE: {exc}", file=sys.stderr)
        return 2

    blocked = False
    for ref in refs:
        reasons = offending_patterns(ref, patterns)
        if reasons:
            blocked = True
            # The ref is named back to the operator (they typed it, they already know it),
            # but the matched identity is NOT quoted — only the class of thing it is.
            print(f"BLOCKED ref: {ref}", file=sys.stderr)
            for r in reasons:
                print(f"  carries: {r}", file=sys.stderr)

    if blocked:
        print(
            "\nA branch name is PUBLICATION. It appears in `git ls-remote`, in the PR "
            "title, in every notification, and in the branch dropdown — to anyone. "
            "Rename the branch (`git branch -m <neutral-name>`) before pushing.\n"
            "Day 128: four such branches reached the public repo. Their contents were "
            "clean. The leak was the name.",
            file=sys.stderr,
        )
        return 1

    print(f"{len(refs)} ref(s) checked, none carry a client identity.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
