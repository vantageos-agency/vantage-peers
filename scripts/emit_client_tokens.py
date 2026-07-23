#!/usr/bin/env python3
"""CLI entry point: resolve the host-side client-identity vocabulary and
print the RAW tokens (not compiled multi-separator regex) as a JSON array
of strings on stdout.

WHY THIS EXISTS ALONGSIDE `emit_client_patterns.py`:

`emit_client_patterns.py` (and the branch-ref guard it shares logic with,
`guard_git_refs.py` / PR #1099) joins a multi-word identity (e.g. an org
name of the form "Acme Co") with ANY of space, `-`, `_`, `.`, `/` --
deliberately, because a git branch name can never contain a space, so a
kebab-cased form like `acme-co` is the ONLY way that identity could
appear in a ref and the guard must catch it.

The SOURCE-PROSE guard
(`convex/__tests__/sourceSurfaceClientIdentityLeak.test.ts`) has the
opposite problem: this codebase's own namespace/profile IDENTIFIERS
legitimately spell client identities as a kebab-case slug -- e.g.
`orchestrator/acme-co`, `profileId: "acme-co-hr"`,
`project/acme-co` -- and those are the ABSOLUTE DO-NOT-TOUCH authorization
identifiers this PR is explicitly forbidden from touching. Reusing the
hyphen-joining pattern would flag every one of those identifiers as a
"leak", which is both wrong (they are not prose, they are auth-critical
constants) and would make the guard impossible to keep green without
breaking auth.

So the source-prose guard builds its OWN pattern from these raw tokens,
joining multi-word tokens with WHITESPACE ONLY. Natural-language prose can
contain a space (a two-word org or contact name); a kebab-case identifier
never legitimately does. That single distinction is what lets the guard
catch client names typed into `description:` fields and comments while
leaving kebab-case-slug identifiers alone.

Contract identical to `emit_client_patterns.py`: exit 0 + JSON array on
stdout on success; exit 1 + message on stderr, nothing meaningful on
stdout, if the vocabulary cannot be resolved.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from client_identity_config import (  # noqa: E402
    REQUIRED_LIST_KEYS,
    ClientIdentityConfigError,
    load_raw_config,
    resolve_config_path,
)


def main() -> int:
    try:
        cfg_path = resolve_config_path()
        config = load_raw_config(cfg_path)
    except ClientIdentityConfigError as exc:
        print(f"emit_client_tokens: {exc}", file=sys.stderr)
        return 1

    tokens: list[str] = []
    for key in REQUIRED_LIST_KEYS:
        tokens.extend(config.get(key, []))

    if not tokens:
        print(
            "emit_client_tokens: resolved to ZERO tokens -- refusing to print "
            "an empty-but-successful result.",
            file=sys.stderr,
        )
        return 1

    print(json.dumps(tokens))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
