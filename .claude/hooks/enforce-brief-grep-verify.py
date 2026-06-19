#!/usr/bin/env python3
"""
enforce-brief-grep-verify.py — PreToolUse(Agent) hook.

Day 107 friction-capture: sub-agents dispatched with briefs that reference
phantom file paths or symbols (paths that look real but don't exist) waste
a full turn before the sub-agent gives up. This hook surfaces those before
dispatch.

Rule: when an `Agent` tool call's prompt contains path-like references
(`convex/foo.ts`, `mcp-server/src/bar.ts:42`, `tests/baz/qux.test.ts`,
generic `path/to/file.ext` with at least one `/`), each path MUST exist on
disk relative to the current working directory. If any are MISSING, block
with the precise list so the orchestrator can fix the brief or confirm
the path is intentional.

Override (rare, one-shot — fix the brief after):
    add `// allow-missing-refs: <reason>` anywhere in the prompt.

Exit 0 = allow (no refs found OR all refs exist OR override present)
Exit 2 = block (≥1 path-like ref missing on disk)

Reference task k173as8n0zj8bmbznhvy9ch4a588yrp7.
"""
from __future__ import annotations

import json
import os
import re
import sys

# Recognised file extensions for path-like references in briefs.
# Keep narrow — only extensions actually used as path tokens in VP work briefs.
_EXTENSIONS = (
    "ts", "tsx", "js", "jsx", "mjs", "cjs",
    "py", "md", "mdx", "json", "yaml", "yml",
    "sh", "html", "css", "txt", "toml",
)

# Match `path/to/file.ext` or `path/to/file.ext:42` — requires ≥1 slash
# (otherwise bare filenames like "package.json" balloon false positives).
# Stop on whitespace, quotes, parens, commas, semicolons.
_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9_/\.])"                              # left boundary
    r"([A-Za-z0-9_./\-]+/[A-Za-z0-9_./\-]+\."           # at least one '/'
    rf"(?:{'|'.join(_EXTENSIONS)}))"                     # known extension
    r"(?::\d+(?:-\d+)?)?"                                # optional :LN or :LN-LM
    r"(?![A-Za-z0-9_])"                                  # right boundary
)

# Ignore matches that are URLs or live under deps / build output / VCS.
_IGNORE_PREFIXES = (
    "http://", "https://",
    "node_modules/", "dist/", "build/", ".next/", ".turbo/", "coverage/",
    ".git/",
    # Common doc-as-quote patterns ("path/to/file.ts" in a code fence) —
    # keep them, but skip these dummy paths the project's own docs use:
    "path/to/", "your/", "foo/", "bar/",
)

# Override marker — same convention as other VP hooks.
_OVERRIDE_RE = re.compile(r"//\s*allow-missing-refs\s*:\s*\S", re.IGNORECASE)

# Agent types exempt from this check (read-only / planning / no dispatch).
_EXEMPT_AGENTS = {
    "Explore",
    "Plan",
    "claude-code-guide",
    "statusline-setup",
}


def extract_refs(prompt: str) -> list[str]:
    """Return path-like references from prompt, deduped, in order of first match."""
    seen: set[str] = set()
    refs: list[str] = []
    for m in _PATH_RE.finditer(prompt):
        raw = m.group(1)
        path = raw.split(":", 1)[0]  # strip :LN suffix for existence check
        # Drop matches that are URL tails like `//example.com/foo.ts` — the
        # regex doesn't see the `http:` because the preceding `:` is a word
        # boundary. Belt: also skip the 5 chars before the match if they
        # look like a URL scheme.
        if path.startswith("//"):
            continue
        start = m.start()
        prefix5 = prompt[max(0, start - 8): start]
        if "http://" in prefix5 or "https://" in prefix5:
            continue
        if any(path.startswith(p) for p in _IGNORE_PREFIXES):
            continue
        if path in seen:
            continue
        seen.add(path)
        refs.append(path)
    return refs


def missing_refs(refs: list[str], cwd: str) -> list[str]:
    """Return the subset of refs that don't exist on disk relative to cwd."""
    missing: list[str] = []
    for ref in refs:
        # Try as-is, then relative to cwd, then absolute.
        candidates = [ref, os.path.join(cwd, ref)]
        if any(os.path.exists(c) for c in candidates):
            continue
        missing.append(ref)
    return missing


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        # Malformed input — let it through; other hooks may catch it.
        return 0

    tool_input = data.get("tool_input", {}) or {}
    prompt = tool_input.get("prompt", "") or ""
    agent_type = tool_input.get("subagent_type", "") or ""

    if not prompt:
        return 0
    if agent_type in _EXEMPT_AGENTS:
        return 0
    if _OVERRIDE_RE.search(prompt):
        return 0

    refs = extract_refs(prompt)
    if not refs:
        return 0

    cwd = data.get("cwd") or os.getcwd()
    missing = missing_refs(refs, cwd)
    total = len(refs)
    found = total - len(missing)

    if not missing:
        return 0

    # Block — list missing refs verbatim so the orchestrator can fix the brief.
    bullet_list = "\n".join(f"  - {m}" for m in missing)
    sys.stderr.write(
        "BLOCKED: Agent brief references paths that do not exist on disk.\n\n"
        f"Verified {found}/{total} path-like references — {len(missing)} MISSING:\n"
        f"{bullet_list}\n\n"
        "Day 107 friction-capture (task k173as8n): a phantom path in a brief\n"
        "wastes the sub-agent's whole turn. Fix the brief, then retry:\n"
        "  1. Confirm the path actually exists (`ls`, `git log -- <path>`).\n"
        "  2. If renamed, update the brief to the current path.\n"
        "  3. If intentional (e.g. file the sub-agent is about to CREATE),\n"
        "     add `// allow-missing-refs: <reason>` anywhere in the prompt.\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
