#!/usr/bin/env python3
"""CLI entry point: resolve the host-side client-identity vocabulary into
compiled regex patterns and print them as a JSON array of regex-source
strings on stdout.

Used by the source-surface leak guard test
(`convex/__tests__/sourceSurfaceClientIdentityLeak.test.ts`) so the client
vocabulary NEVER lives inside the guard code or the repo -- only the
resolver logic (this file + `client_identity_config.py`) does, and both
already live outside the public description/comment surface being checked.

Contract:
  - Exit 0, JSON array of regex-source strings on stdout: vocabulary resolved.
  - Exit 1, error message on stderr, NOTHING meaningful on stdout: vocabulary
    could NOT be resolved. The caller MUST treat this as a hard failure --
    "I could not resolve the vocabulary" and "there are zero patterns" are
    different outcomes and must never be conflated (see
    `client_identity_config.ClientIdentityConfigError` docstring).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from client_identity_config import (  # noqa: E402
    ClientIdentityConfigError,
    resolve_client_data_patterns,
)


def main() -> int:
    try:
        patterns = resolve_client_data_patterns()
    except ClientIdentityConfigError as exc:
        print(f"emit_client_patterns: {exc}", file=sys.stderr)
        return 1

    if not patterns:
        print(
            "emit_client_patterns: resolved to ZERO patterns -- refusing to "
            "print an empty-but-successful result.",
            file=sys.stderr,
        )
        return 1

    print(json.dumps([rx for rx, _reason in patterns]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
