#!/usr/bin/env python3
"""PreToolUse(Bash) hook: a pull request that bundles shared config with feature
code is refused while another OPEN pull request touches the same config file.

Rule: .claude/rules/parallel-pr-config-separation.md

Incidents (hook-doctrine criterion 1):
  - vantage-immo-dashboard #2 + #3: both bundled biome.json, package.json,
    pnpm-lock.yaml and vitest.config.ts with feature work; the second merge hit
    a conflict on all four files, and the rebase became a diagnosis loop.
  - vantage-peers #1579 / #1580 / #1581 (2026-10-29): three parallel PRs each
    moved the same ratchet baselines; two had to wait and rebase behind the
    first, and a merge token was issued against a head that no longer existed.

Decision, three states (never two):
  BLOCK (exit 2)      the PR diff touches a shared config file AND a feature
                      file, and another open PR in the repository touches one
                      of the same config files. The message names each PR and
                      file.
  ALLOW (exit 0)      no config file, no feature file, no overlapping open PR,
                      or the override marker is present.
  REFUSING TO JUDGE   the repository, the diff or the open-PR list could not
  (exit 2)            be read (unresolvable `cd`, no origin, --repo naming
                      another repository, gh failure). Never a silent pass.
The repository judged is the one `gh pr create` runs in: the payload cwd, or
every literal `cd <path>` / `pushd <path>` before it (`cd X && ...`,
`(cd X; ...)`); `popd`, `cd -` and a bare `cd` refuse to judge.

Override (one PR, documented): put
    # allow-config-feature-bundle: <reason, 6+ characters>
in the command, or the same line with `//` in the --body-file.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib.command_predicate import head_matches, iter_real_commands  # noqa: E402

VERSION = "1.0.0"

OVERRIDE_RE = re.compile(r"(?://|#)\s*allow-config-feature-bundle:\s*(\S.{5,})")
CONFIG_BASENAMES = {
    "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock",
    "bun.lock", "bun.lockb", "biome.json", "biome.jsonc",
}
CONFIG_PATTERNS = [
    re.compile(r"(^|/)tsconfig[^/]*\.json$"),
    re.compile(r"(^|/)vitest\.(config|workspace)\.[cm]?[jt]s$"),
    re.compile(r"^\.github/workflows/[^/]+\.ya?ml$"),
]


def is_config(path):
    return os.path.basename(path) in CONFIG_BASENAMES or any(p.search(path) for p in CONFIG_PATTERNS)


def is_feature(path):
    return not is_config(path) and not path.endswith(".md") and not path.startswith("docs/")


DIR_CHANGERS = {"cd", "pushd", "popd"}


def find_pr_create(command, base):
    """(argv of the first real `gh pr create`, the directory it runs in or None
    with a reason when a directory change before it cannot be resolved
    statically), or (None, None, None) when the command opens no pull request.
    `cd <path>` and `pushd <path>` are followed; `popd`, `cd -`, a bare `cd` or
    `pushd`, and a target built from a variable or substitution are not."""
    cur, why = base, None
    for _segment, tokens in iter_real_commands(command):
        if not tokens:
            continue
        if tokens[0] in DIR_CHANGERS:
            args = [t for t in tokens[1:] if not t.startswith("-") or t == "-"]
            target = args[0] if args and tokens[0] != "popd" else None
            if target is None or target == "-" or "$" in target or "`" in target:
                cur, why = None, f"`{' '.join(tokens)}` cannot be resolved statically"
            elif cur is not None:
                path = os.path.expanduser(target)
                cur = os.path.normpath(path if os.path.isabs(path) else os.path.join(cur, path))
            continue
        if not head_matches(tokens, "gh"):
            continue
        for i in range(1, len(tokens) - 1):
            if tokens[i] == "pr" and tokens[i + 1] == "create":
                return tokens, cur, why
    return None, None, None


def flag_value(tokens, *names):
    for i, tok in enumerate(tokens):
        for name in names:
            if tok == name and i + 1 < len(tokens):
                return tokens[i + 1]
            if name.startswith("--") and tok.startswith(name + "="):
                return tok.split("=", 1)[1]
    return None


def run(cwd, *args):
    try:
        r = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


def has_override(command, tokens, cwd):
    if OVERRIDE_RE.search(command):
        return True
    body_file = flag_value(tokens, "--body-file", "-F")
    if body_file and body_file != "-":
        path = Path(body_file) if os.path.isabs(body_file) else Path(cwd) / body_file
        try:
            return bool(OVERRIDE_RE.search(path.read_text()))
        except OSError:
            return False
    return False


def could_not_judge(reason):
    sys.stderr.write(
        f"BLOCKED by parallel-pr-config-separation: REFUSING TO JUDGE ({reason}).\n"
        "The diff or the open pull requests could not be read, so this is not a pass.\n"
        "Run the command from the repository itself (a literal `cd <path>` is read), or, when\n"
        "the bundle is known to be safe, add\n"
        "  # allow-config-feature-bundle: <reason, 6+ characters>\n"
    )
    sys.exit(2)


def main():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        sys.exit(0)
    if payload.get("tool_name") != "Bash":
        sys.exit(0)
    command = (payload.get("tool_input") or {}).get("command") or ""
    base_dir = payload.get("cwd") or os.getcwd()
    tokens, cwd, why = find_pr_create(command, base_dir)
    if tokens is None:
        sys.exit(0)
    if has_override(command, tokens, base_dir):
        sys.exit(0)
    if cwd is None:
        could_not_judge(why)

    origin = run(cwd, "git", "remote", "get-url", "origin")
    if not origin:
        could_not_judge(f"no origin remote in {cwd}")
    repo_flag = flag_value(tokens, "--repo", "-R")
    if repo_flag and repo_flag.split(":")[-1].removesuffix(".git").lower() not in origin.strip().lower():
        could_not_judge(f"--repo {repo_flag} is not the origin of {cwd}")

    base = flag_value(tokens, "--base", "-B")
    if not base:
        ref = run(cwd, "git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
        base = ref.strip().split("/", 1)[-1] if ref else "main"
    head = flag_value(tokens, "--head", "-H") or "HEAD"
    branch = head if head != "HEAD" else (run(cwd, "git", "rev-parse", "--abbrev-ref", "HEAD") or "").strip()

    merge_base = run(cwd, "git", "merge-base", f"origin/{base}", head)
    if not merge_base:
        could_not_judge(f"no merge-base between origin/{base} and {head}")
    diff = run(cwd, "git", "diff", "--name-only", merge_base.strip(), head)
    if diff is None:
        could_not_judge("git diff failed")
    files = [f for f in diff.splitlines() if f]
    config = {f for f in files if is_config(f)}
    if not config or not any(is_feature(f) for f in files):
        sys.exit(0)

    listing = run(cwd, "gh", "pr", "list", "--state", "open", "--limit", "100",
                  "--json", "number,headRefName,files")
    if listing is None:
        could_not_judge("gh pr list failed")
    try:
        open_prs = json.loads(listing)
    except ValueError:
        could_not_judge("gh pr list returned no JSON")

    overlaps = []
    for pr in open_prs:
        if pr.get("headRefName") == branch:
            continue
        shared = sorted(config & {f.get("path") for f in pr.get("files") or []})
        if shared:
            overlaps.append((pr.get("number"), shared))
    if not overlaps:
        sys.exit(0)

    lines = "\n".join(f"  - #{n} also touches: {', '.join(s)}" for n, s in overlaps)
    sys.stderr.write(
        "BLOCKED by parallel-pr-config-separation: this pull request bundles shared config "
        f"({', '.join(sorted(config))}) with feature files, and another open pull request "
        f"touches the same config:\n{lines}\n\n"
        "The second of these to merge will conflict on those files. Do one of:\n"
        "  1. Move the config change into its own pull request (config only), land it first,\n"
        "     and rebase the feature branch on it.\n"
        "  2. Wait for the pull request(s) above to merge, rebase, then open this one.\n"
        "  3. If this is deliberately the only change to that config in flight, add\n"
        "     # allow-config-feature-bundle: <reason, 6+ characters>\n"
        "     to the command (or `// allow-config-feature-bundle: ...` in the --body-file).\n"
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
