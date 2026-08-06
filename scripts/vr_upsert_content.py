#!/usr/bin/env python3
"""Deterministic file -> VantageRegistry (VR) content upsert with byte-exact read-back.

Doctrine: derive-never-type. A 71KB hook/skill body must NEVER be hand-retyped
into an MCP argument -- a single dropped byte is a silent corruption. This script
is the mechanism: it reads the file BYTES, ships them verbatim to VR via
`upsert_hook_content` / `upsert_skill_content`, then reads the item back via
`get_hook_content` / `get_skill_content` and asserts:

    sha256(local file bytes) == sha256(VR-returned content) == VR reported contentHash

Only when all three agree does it print PASS. Any mismatch or VR-unreachable is a
fail-loud, non-zero exit -- never a silent pass.

Hashing note (verified against the live target, 2026-08-06): VR's `contentHash`
is sha256 of the RAW content bytes, INCLUDING the single trailing newline. The
local hook `.claude/hooks/enforce-eta-approval-before-npm-publish.py` hashes to
`56f03965e3fd311cf02b9b8a00b990fb8b560a5fb2a3e2caaab23e9a4d191dc1` over its raw
bytes (trailing newline included) -- that is the target the live upsert must
reproduce. So the equality check hashes RAW bytes with no stripping; the same
normalization is applied to local, VR-returned content, and cross-checked against
VR's own contentHash field. (Contrast vr_plugin_parity.py, which strips the
trailing newline for its packaged-plugin parity gate; this script deliberately
does NOT, because the round-trip here is byte-for-byte identity, not tolerant
parity.)

Transport is REUSED verbatim from vr_plugin_parity.py: `_vr_rpc_call`,
`fetch_vr_content`, VRUnreachableError, and the VR_URL / VR_TOKEN env conventions.

CLI:
    python3 scripts/vr_upsert_content.py --kind {hook,skill} --name <item-name> \
        --file <path> [--version <semver>] [--dry-run]

--dry-run: skip the upsert (needs no write token) and only get_* + compare
local-vs-VR -- useful to verify parity of an already-upserted item read-only.

Token: the caller supplies VANTAGE_REGISTRY_TOKEN (a WRITE token for upsert). This
script NEVER embeds a token or secret.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Reuse the exact VR JSON-RPC transport + env conventions from the parity gate.
# We reference these THROUGH the module object (parity.<attr>) so that a test can
# monkeypatch `parity._vr_rpc_call` and have it take effect inside `fetch_vr_content`
# as well (which calls the module-global _vr_rpc_call).
import vr_plugin_parity as parity  # noqa: E402
from vr_plugin_parity import (  # noqa: E402
    DEFAULT_VR_URL,
    VR_TOKEN_ENV,
    VR_URL_ENV,
    VRUnreachableError,
)

# kind -> (upsert tool, get tool)
TOOLS: dict[str, tuple[str, str]] = {
    "hook": ("upsert_hook_content", "get_hook_content"),
    "skill": ("upsert_skill_content", "get_skill_content"),
}


def content_hash(data: bytes) -> str:
    """VR contentHash normalization: sha256 of the RAW bytes, no stripping."""
    return hashlib.sha256(data).hexdigest()


def upsert_content(
    vr_url: str,
    vr_token: str,
    upsert_tool: str,
    name: str,
    content: str,
    version: str | None,
) -> dict:
    """Ship the content to VR verbatim. Raises VRUnreachableError on any failure."""
    arguments: dict[str, object] = {"name": name, "content": content}
    if version:
        arguments["version"] = version
    return parity._vr_rpc_call(vr_url, vr_token, "tools/call", {"name": upsert_tool, "arguments": arguments})


def verify_roundtrip(
    kind: str,
    name: str,
    file_path: Path,
    vr_url: str,
    vr_token: str,
    version: str | None,
    dry_run: bool,
) -> int:
    upsert_tool, get_tool = TOOLS[kind]

    # 1. Read the file BYTES verbatim (never decode-then-reencode lossily).
    local_bytes = file_path.read_bytes()
    local_hash = content_hash(local_bytes)
    # The MCP arg is a string; decode with strict UTF-8 so a non-UTF-8 byte fails
    # loudly here rather than corrupting silently on the wire.
    try:
        local_text = local_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        print(f"FAIL: {file_path} is not valid UTF-8: {exc}", file=sys.stderr)
        return 2
    # Guard the round-trip identity assumption before we trust encode() later.
    if local_text.encode("utf-8") != local_bytes:
        print(f"FAIL: {file_path} does not round-trip through UTF-8 losslessly.", file=sys.stderr)
        return 2

    print(f"local: {file_path} sha256={local_hash} ({len(local_bytes)} bytes)")

    # 2. Upsert (unless read-only verify).
    if dry_run:
        print("dry-run: skipping upsert; read-only verify of the VR canonical.")
    else:
        try:
            upsert_content(vr_url, vr_token, upsert_tool, name, local_text, version)
            print(f"upsert: {upsert_tool}(name={name!r}"
                  + (f", version={version!r}" if version else "") + ") OK")
        except VRUnreachableError as exc:
            print(f"FAIL: upsert to VR failed: {exc}", file=sys.stderr)
            return 2

    # 3. Read back via get_* and compute sha over the RETURNED content.
    try:
        vr_data = parity.fetch_vr_content(vr_url, vr_token, get_tool, name)
    except VRUnreachableError as exc:
        print(f"FAIL: VR read-back failed: {exc}", file=sys.stderr)
        return 2

    if vr_data.get("__absent__"):
        print(f"FAIL: VR reports {name!r} absent after upsert: {vr_data.get('error')}", file=sys.stderr)
        return 2

    vr_content = vr_data["content"]
    vr_reported_hash = vr_data["contentHash"]
    vr_hash = content_hash(vr_content.encode("utf-8"))
    print(f"VR:    {name} sha256={vr_hash} contentHash={vr_reported_hash}")

    # 4. Assert local == VR-returned == VR reported contentHash.
    if local_hash != vr_hash:
        print(
            f"FAIL: byte mismatch -- local sha256={local_hash} != VR-returned "
            f"content sha256={vr_hash}. The upsert did NOT land the exact bytes.",
            file=sys.stderr,
        )
        return 1
    if vr_reported_hash != vr_hash:
        print(
            f"FAIL: VR's reported contentHash={vr_reported_hash} != sha256 of the "
            f"content VR returned={vr_hash}. VR is internally inconsistent for {name!r}.",
            file=sys.stderr,
        )
        return 1

    print(f"PASS: {kind} {name} byte-exact -- local == VR-returned == contentHash == {local_hash}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", required=True, choices=sorted(TOOLS))
    parser.add_argument("--name", required=True, help="VR item name (hooks keyed without .py)")
    parser.add_argument("--file", required=True, type=Path, help="Local file whose bytes to upsert")
    parser.add_argument("--version", default=None, help="Optional semver for the upsert")
    parser.add_argument("--dry-run", action="store_true", help="Read-only verify: no upsert, no write token needed")
    parser.add_argument("--vr-url", default=os.environ.get(VR_URL_ENV, DEFAULT_VR_URL))
    parser.add_argument("--vr-token", default=os.environ.get(VR_TOKEN_ENV))
    args = parser.parse_args(argv)

    if not args.file.is_file():
        print(f"FAIL: file not found: {args.file}", file=sys.stderr)
        return 2
    # A write token is required for a real upsert; --dry-run reads only.
    if not args.vr_token and not args.dry_run:
        print(f"FAIL: {VR_TOKEN_ENV} not set. An upsert requires a WRITE token.", file=sys.stderr)
        return 2

    return verify_roundtrip(
        kind=args.kind,
        name=args.name,
        file_path=args.file,
        vr_url=args.vr_url,
        vr_token=args.vr_token or "",
        version=args.version,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    sys.exit(main())
