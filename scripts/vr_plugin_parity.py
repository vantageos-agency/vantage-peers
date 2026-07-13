#!/usr/bin/env python3
"""VantageRegistry (VR) <-> packaged plugin parity gate.

Day 130 incident: the SILENCE CONTRACT fix for `check-messages` was
written, reviewed and committed to VR — but never reached the packaged
plugin sources (`plugin/skills/*/SKILL.md`, `plugin/hooks/*.py`), which
are frozen copies baked at packaging time. This script closes that gap:
it enumerates the packaged artifact from disk (never a hand-maintained
list) and compares every item's content hash against VR's canonical
hash, byte-exact.

Hashing note (established Day 130): VR's `contentHash` is sha256 of the
content WITHOUT a trailing newline. Local files on disk end with `\n`.
So we compare sha256(local_bytes.rstrip(b"\n")) against VR's contentHash.

Design constraints (non-negotiable, see task k17at7kta2ty5dy1tkytzp1s318acacw):
  1. Coverage inventory is derived from the packaged directories, not a
     hand-written list.
  2. No silent third state: every packaged item is CHECKED or
     SKIPPED-WITH-A-WRITTEN-REASON. CHECKED ∪ SKIPPED must cover 100%
     of the enumerated artifact or the gate fails.
  3. Fail loudly: VR unreachable / malformed response / name absent
     from VR -> gate FAILS and names what could not be resolved. Never
     fail-open.
  4. Anti-silence sanity check: zero packaged items enumerated is a
     broken parser, not a clean repo -> FAIL.
  5. Per-item report: name, local hash, VR hash, verdict. On
     divergence, name the file and show a diff snippet.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from difflib import unified_diff
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from leak_guard import (  # noqa: E402  (SECRECY > PARITY -- see check_item)
    client_data,
    internal_ids,
    scan_text,
)

VR_URL_ENV = "VANTAGE_REGISTRY_MCP_URL"
VR_TOKEN_ENV = "VANTAGE_REGISTRY_TOKEN"
DEFAULT_VR_URL = "https://vantage-registry-mcp-production.up.railway.app/mcp"

REPO_ROOT = Path(__file__).resolve().parent.parent
PLUGIN_SKILLS_DIR = REPO_ROOT / "plugin" / "skills"
PLUGIN_HOOKS_DIR = REPO_ROOT / "plugin" / "hooks"

# Packaged items that are known, on record, to have no VR canonical
# counterpart (e.g. plugin-only glue that never lived in VR). Anything
# NOT in this set that also fails VR lookup is a hard FAIL (constraint 3),
# not a silent skip -- this set exists so genuine non-VR items don't
# spam false negatives, and every entry must carry a written reason.
KNOWN_NO_VR_CANONICAL: dict[str, str] = {
    "session-end.py": (
        "VR get_hook_content('session-end') returns contentHash=null, "
        "content=null -- confirmed live 2026-07-13 (no VR canonical exists "
        "for this hook name or the 'session-end-pi' variant). Packaging-local "
        "only; not a divergence, since there is nothing in VR to diverge from."
    ),
}


class VRUnreachableError(RuntimeError):
    """Raised when VR cannot be reached or returns a malformed response."""


@dataclass
class ParityResult:
    kind: str  # "skill" | "hook"
    name: str
    local_path: Path
    # Verdicts:
    #   MATCH                     -- byte-exact with VR canonical. Green.
    #   SKIPPED                   -- no VR canonical exists; written reason. Green.
    #   DIVERGED                  -- differs from a CLEAN VR canonical. FAIL.
    #   MISSING_FROM_VR           -- packaged but absent from VR, unexplained. FAIL.
    #   VR_UNREACHABLE            -- could not resolve source of truth. FAIL.
    #   LEAK_IN_PACKAGED          -- packaged file itself carries identifiers. FAIL (secrecy).
    #   PARITY_SUSPENDED_SECRECY  -- VR canonical carries identifiers; we REFUSE to
    #                                sync it. Parity not enforced, but build still
    #                                FAILS: this is an open incident, not an accepted
    #                                state. See module docstring / leak_guard.py.
    verdict: str
    local_hash: str | None = None
    vr_hash: str | None = None
    reason: str | None = None
    diff: str | None = None
    leaks: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        # NOTE: PARITY_SUSPENDED_SECRECY is deliberately NOT ok. "I refuse to sync
        # this because it would leak" and "everything is fine" must produce
        # DIFFERENT outputs -- that is the entire point of the suspension.
        return self.verdict in ("MATCH", "SKIPPED")


def sha256_no_trailing_newline(data: bytes) -> str:
    return hashlib.sha256(data.rstrip(b"\n")).hexdigest()


def enumerate_packaged_skills() -> list[Path]:
    if not PLUGIN_SKILLS_DIR.is_dir():
        return []
    out = []
    for child in sorted(PLUGIN_SKILLS_DIR.iterdir()):
        skill_md = child / "SKILL.md"
        if child.is_dir() and skill_md.is_file():
            out.append(skill_md)
    return out


def enumerate_packaged_hooks() -> list[Path]:
    if not PLUGIN_HOOKS_DIR.is_dir():
        return []
    return sorted(p for p in PLUGIN_HOOKS_DIR.iterdir() if p.is_file() and p.suffix == ".py")


def _vr_rpc_call(url: str, token: str, method: str, params: dict, req_id: int = 1) -> dict:
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.URLError as exc:
        raise VRUnreachableError(f"VR unreachable at {url}: {exc}") from exc
    except TimeoutError as exc:
        raise VRUnreachableError(f"VR request timed out at {url}: {exc}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise VRUnreachableError(f"VR returned malformed JSON: {raw[:300]!r}") from exc

    if "error" in data:
        raise VRUnreachableError(f"VR RPC error: {data['error']}")
    if "result" not in data:
        raise VRUnreachableError(f"VR response missing 'result': {raw[:300]!r}")
    return data["result"]


def fetch_vr_content(url: str, token: str, tool_name: str, item_name: str) -> dict:
    """Call VR's get_skill_content / get_hook_content, return the parsed inner dict.

    Raises VRUnreachableError on any transport / shape failure (fail loud,
    never fail open). Returns {} if VR explicitly reports the item absent
    (caller distinguishes MISSING_FROM_VR from VR_UNREACHABLE).
    """
    result = _vr_rpc_call(url, token, "tools/call", {"name": tool_name, "arguments": {"name": item_name}})
    content_blocks = result.get("content")
    if not content_blocks or not isinstance(content_blocks, list):
        raise VRUnreachableError(f"VR tools/call for {item_name!r} returned no content blocks: {result!r}")
    text = content_blocks[0].get("text")
    if text is None:
        raise VRUnreachableError(f"VR tools/call for {item_name!r} returned a content block with no text: {content_blocks[0]!r}")

    try:
        inner = json.loads(text)
    except json.JSONDecodeError as exc:
        raise VRUnreachableError(f"VR content payload for {item_name!r} is not valid JSON: {text[:300]!r}") from exc

    if isinstance(inner, dict) and inner.get("error"):
        # VR reports the item does not exist -> explicit absence, not unreachable.
        return {"__absent__": True, "error": inner["error"]}

    if not isinstance(inner, dict) or "contentHash" not in inner or "content" not in inner:
        raise VRUnreachableError(f"VR content payload for {item_name!r} missing content/contentHash: {inner!r}")

    # VR's shape for a genuinely-absent item: contentHash and content are
    # both explicitly null (no "error" key) rather than raising. Treat
    # that as absence, not as a malformed/unreachable response.
    if inner.get("contentHash") is None and inner.get("content") is None:
        return {"__absent__": True, "error": f"VR has no content registered for {item_name!r} (contentHash and content are both null)"}

    return inner


def check_item(
    kind: str,
    name: str,
    local_path: Path,
    vr_url: str,
    vr_token: str,
    tool_name: str,
    vr_lookup_name: str | None = None,
) -> ParityResult:
    local_bytes = local_path.read_bytes()
    local_hash = sha256_no_trailing_newline(local_bytes)
    lookup_name = vr_lookup_name if vr_lookup_name is not None else name

    # --- RULE 1: SECRECY OUTRANKS PARITY (checked first, on the LOCAL artifact).
    # TIER 1 ONLY. Real client data in a packaged file is a hard block, always.
    # TIER 2 (internal identifiers) is NOT handled here: it is already public on
    # origin/main, so hard-blocking on it would make the gate permanently red and
    # get it disabled. TIER 2 is handled by the leak guard's baseline/regression
    # rule (see leak_guard.py) and surfaced as tracked findings, not parity fails.
    local_findings = scan_text(local_bytes.decode("utf-8", errors="replace"), str(local_path))
    local_client_data = client_data(local_findings)
    local_tracked = internal_ids(local_findings)
    if local_client_data:
        return ParityResult(
            kind=kind,
            name=name,
            local_path=local_path,
            verdict="LEAK_IN_PACKAGED",
            local_hash=local_hash,
            reason=(
                f"packaged file carries {len(local_client_data)} REAL CLIENT DATA "
                "identifier(s) (client org / contact person) and this package is "
                "PUBLIC. Purge the file. Do NOT resolve this by syncing from VR -- "
                "check whether the VR canonical is itself dirty."
            ),
            leaks=local_client_data,
        )

    try:
        vr_data = fetch_vr_content(vr_url, vr_token, tool_name, lookup_name)
    except VRUnreachableError as exc:
        return ParityResult(
            kind=kind,
            name=name,
            local_path=local_path,
            verdict="VR_UNREACHABLE",
            local_hash=local_hash,
            reason=str(exc),
        )

    if vr_data.get("__absent__"):
        # We still queried VR live (fail-loud path above already covers
        # transport/shape failures). Only downgrade an explicit, live-confirmed
        # absence to SKIPPED if it's on the written allowlist -- anything else
        # missing from VR is a hard FAIL (MISSING_FROM_VR), not a silent skip.
        if name in KNOWN_NO_VR_CANONICAL:
            return ParityResult(
                kind=kind,
                name=name,
                local_path=local_path,
                verdict="SKIPPED",
                local_hash=local_hash,
                reason=KNOWN_NO_VR_CANONICAL[name],
            )
        return ParityResult(
            kind=kind,
            name=name,
            local_path=local_path,
            verdict="MISSING_FROM_VR",
            local_hash=local_hash,
            reason=f"VR has no canonical for {name!r}: {vr_data.get('error')}",
        )

    vr_content = vr_data["content"]
    # Do NOT trust VR's self-reported contentHash field for the comparison:
    # empirically (verified live, check-messages, 2026-07-13) it is
    # inconsistent about whether it strips the trailing newline. For the
    # actual byte-exact comparison we recompute both sides the same way
    # (sha256 with trailing newline stripped) so a single trailing-newline
    # difference never produces a false DIVERGED/MATCH. The field is still
    # surfaced in the report for traceability.
    vr_hash_field = vr_data["contentHash"]
    vr_hash = sha256_no_trailing_newline(vr_content.encode("utf-8"))

    # --- RULE 2: PARITY, WITH SECRECY-SUSPENSION -- TIER 1 ONLY.
    # If the VR canonical carries REAL CLIENT DATA, we must NOT demand byte-parity
    # with it: doing so would make purging the leak from the packaged file turn CI
    # RED, permanently blocking the fix and forcing the leak back in. A guard that
    # compels the very thing it should prevent is worse than no guard. So parity is
    # SUSPENDED -- but the build STILL FAILS: a dirty canonical is an open incident,
    # not an accepted state.
    #
    # A canonical carrying only TIER 2 internal identifiers is NOT suspended. Those
    # strings are already public on origin/main (verbatim, in the very files we are
    # replacing), so syncing adds ZERO new exposure -- and refusing to sync would
    # block the actual fix (e.g. the check-messages SILENCE CONTRACT) on a string
    # that is already published. That is theatre, not security.
    vr_findings = scan_text(vr_content, f"VR:{name}")
    vr_client_data = client_data(vr_findings)
    if vr_client_data:
        return ParityResult(
            kind=kind,
            name=name,
            local_path=local_path,
            verdict="PARITY_SUSPENDED_SECRECY",
            local_hash=local_hash,
            vr_hash=vr_hash_field,
            reason=(
                f"VR canonical carries {len(vr_client_data)} REAL CLIENT DATA "
                "identifier(s) (client org / contact person); syncing it would leak "
                "client confidentiality into a public package. Parity is NOT enforced "
                f"for this item. REQUIRED ACTION: purge the VR canonical for {name!r} "
                "(upsert a cleaned version to VantageRegistry), after which parity is "
                "automatically restored and this item goes green."
            ),
            leaks=vr_client_data,
        )

    if local_hash == vr_hash:
        return ParityResult(
            kind=kind, name=name, local_path=local_path, verdict="MATCH",
            local_hash=local_hash, vr_hash=vr_hash_field,
            leaks=local_tracked,  # TIER 2: reported as tracked, does not fail
        )

    local_text = local_bytes.decode("utf-8", errors="replace").splitlines(keepends=True)
    vr_text = vr_content.splitlines(keepends=True)
    diff_lines = list(
        unified_diff(vr_text, local_text, fromfile=f"VR:{name}", tofile=f"local:{local_path}", n=2)
    )[:60]
    return ParityResult(
        kind=kind,
        name=name,
        local_path=local_path,
        verdict="DIVERGED",
        local_hash=local_hash,
        vr_hash=vr_hash,
        diff="".join(diff_lines),
    )


def run_gate(vr_url: str, vr_token: str) -> tuple[list[ParityResult], bool]:
    skill_paths = enumerate_packaged_skills()
    hook_paths = enumerate_packaged_hooks()

    total = len(skill_paths) + len(hook_paths)
    if total == 0:
        # Constraint 4: zero packaged items is a broken parser, not a clean repo.
        raise VRUnreachableError(
            "Zero packaged items enumerated from plugin/skills/ and plugin/hooks/. "
            "This is a broken parser/path, not a clean repo. FAILING."
        )

    results: list[ParityResult] = []
    for skill_md in skill_paths:
        name = skill_md.parent.name
        results.append(check_item("skill", name, skill_md, vr_url, vr_token, "get_skill_content"))
    for hook_py in hook_paths:
        # VR's hook registry keys hooks WITHOUT the .py extension
        # (verified live: get_hook_content('session-start') resolves,
        # get_hook_content('session-start.py') returns null content).
        # We report using the on-disk filename (with .py) so the report
        # names the actual packaged artifact, but query VR by stem.
        name = hook_py.name
        vr_name = hook_py.stem
        results.append(check_item("hook", name, hook_py, vr_url, vr_token, "get_hook_content", vr_lookup_name=vr_name))

    # Constraint 2: CHECKED ∪ SKIPPED must equal 100% of enumerated artifact.
    covered_paths = {r.local_path for r in results}
    all_paths = set(skill_paths) | set(hook_paths)
    uncovered = all_paths - covered_paths
    if uncovered:
        raise VRUnreachableError(f"Coverage gap: {sorted(str(p) for p in uncovered)} were enumerated but never checked or skipped.")

    passed = all(r.ok for r in results)
    return results, passed


def print_report(results: list[ParityResult]) -> None:
    print(f"{'KIND':6} {'NAME':30} {'VERDICT':24} LOCAL_HASH -> VR_HASH")
    print("-" * 110)
    for r in results:
        lh = (r.local_hash or "")[:12]
        vh = (r.vr_hash or "")[:12]
        print(f"{r.kind:6} {r.name:30} {r.verdict:24} {lh} -> {vh}")
        if r.verdict == "PARITY_SUSPENDED_SECRECY":
            print(
                f"    PARITY_SUSPENDED_SECRECY: {r.name} — VR canonical carries client "
                "identifiers; syncing it would leak into a public package"
            )
        if r.reason:
            print(f"    reason: {r.reason}")
        for leak in r.leaks[:6]:
            print(f"    leak: {leak.render()}")
        if len(r.leaks) > 6:
            print(f"    leak: ... and {len(r.leaks) - 6} more")
        if r.diff:
            print("    --- diff (VR canonical vs local packaged) ---")
            for line in r.diff.splitlines():
                print(f"    {line}")

    def n(v: str) -> int:
        return sum(1 for r in results if r.verdict == v)

    print("-" * 110)
    print(
        f"total={len(results)} match={n('MATCH')} skipped={n('SKIPPED')} "
        f"diverged={n('DIVERGED')} missing_from_vr={n('MISSING_FROM_VR')} "
        f"vr_unreachable={n('VR_UNREACHABLE')} "
        f"leak_in_packaged={n('LEAK_IN_PACKAGED')} "
        f"parity_suspended_secrecy={n('PARITY_SUSPENDED_SECRECY')}"
    )

    if n("LEAK_IN_PACKAGED") or n("PARITY_SUSPENDED_SECRECY"):
        print()
        print("SECRECY > PARITY. Required actions:")
        for r in results:
            if r.verdict == "LEAK_IN_PACKAGED":
                print(f"  - PURGE PACKAGED FILE: {r.local_path} (live leak in a PUBLIC package)")
            if r.verdict == "PARITY_SUSPENDED_SECRECY":
                print(
                    f"  - PURGE VR CANONICAL: {r.name} — upsert a cleaned version to "
                    "VantageRegistry; parity is then automatically restored and this "
                    "item goes green. Until then this build stays RED by design."
                )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vr-url", default=os.environ.get(VR_URL_ENV, DEFAULT_VR_URL))
    parser.add_argument("--vr-token", default=os.environ.get(VR_TOKEN_ENV))
    args = parser.parse_args()

    if not args.vr_token:
        print(f"FAIL: {VR_TOKEN_ENV} not set. Cannot authenticate to VantageRegistry.", file=sys.stderr)
        return 2

    try:
        results, passed = run_gate(args.vr_url, args.vr_token)
    except VRUnreachableError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 2

    print_report(results)

    if not passed:
        reasons = sorted({r.verdict for r in results if not r.ok})
        print(
            f"\nGATE FAILED ({', '.join(reasons)}). See the required actions above.",
            file=sys.stderr,
        )
        return 1

    print(
        "\nGATE PASSED: every packaged source is leak-free AND byte-exact with a "
        "leak-free VantageRegistry canonical (or explicitly skipped with a written reason)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
