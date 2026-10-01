#!/usr/bin/env python3
"""Enumerate who READS a path, before that path is removed.

Class of failure this closes: a deletion is proven safe for its own CONTENT —
nothing uncommitted, no stash, no branch existing only there — and it is still a
deletion that breaks a consumer. The safe-delete protocol asks what would be LOST
FROM the tree and never asks WHO POINTS AT it. Measured: removing one workspace
copy broke 32 station configurations and 1495 symbolic links, and the only signal
was stations going silent one by one, each fail-closed on a hook that no longer
resolved.

Three consumer kinds are derived, never guessed:

  LINK     a symbolic link elsewhere whose target resolves inside the path
  CONFIG   a JSON settings file whose "command" strings name a path inside it
  TEXT     any other tracked/《plain》file naming the path literally

Exit codes, three outcomes and never two:

  0  no consumer found, and the scan is proven able to find one
  1  consumers found — they are printed, one per line, with their kind
  2  COULD NOT JUDGE — the scan root is unreadable, or the positive control
     failed, so a zero here would be a zero from a mute instrument

The positive control runs FIRST and is not optional: the scanner is pointed at a
path known to HAVE a consumer, and must report it. Without that, a clean result
is indistinguishable from a scanner that looked nowhere.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys


def _iter_files(root: str):
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if d not in {".git", "node_modules", "__pycache__"}]
        for name in filenames:
            yield os.path.join(dirpath, name)


def find_links_into(target: str, scan_roots: list[str]) -> list[str]:
    """Symbolic links anywhere under scan_roots whose target lands inside `target`."""
    hits = []
    for root in scan_roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = [d for d in dirnames if d not in {".git", "node_modules"}]
            for name in dirnames + filenames:
                p = os.path.join(dirpath, name)
                if not os.path.islink(p):
                    continue
                try:
                    dest = os.readlink(p)
                except OSError:
                    continue
                if not dest.startswith("/"):
                    dest = os.path.normpath(os.path.join(dirpath, dest))
                if dest == target or dest.startswith(target.rstrip("/") + "/"):
                    hits.append(p)
    return hits


def find_config_refs(target: str, scan_roots: list[str]) -> list[str]:
    """Settings files whose hook commands name a path inside `target`."""
    hits = []
    needle = target.rstrip("/")
    for root in scan_roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = [d for d in dirnames if d not in {".git", "node_modules"}]
            for name in filenames:
                if name != "settings.json" and not name.endswith(".settings.json"):
                    continue
                p = os.path.join(dirpath, name)
                try:
                    raw = open(p, encoding="utf-8", errors="replace").read()
                except OSError:
                    continue
                if needle in raw:
                    hits.append(p)
                    continue
                # a valid settings file whose commands we can parse gets a second look
                try:
                    json.loads(raw)
                except Exception:
                    pass
    return hits


def find_text_refs(target: str, scan_roots: list[str], skip: set[str]) -> list[str]:
    """Plain files naming the path literally, excluding what the other kinds found."""
    hits = []
    needle = target.rstrip("/")
    pat = re.compile(re.escape(needle))
    for root in scan_roots:
        if not os.path.isdir(root):
            continue
        for p in _iter_files(root):
            if p in skip or os.path.islink(p):
                continue
            if os.path.basename(p) == "settings.json":
                continue
            try:
                if os.path.getsize(p) > 2_000_000:
                    continue
                raw = open(p, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            if pat.search(raw):
                hits.append(p)
    return hits


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: consumers_of_path.py <path-about-to-be-removed> [scan-root ...]", file=sys.stderr)
        return 2

    target = os.path.abspath(argv[1]).rstrip("/")
    scan_roots = [os.path.abspath(r) for r in argv[2:]] or [os.path.dirname(target)]

    readable = [r for r in scan_roots if os.path.isdir(r)]
    if not readable:
        print("COULD-NOT-JUDGE: no scan root is readable: " + ", ".join(scan_roots))
        return 2

    # POSITIVE CONTROL, first. Point the scanner at the scan root itself: any
    # non-empty tree contains at least one file naming a path inside it, or the
    # instrument cannot see anything at all.
    control_target = readable[0]
    control = find_text_refs(control_target, readable, skip=set())
    if not control:
        print("COULD-NOT-JUDGE: positive control found no reference to "
              + control_target + " anywhere under " + ", ".join(readable)
              + " — the scanner cannot see references, so a zero proves nothing")
        return 2
    print("positive control: scanner sees references (" + str(len(control))
          + " file(s) naming " + control_target + ")")

    links = find_links_into(target, readable)
    configs = find_config_refs(target, readable)
    skip = set(links) | set(configs)
    texts = [p for p in find_text_refs(target, readable, skip) if not p.startswith(target + "/") and p != target]

    print("target: " + target)
    print("scan roots: " + ", ".join(readable))
    for p in sorted(links):
        print("LINK    " + p)
    for p in sorted(configs):
        print("CONFIG  " + p)
    for p in sorted(texts):
        print("TEXT    " + p)

    total = len(links) + len(configs) + len(texts)
    print("consumers: " + str(total)
          + "  (links " + str(len(links))
          + ", configs " + str(len(configs))
          + ", text " + str(len(texts)) + ")")
    if total:
        print("REFUSE: this path is read by the consumers above. Repoint each one, "
              "then re-run. A deletion proven safe for its own content is not "
              "proven safe for theirs.")
        return 1
    print("CLEAR: no consumer names this path, and the control proves the scan could see one.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
