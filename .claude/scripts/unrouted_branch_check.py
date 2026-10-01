"""Report a pushed branch that carries no pull request.

The class this closes: a station pushes a finished branch and stops. A surfacing
whose scope is derived from the OPEN PULL REQUESTS never looks at a branch that
never became one, and returns clean about a delivery it did not examine.

`judge` is pure: it takes the three readings and returns a verdict. It performs no
network call and no subprocess call, so the corpus can drive it directly.

Two of the three come from the platform: `main` derives the branch list with each
ahead-count, and the open pull request heads, from tool output — no branch name and
no repository name is typed here. The third, `declared`, is a CALLER INPUT: the
station supplies it with `--declared` from its own tasks. This script does not read
the task server, so a branch deliberately held is only known to be held when the
caller says so, and every run prints what was supplied.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Branch:
    name: str
    ahead: int


@dataclass(frozen=True)
class PullRequest:
    head: str
    number: int


@dataclass(frozen=True)
class Passed:
    name: str
    reason: str


@dataclass(frozen=True)
class Verdict:
    reported: list = field(default_factory=list)
    passed: list = field(default_factory=list)
    exit_code: int = 0
    note: str = ""


def judge(branches, pulls, declared) -> Verdict:
    """Return the verdict over every branch ahead of its base.

    Three states, never two: reported, passed with a written reason, and — when the
    branch list could not be read — a refusal that is not a pass.
    """
    if branches is None:
        return Verdict(
            reported=[],
            passed=[],
            exit_code=2,
            note="could not read the branch list; this is a refusal, not a pass",
        )

    heads = {pull.head: pull.number for pull in (pulls or [])}
    declared = set(declared or ())

    reported: list = []
    passed: list = []

    for branch in branches:
        if branch.ahead == 0:
            continue
        if branch.name in heads:
            passed.append(
                Passed(
                    name=branch.name,
                    reason=f"carries open pull request #{heads[branch.name]}",
                )
            )
            continue
        if branch.name in declared:
            passed.append(
                Passed(
                    name=branch.name,
                    reason="declared in a task as not yet delivered",
                )
            )
            continue
        reported.append(branch)

    return Verdict(
        reported=reported,
        passed=passed,
        exit_code=1 if reported else 0,
        note="",
    )


def _gh(args: list) -> str:
    """Run a gh call and return its stdout, or raise with what could not be read."""
    try:
        done = subprocess.run(
            ["gh", *args],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:
        raise RuntimeError(f"could not run `gh {' '.join(args)}`: {exc}") from exc
    if done.returncode != 0:
        raise RuntimeError(
            f"could not read `gh {' '.join(args)}` "
            f"(exit {done.returncode}): {done.stderr.strip() or done.stdout.strip()}"
        )
    return done.stdout


def parse_args(argv: list):
    """Split argv into (repo, declared) or raise on a shape this cannot read.

    Pure, so the corpus drives it without a subprocess. `--declared` is repeatable
    and each occurrence may carry a comma-separated list; the declaration is a
    CALLER INPUT the station supplies from its own tasks, never derived here.
    """
    repo = None
    declared: set = set()
    rest = list(argv[1:])

    while rest:
        token = rest.pop(0)
        if token == "--declared":
            if not rest:
                raise ValueError("could not read `--declared`: it names no branch")
            value = rest.pop(0)
        elif token.startswith("--declared="):
            value = token.split("=", 1)[1]
        elif token.startswith("-"):
            raise ValueError(f"could not read the argument `{token}`")
        else:
            if repo is not None:
                raise ValueError("could not read the repository: expected exactly one owner/name")
            repo = token
            continue
        names = [name.strip() for name in value.split(",") if name.strip()]
        if not names:
            raise ValueError("could not read `--declared`: it names no branch")
        declared.update(names)

    if repo is None:
        raise ValueError("could not read the repository: expected one argument, owner/name")
    return repo, declared


def main(argv: list) -> int:
    try:
        repo, declared = parse_args(argv)
    except ValueError as exc:
        print(str(exc))
        print("usage: unrouted_branch_check.py <owner>/<name> [--declared <name>[,<name>...]]")
        return 2

    try:
        base = json.loads(_gh(["api", f"repos/{repo}", "--jq", "{d: .default_branch}"]))["d"]
        names = [
            entry["name"]
            for entry in json.loads(
                _gh(["api", "--paginate", f"repos/{repo}/branches", "--jq", "[.[] | {name}]"])
            )
        ]
        pulls = [
            PullRequest(head=entry["head"], number=entry["number"])
            for entry in json.loads(
                _gh(
                    [
                        "pr",
                        "list",
                        "--repo",
                        repo,
                        "--state",
                        "open",
                        "--limit",
                        "200",
                        "--json",
                        "number,headRefName",
                        "--jq",
                        "[.[] | {head: .headRefName, number}]",
                    ]
                )
            )
        ]
        branches = []
        for name in names:
            if name == base:
                continue
            ahead = json.loads(
                _gh(
                    [
                        "api",
                        f"repos/{repo}/compare/{base}...{name}",
                        "--jq",
                        "{a: .ahead_by}",
                    ]
                )
            )["a"]
            branches.append(Branch(name=name, ahead=ahead))
    except (RuntimeError, ValueError, KeyError) as exc:
        print(f"could not read {repo}: {exc}")
        return 2

    verdict = judge(branches=branches, pulls=pulls, declared=declared)

    print(f"repository: {repo}")
    print(f"base branch: {base}")
    print(f"branches read: {len(names)}")
    print(
        "declared branches supplied: "
        + (", ".join(sorted(declared)) if declared else "none")
    )
    if verdict.note:
        print(f"note: {verdict.note}")
    for branch in verdict.reported:
        print(f"UNROUTED  {branch.name} — {branch.ahead} commit(s) ahead, no pull request")
    for entry in verdict.passed:
        print(f"passed    {entry.name} — {entry.reason}")
    print(f"reported: {len(verdict.reported)}  passed: {len(verdict.passed)}")
    return verdict.exit_code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
