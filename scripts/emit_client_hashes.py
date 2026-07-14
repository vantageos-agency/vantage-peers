#!/usr/bin/env python3
"""Emit the salted-hash client-identity vocabulary for CI, from the host config.

Run this ONCE, BY HAND, on a machine that has the plaintext host config
(`VANTAGE_CLIENT_IDENTITIES` / `~/.claude/vantage-client-identities.json`).
It prints a JSON object -- `{"algo": "sha256", "salt": "...", "hashes":
[...]}` -- to stdout, meant to be pasted verbatim into a GitHub Actions
secret (`VANTAGE_CLIENT_HASHES`). Re-run and re-paste whenever the host
config changes (new client, renamed org, etc.).

WE DO NOT TRANSPORT THE SECRET TO PROVE WE DETECT IT: this script's entire
purpose is to be the ONE place plaintext identities are read and reduced to
salted hashes, so nothing else -- not this script's own output, not the CI
secret, not the guard's CI-mode findings -- ever needs to hold or print a
client name.

This script NEVER prints a plaintext client identity. If you are tempted to
add a `--verbose` / `--debug` flag that echoes the source tokens "just to
check", don't -- that defeats the entire point of hashing before this data
leaves the machine that holds it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from client_identity_config import (  # noqa: E402
    ClientIdentityConfigError,
    build_hashed_vocabulary,
    load_raw_config,
    resolve_config_path,
)


def main() -> int:
    path = resolve_config_path()
    try:
        config = load_raw_config(path)
    except ClientIdentityConfigError as exc:
        print(f"FAIL: could not load host client-identity config: {exc}", file=sys.stderr)
        return 2

    vocab = build_hashed_vocabulary(config)
    print(json.dumps(vocab, indent=2))
    print(
        f"# {len(vocab['hashes'])} salted hash(es) derived from {path}. "
        "Paste the JSON object above into the VANTAGE_CLIENT_HASHES GitHub "
        "Actions secret. Re-run and re-paste whenever the host config changes.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
