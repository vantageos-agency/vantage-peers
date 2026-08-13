#!/usr/bin/env python3
"""Unit-level probe for enforce-eta-approval-before-npm-publish.py's
validate_pr_approval() / validate_task() -- the functions the age-gate lived
in. Tested in ISOLATION from main()'s downstream SHA/tree check (validate_commit_sha),
because that downstream check is what already masks validate_pr_approval()'s own
wrong-acceptance hole on the LIVE full-process path -- see
qa/probes/DIVERGENCE-guard2-eta-approval.md for why the full-process probe
(probe_instance2.sh must_block) does not redden pre-fix.

Portable: takes the hook module path as argv[1] (repo-relative, resolved by
the caller via `git rev-parse --show-toplevel`), no station/scratchpad path
is embedded here.

Usage: python3 probe_instance2_unit.py <module_path> <case>
  case in {must_block, must_pass, must_refuse_missing_ts, forbidden}
"""
import importlib.util
import json
import sys
from datetime import datetime, timedelta, timezone


def load_module(path):
    spec = importlib.util.spec_from_file_location("hookmod", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    path, case = sys.argv[1], sys.argv[2]
    mod = load_module(path)
    now = datetime.now(timezone.utc)

    OTHER_SHA = "e101622b09b8ba77a01c7744854d38f2cca59854"
    HEAD_SHA = "436362f0046ca41dedc3036f71ecef7e5d611ecb"

    if case == "must_block":
        # A qualifying comment approves OTHER_SHA, posted 2 minutes ago (well
        # within the old 60-min age window). validate_pr_approval() must not
        # silently say "ok" for evidence that pins a DIFFERENT commit than
        # what main() will actually ship (HEAD_SHA) -- naming both SHAs is
        # main()'s job downstream (steps 2/3); validate_pr_approval()'s OWN
        # contract per the spec is to stop treating "recent" as "sufficient".
        mock = json.dumps([{
            "body": f"Eta APPROVED. ETA_APPROVED_COMMIT_SHA: {OTHER_SHA}",
            "user": {"login": "elpiarthera"},
            "created_at": iso(now - timedelta(minutes=2)),
        }])
        ok, reason, bound_sha = mod.validate_pr_approval("999", mock, operator_sha=OTHER_SHA)
        print(f"validate_pr_approval -> ok={ok} reason={reason!r} bound_sha={bound_sha}")
        print(
            "CLAIM CHECK: today's function returns ok=True regardless of whether "
            f"bound_sha ({bound_sha}) matches the commit actually being shipped "
            f"({HEAD_SHA}) -- it has NO OPINION on that at all, it only checked age "
            "pre-fix / SHA-presence post-fix."
        )
        sys.exit(0 if ok else 1)

    if case == "must_pass":
        mock = json.dumps([{
            "body": f"Eta APPROVED. ETA_APPROVED_COMMIT_SHA: {HEAD_SHA}",
            "user": {"login": "elpiarthera"},
            "created_at": iso(now - timedelta(hours=2)),
        }])
        ok, reason, bound_sha = mod.validate_pr_approval("999", mock, operator_sha=HEAD_SHA)
        print(f"validate_pr_approval -> ok={ok} reason={reason!r} bound_sha={bound_sha}")
        sys.exit(0 if ok else 1)

    if case == "must_refuse_missing_ts":
        # validate_task(): timestamp missing entirely -- instrument cannot be
        # read at all. Must be a NAMED exit, not conflated with "task is not
        # an Eta approval".
        task = {"title": "[ETA-APPROVED] release", "assignedTo": "eta"}
        ok, reason = mod.validate_task("k174v3sw1x1z3dp6ge2k4d1qgh8842vx", json.dumps(task))
        print(f"validate_task -> ok={ok} reason={reason!r}")
        sys.exit(0 if ok else 1)

    if case == "forbidden":
        # A comment with the word APPROVED and lots of reassuring prose, but
        # NO SHA binding at all (no ETA_APPROVED_COMMIT_SHA line, operator_sha
        # not present literally). Must NOT qualify.
        mock = json.dumps([{
            "body": "Eta APPROVED, docs: all green, 311/314, merged, tests pass, ship it",
            "user": {"login": "elpiarthera"},
            "created_at": iso(now - timedelta(minutes=1)),
        }])
        ok, reason, bound_sha = mod.validate_pr_approval("999", mock, operator_sha=OTHER_SHA)
        print(f"validate_pr_approval -> ok={ok} reason={reason!r} bound_sha={bound_sha!r}")
        sys.exit(0 if ok else 1)

    print(f"unknown case {case}")
    sys.exit(3)


if __name__ == "__main__":
    main()
