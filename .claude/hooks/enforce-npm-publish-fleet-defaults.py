#!/usr/bin/env python3
"""
PreToolUse hook : enforce fleet npm publish defaults on `npm publish` for fleet
packages.

Doctrine: briefing js73myh9 (Day 106). Every fleet npm package must ship with:
  - license = "FSL-1.1-Apache-2.0" (same as VP canonical)
  - LICENSE file at repo root, byte-exact to VP canonical
  - `--access public` (or `--access restricted` if intentional private)

Trigger: command contains `npm publish` (and NOT `--dry-run`) AND cwd's
package.json `name` matches the fleet regex.

Fleet regex (extend as new scopes ship):
  ^@vantageos/
  ^@elpiarthera/
  ^vantage-.*-mcp$
  ^@perello/

Checks:
  (a) package.json `license` == "FSL-1.1-Apache-2.0"
  (b) LICENSE (or LICENSE.md) present at cwd root, non-empty
  (c) sha256sum(LICENSE) == CANONICAL_LICENSE_SHA256
  (d) command contains explicit `--access public` or `--access restricted`

Override: `# allow-other-license: <reason linked to fix-pattern>` on the same
line as the npm publish command. Usage unique then fix root cause.

Exit 0 = allow
Exit 2 = block

Day 109 fix : empty/invalid stdin = fail-open (orchestrators verify with stdin vide must exit 0).
"""
import hashlib
import json
import os
import re
import sys

CANONICAL_LICENSE_SHA256 = (
    "3d458972e6e84e5d2361a886ef64b07aefdc38dd8955e281ea8c2ae8849646a4"
)
CANONICAL_LICENSE_STRING = "FSL-1.1-Apache-2.0"

FLEET_NAME_PATTERNS = [
    re.compile(r"^@vantageos/"),
    re.compile(r"^@elpiarthera/"),
    re.compile(r"^vantage-.*-mcp$"),
    re.compile(r"^@perello/"),
]

NPM_PUBLISH_RE = re.compile(r"\bnpm\s+publish\b", re.IGNORECASE)
DRY_RUN_RE = re.compile(r"(?:^|\s)--dry-run(?:$|\s)", re.IGNORECASE)
ACCESS_EXPLICIT_RE = re.compile(r"--access\s+(public|restricted)\b", re.IGNORECASE)
OVERRIDE_RE = re.compile(r"#\s*allow-other-license\s*:\s*\S+", re.IGNORECASE)


def is_fleet_package(name: str) -> bool:
    if not name:
        return False
    return any(p.search(name) for p in FLEET_NAME_PATTERNS)


def find_license_file(root: str):
    for candidate in ("LICENSE", "LICENSE.md", "LICENSE.txt"):
        path = os.path.join(root, candidate)
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            return path
    return None


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def run_hook(data: dict) -> int:
    """Return exit code (0=allow, 2=block). Pure-fn for testability."""
    try:
        if data.get("tool_name") != "Bash":
            return 0

        command = data.get("tool_input", {}).get("command", "") or ""
        if not NPM_PUBLISH_RE.search(command):
            return 0
        if DRY_RUN_RE.search(command):
            return 0

        if OVERRIDE_RE.search(command):
            sys.stderr.write(
                "[enforce-npm-publish-fleet-defaults] override # allow-other-license — allowed.\n"
            )
            return 0

        cwd = data.get("tool_input", {}).get("cwd") or os.getcwd()
        pkg_path = os.path.join(cwd, "package.json")
        if not os.path.isfile(pkg_path):
            return 0

        try:
            with open(pkg_path, "r", encoding="utf-8") as f:
                pkg = json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            sys.stderr.write(
                f"[enforce-npm-publish-fleet-defaults] WARN cannot parse {pkg_path}: {exc}. Allowing.\n"
            )
            return 0

        name = pkg.get("name", "")
        if not is_fleet_package(name):
            return 0

        failures = []

        license_str = pkg.get("license", "")
        if license_str != CANONICAL_LICENSE_STRING:
            failures.append(
                f"package.json license = {license_str!r}, expected {CANONICAL_LICENSE_STRING!r}"
            )

        license_path = find_license_file(cwd)
        if license_path is None:
            failures.append(
                "LICENSE file missing at repo root (expected LICENSE, LICENSE.md, or LICENSE.txt)"
            )
        else:
            actual_sha = sha256_file(license_path)
            if actual_sha != CANONICAL_LICENSE_SHA256:
                failures.append(
                    f"{os.path.basename(license_path)} sha256={actual_sha} != canonical {CANONICAL_LICENSE_SHA256}"
                )

        if not ACCESS_EXPLICIT_RE.search(command):
            failures.append(
                "npm publish missing explicit `--access public` or `--access restricted` "
                "(default-private surprise risk)"
            )

        if not failures:
            return 0

        sys.stderr.write(
            f"BLOCKED: fleet package {name!r} npm publish fails fleet defaults.\n\n"
        )
        for i, fail in enumerate(failures, 1):
            sys.stderr.write(f"  {i}. {fail}\n")
        sys.stderr.write(
            "\n"
            "Fleet npm publish defaults (briefing js73myh9, Day 106) :\n"
            "  - license       : \"FSL-1.1-Apache-2.0\" in package.json\n"
            "  - LICENSE file  : present at repo root, byte-exact to VP canonical\n"
            "  - --access      : explicit public or restricted (no default-private surprise)\n"
            "\n"
            "Canonical LICENSE bytes : "
            "curl -s https://raw.githubusercontent.com/vantageos-agency/vantage-peers/main/LICENSE > LICENSE\n"
            f"Expected sha256         : {CANONICAL_LICENSE_SHA256}\n"
            "\n"
            "Override (rare) : `# allow-other-license: <reason linked to fix-pattern>` "
            "on same line as npm publish. Usage unique then fix root cause.\n"
        )
        return 2

    except Exception as exc:
        sys.stderr.write(
            f"[enforce-npm-publish-fleet-defaults] WARN exception {exc}, allowing.\n"
        )
        return 0


if __name__ == "__main__" and not globals().get("_TESTING"):
    try:
        sys.exit(run_hook(json.load(sys.stdin)))
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)
