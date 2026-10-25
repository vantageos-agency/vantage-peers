#!/usr/bin/env python3
"""
PreToolUse hook (Bash): enforce-vercel-cache-policy v1.1.0

Rule: `vercel-build-cache-policy` v1.0.0 (VR contentHash c4aa6a1d...). Every
fleet Vercel project sets VERCEL_FORCE_NO_BUILD_CACHE=1 on Production, Preview
and Development, because a poisoned build cache crashes a clean source tree
with stale dependency-chunk TypeErrors (vantage-peers-dashboard preview,
builds 69e3e47 and 2760c4b, Clerk `.length`).

WHAT IS GATED
-------------
A Bash call whose real command (after the shared tokenizer in
`_lib/command_predicate.py` strips sudo/env/npx/bunx/... and recurses into
`bash -c "..."`) is a Vercel DEPLOYMENT, under either name of the CLI --
`vercel` or `vc` (`npm view vercel bin` -> both point at the same dist/vc.js):
  - `vercel` with no subcommand, or with a positional path (`vercel ./app`)
  - `vercel deploy ...`
  - `vercel redeploy ...` (rebuilds)
Target environment: `--prod` -> production, `--target X` / `--target=X` -> X,
otherwise preview.

Every other subcommand (`vercel env ...`, `vercel ls`, `vercel pull`,
`vercel build`, `vercel promote`, ...) passes untouched: `vercel env add` is
precisely how a project is brought into compliance.

HOW THE PROJECT IS MEASURED
---------------------------
The rule requires the variable on EVERY scope, not only the one being
deployed: a production deploy of a project whose Preview lacks it is still a
non-compliant project. So `vercel env ls <scope>` is run for production,
preview and development (plus the deploy's own target when it is a custom
environment), each with the deploy's own `--cwd`, `--scope` and `--token`,
and each output is searched for the variable NAME. Any scope ABSENT blocks,
naming the missing scopes. The CLI
lists values encrypted, so the hook proves the variable is SET on that
target, not that its value is `1`. That limit is stated, not hidden.

A deploy also passes when it disables the cache for itself:
  - `--force` / `-f` (Vercel: force a new deployment, skipping the build cache)
  - `-b VERCEL_FORCE_NO_BUILD_CACHE=1` / `--build-env VERCEL_FORCE_NO_BUILD_CACHE=1`

FAIL-OPEN, LOUDLY
-----------------
When the measurement cannot be taken -- the CLI absent from PATH, `env ls`
erroring or timing out, a segment the tokenizer cannot split -- the hook lets
the call through and says the project was NOT measured. It never prints that
as a pass. The could-not-judge is emitted as JSON on stdout (exit 0):
`systemMessage` for the operator and `hookSpecificOutput.additionalContext`
for the model, because stderr on exit 0 reaches neither -- a fail-open that
nobody reads is a mute one. It is repeated on stderr for the transcript.

Override (one-shot): `// allow-vercel-cache: <reason of 6+ chars>` in the
command.

Exit codes: 0 allow, 2 block.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib.command_predicate import head_matches, iter_real_commands  # noqa: E402

VAR = "VERCEL_FORCE_NO_BUILD_CACHE"
CLI_NAMES = ("vercel", "vc")
# Rule vercel-build-cache-policy: the variable is required on all three.
REQUIRED_SCOPES = ("production", "preview", "development")
ENV_LS_TIMEOUT_SEC = 20

OVERRIDE_RE = re.compile(r"//\s*allow-vercel-cache\s*:\s*\S.{5,}", re.IGNORECASE)

# Subcommands of the Vercel CLI that do NOT create a build. A first positional
# token outside this set (and outside DEPLOY_SUBCOMMANDS) is a project path,
# which `vercel <path>` deploys.
NON_DEPLOY_SUBCOMMANDS = {
    "alias", "aliases", "api", "bisect", "blob", "build", "cache", "cert",
    "certs", "dev", "develop", "dns", "domain", "domains", "env", "git",
    "help", "init", "inspect", "install", "integration", "integrations",
    "link", "list", "login", "logout", "logs", "ls", "mcp", "microfrontends",
    "open", "project", "projects", "promote", "pull", "remove", "rm",
    "rollback", "switch", "target", "targets", "team", "teams", "telemetry",
    "upgrade", "whoami",
}
DEPLOY_SUBCOMMANDS = {"deploy", "redeploy"}

# Global/deploy flags that consume the next token as their value.
VALUE_FLAGS = {
    "--cwd", "--scope", "-S", "--token", "-t", "--target", "-A",
    "--local-config", "-Q", "--global-config", "-b", "--build-env", "-e",
    "--env", "-m", "--meta", "--regions", "--archive", "--team", "-T",
}
FORWARDED_FLAGS = {"--cwd", "--scope", "-S", "--token", "-t", "--team", "-T"}


def _parse(tokens):
    """Return (is_deploy, target, forwarded_args, self_disables_cache)."""
    args = tokens[1:]
    positional = []
    target = "preview"
    forwarded = []
    self_disabled = False
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            positional.extend(args[i + 1:])
            break
        if tok.startswith("-"):
            name, eq, inline = tok.partition("=")
            value = inline if eq else None
            if name in VALUE_FLAGS and not eq:
                value = args[i + 1] if i + 1 < len(args) else ""
                i += 1
            if name in ("--prod", "--production"):
                target = "production"
            elif name == "--target" and value:
                target = value
            elif name in ("--force", "-f"):
                self_disabled = True
            elif name in ("-b", "--build-env") and value and re.match(
                rf"^{VAR}=(1|true)$", value, re.IGNORECASE
            ):
                self_disabled = True
            if name in FORWARDED_FLAGS and value is not None:
                forwarded.extend([name, value])
        else:
            positional.append(tok)
        i += 1

    if not positional:
        is_deploy = True
    else:
        head = positional[0]
        if head in DEPLOY_SUBCOMMANDS:
            is_deploy = True
        elif head in NON_DEPLOY_SUBCOMMANDS:
            is_deploy = False
        else:
            is_deploy = True  # `vercel <path>`
    return is_deploy, target, forwarded, self_disabled


def _measure(target, forwarded):
    """Return (state, detail): state in {"set", "absent", "unmeasured"}."""
    binary = next((b for b in map(shutil.which, CLI_NAMES) if b), None)
    if not binary:
        return "unmeasured", "the vercel CLI (vercel / vc) is not on PATH"
    cmd = [binary, "env", "ls", target, *forwarded]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=ENV_LS_TIMEOUT_SEC,
            env={**os.environ, "NO_COLOR": "1"},
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return "unmeasured", f"`vercel env ls {target}` did not complete ({exc.__class__.__name__})"
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or [""]
        return "unmeasured", f"`vercel env ls {target}` exited {proc.returncode}: {tail[0][:200]}"
    if re.search(rf"(?<![A-Z0-9_]){VAR}(?![A-Z0-9_])", proc.stdout):
        return "set", ""
    return "absent", ""


ADVISORIES = []


def _advisory(msg):
    line = f"[enforce-vercel-cache-policy] NOT MEASURED, allowed: {msg}"
    ADVISORIES.append(line)
    print(line, file=sys.stderr)


def _emit_advisories():
    """Surface every could-not-judge to the operator AND the model (exit 0)."""
    if not ADVISORIES:
        return
    text = "\n".join(ADVISORIES) + (
        f"\n{VAR} was NOT verified for this deploy; this is not a pass. "
        "Check it with `vercel env ls <scope>` before relying on the build."
    )
    print(json.dumps({
        "systemMessage": text,
        "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": text},
    }))


def _scopes_for(target):
    scopes = [target] + [s for s in REQUIRED_SCOPES if s != target]
    return scopes


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if payload.get("tool_name") != "Bash":
        return 0
    command = (payload.get("tool_input") or {}).get("command") or ""
    if not re.search(r"\b(?:vercel|vc)\b", command):
        return 0
    if OVERRIDE_RE.search(command):
        return 0

    for segment, tokens in iter_real_commands(command):
        if tokens is None:
            if re.search(r"(?<![\w.$-])(?:vercel|vc)(?![\w.=-])", segment):
                _advisory(f"segment could not be tokenized: {segment[:120]!r}")
            continue
        if not any(head_matches(tokens, n) for n in CLI_NAMES):
            continue
        is_deploy, target, forwarded, self_disabled = _parse(tokens)
        if not is_deploy or self_disabled:
            continue
        absent = []
        for scope in _scopes_for(target):
            state, detail = _measure(scope, forwarded)
            if state == "absent":
                absent.append(scope)
            elif state == "unmeasured":
                _advisory(f"{detail}; {VAR} on scope '{scope}' was not checked")
        if not absent:
            continue
        print(
            "BLOCKED: rule vercel-build-cache-policy v1.0.0.\n"
            f"{VAR} is missing on scope(s): {', '.join(absent)} "
            f"(deploy target: {target}). The rule requires it on every scope.\n"
            "A cached build can crash a clean source tree with stale chunk errors.\n\n"
            "FIX (the hook does not gate `vercel env`):\n"
            f"  vercel env add {VAR} production   # value: 1\n"
            f"  vercel env add {VAR} preview      # value: 1\n"
            f"  vercel env add {VAR} development  # value: 1\n"
            "or disable the cache for this one deploy: `--force`, or\n"
            f"`--build-env {VAR}=1`.\n\n"
            "Override (one-shot): `// allow-vercel-cache: <reason, 6+ chars>`.",
            file=sys.stderr,
        )
        return 2
    _emit_advisories()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # fail-open on internal error, loudly
        _advisory(f"internal error {exc.__class__.__name__}: {exc}")
        _emit_advisories()
        sys.exit(0)
