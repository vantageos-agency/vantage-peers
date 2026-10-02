#!/usr/bin/env python3
"""Bipolar corpus for block-deploy-without-qa.

Class of failure closed here: the guard's substring prefilter, used when a shell
segment cannot be tokenised, asked whether the RAW TEXT carries both `convex` and
`deploy`. The name of the credential a READ also needs -- CONVEX_DEPLOY_KEY --
carries both words, so exporting it inside an untokenisable segment escalated to
BLOCK and refused `npx convex data`, which reads one table and publishes nothing.

The prefilter now erases SCREAMING_SNAKE identifiers before the test, because a
variable name is never a command. The MUST_BLOCK pole proves the erasure did not
open a hole: an invocation survives it, since `npx convex deploy` is lowercase.

Run: python3 .claude/hooks/test_block_deploy_without_qa.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "block-deploy-without-qa.py")

MUST_BLOCK = [
    ("bare production deploy",
     "npx convex " + "deploy --yes"),
    ("deploy with the credential as an inline prefix",
     "CONVEX_DEPLOY_KEY=x npx convex " + "deploy --yes"),
    ("untokenisable export followed by a real deploy",
     'export CONVEX_DEPLOY_KEY="$(grep k .env)" && npx convex ' + "deploy --yes"),
    ("pinned version, which breaks token adjacency",
     "npx convex@latest " + "deploy --yes"),
]

MUST_PASS = [
    ("the production READ this guard refused",
     'export CONVEX_DEPLOY_KEY="$(grep -m1 ^CONVEX_DEPLOY_KEY_PROD_VP= .env.local'
     ' | cut -d= -f2-)" && npx convex data client_org_mapping --limit 10'),
    ("a plain read with no credential in the line",
     "npx convex data tasks --limit 1"),
    ("a dry run publishes nothing",
     "npx convex " + "deploy --dry-run"),
    ("the help text",
     "npx convex " + "deploy --help"),
    ("the development watcher",
     "npx convex dev --once"),
    ("naming the credential without invoking anything",
     'echo "$CONVEX_DEPLOY_KEY_PROD_VP" | wc -c'),
]


def run(command: str) -> int:
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run([sys.executable, HOOK], input=payload,
                          capture_output=True, text=True)
    return proc.returncode


def main() -> int:
    holes, false_positives = [], []
    for label, cmd in MUST_BLOCK:
        rc = run(cmd)
        if rc == 0:
            holes.append(label)
        print("%-7s MUST_BLOCK  %s" % ("HOLE" if rc == 0 else "ok", label))
    for label, cmd in MUST_PASS:
        rc = run(cmd)
        if rc != 0:
            false_positives.append(label)
        print("%-7s MUST_PASS   %s" % ("FALSE+" if rc != 0 else "ok", label))
    print("\nholes: %d / %d   false positives: %d / %d"
          % (len(holes), len(MUST_BLOCK), len(false_positives), len(MUST_PASS)))
    for l in holes:
        print("  HOLE   " + l)
    for l in false_positives:
        print("  FALSE+ " + l)
    return 1 if (holes or false_positives) else 0


# ---------------------------------------------------------------------------
# pytest cases: the deploy runs in the tree the COMMAND names, and a deploy is
# production unless it names a development deploy key.
#
# The hook is exercised for real, as a subprocess fed JSON on stdin. Only the
# two fixed /tmp locations it reads (QA breadcrumb, proof file template) are
# redirected into a per-test directory, so a test never touches -- or leaves
# behind -- the live breadcrumb a real production deploy would be judged on.
# ---------------------------------------------------------------------------

import time  # noqa: E402

_DRIVER = """
import importlib.util, sys
spec = importlib.util.spec_from_file_location("deploy_guard_under_test", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.BREADCRUMB = sys.argv[2]
mod.DEV_ACTIVATION_PATH_TEMPLATE = sys.argv[3] + "/proof-{sha}.json"
sys.exit(mod.main())
"""


def _run_hook(command, cwd, workdir, fresh_qa=True):
    breadcrumb = os.path.join(str(workdir), "qa-passed")
    proofs = os.path.join(str(workdir), "proofs")
    os.makedirs(proofs, exist_ok=True)
    if fresh_qa:
        with open(breadcrumb, "w") as fh:
            fh.write("ok")
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run(
        [sys.executable, "-c", _DRIVER, HOOK, breadcrumb, proofs],
        input=payload, capture_output=True, text=True, cwd=str(cwd),
    )
    return proc.returncode, proc.stderr


def _make_repo(path):
    os.makedirs(str(path), exist_ok=True)
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    subprocess.run(["git", "init", "-q"], cwd=str(path), check=True, env=env)
    subprocess.run(["git", "commit", "-q", "--allow-empty", "-m", "init " + str(path)],
                   cwd=str(path), check=True, env=env)
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(path), check=True,
                         capture_output=True, text=True).stdout.strip()
    return sha


def _write_proof(workdir, sha):
    proofs = os.path.join(str(workdir), "proofs")
    os.makedirs(proofs, exist_ok=True)
    with open(os.path.join(proofs, "proof-%s.json" % sha), "w") as fh:
        json.dump({"commit": sha, "deployment": "dev:x-1",
                   "read_back": "tasks table: 3 rows", "at": time.time()}, fh)


DEPLOY = "npx convex " + "deploy --yes"


def test_cd_target_tree_is_the_one_judged(tmp_path):
    repo_a, repo_b = tmp_path / "A", tmp_path / "B"
    _make_repo(repo_a)
    sha_b = _make_repo(repo_b)
    _write_proof(tmp_path, sha_b)
    rc, err = _run_hook("cd %s && %s" % (repo_b, DEPLOY), repo_a, tmp_path)
    assert rc == 0, err


def test_proof_for_process_cwd_only_is_refused_naming_target_sha(tmp_path):
    repo_a, repo_b = tmp_path / "A", tmp_path / "B"
    sha_a = _make_repo(repo_a)
    sha_b = _make_repo(repo_b)
    _write_proof(tmp_path, sha_a)
    rc, err = _run_hook("cd %s && %s" % (repo_b, DEPLOY), repo_a, tmp_path)
    assert rc == 2
    assert sha_b in err


def test_relative_and_quoted_cd_are_resolved(tmp_path):
    repo_a, repo_b = tmp_path / "A", tmp_path / "B dir"
    _make_repo(repo_a)
    sha_b = _make_repo(repo_b)
    _write_proof(tmp_path, sha_b)
    rc, err = _run_hook('cd "../B dir" && %s' % DEPLOY, repo_a, tmp_path)
    assert rc == 0, err


def test_last_cd_wins(tmp_path):
    repo_a, repo_b = tmp_path / "A", tmp_path / "B"
    sha_a = _make_repo(repo_a)
    _make_repo(repo_b)
    _write_proof(tmp_path, sha_a)
    rc, err = _run_hook("cd %s && cd %s && %s" % (repo_b, repo_a, DEPLOY),
                        repo_b, tmp_path)
    assert rc == 0, err


def test_nonexistent_cd_target_is_refused_loud(tmp_path):
    repo_a = tmp_path / "A"
    sha_a = _make_repo(repo_a)
    _write_proof(tmp_path, sha_a)
    rc, err = _run_hook("cd /nonexistent && " + DEPLOY, repo_a, tmp_path)
    assert rc == 2
    assert "/nonexistent" in err


def test_dev_key_by_name_is_not_production(tmp_path):
    repo_a = tmp_path / "A"
    _make_repo(repo_a)
    cmd = 'CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY_DEV_X" ' + DEPLOY
    rc, err = _run_hook(cmd, repo_a, tmp_path, fresh_qa=False)
    assert rc == 0, err


def test_dev_key_by_literal_value_is_not_production(tmp_path):
    repo_a = tmp_path / "A"
    _make_repo(repo_a)
    rc, err = _run_hook('"CONVEX_DEPLOY_KEY=dev:abc|tok" ' + DEPLOY, repo_a,
                        tmp_path, fresh_qa=False)
    assert rc == 0, err


def test_prod_key_by_name_is_production(tmp_path):
    repo_a = tmp_path / "A"
    _make_repo(repo_a)
    cmd = 'CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY_PROD_X" ' + DEPLOY
    rc, err = _run_hook(cmd, repo_a, tmp_path, fresh_qa=False)
    assert rc == 2


def test_bare_deploy_is_production(tmp_path):
    repo_a = tmp_path / "A"
    _make_repo(repo_a)
    rc, err = _run_hook(DEPLOY, repo_a, tmp_path, fresh_qa=False)
    assert rc == 2


def test_dev_key_does_not_leak_across_a_later_prod_key(tmp_path):
    repo_a = tmp_path / "A"
    _make_repo(repo_a)
    cmd = ('export CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY_DEV_X" && '
           'CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY_PROD_X" ' + DEPLOY)
    rc, err = _run_hook(cmd, repo_a, tmp_path, fresh_qa=False)
    assert rc == 2


# Dev-key scoping. An inline prefix applies to its own command only; a key
# carries to later segments only through `export` or a bare assignment. The
# variable name is matched by whole `_`-separated segment, never by substring.
_D = "npx convex " + "deploy --yes"
KEY_MUST_BLOCK = [
    ("inline dev key does not carry to a second deploy",
     "CONVEX_DEPLOY_KEY=dev:abc " + _D + " && " + _D),
    ("DEV as a substring of DEVOPS is not a dev key",
     "CONVEX_DEPLOY_KEY=$CONVEX_DEPLOY_KEY_PROD_DEVOPS " + _D),
    ("a different variable named *_DEV is not the deploy key",
     "CONVEX_DEPLOY_KEY_DEV=dev:abc " + _D),
    ("an inline prod key overrides an exported dev key",
     "export CONVEX_DEPLOY_KEY=dev:abc && CONVEX_DEPLOY_KEY=prod:xyz " + _D),
    ("a name carrying both PROD and DEV segments stays production",
     "CONVEX_DEPLOY_KEY=$CONVEX_DEPLOY_KEY_PROD_DEV_X " + _D),
    ("bare assignment then deploy: the shell does not hand it to the next command",
     "CONVEX_DEPLOY_KEY=dev:abc; " + _D),
    ("export then unset before the deploy",
     "export CONVEX_DEPLOY_KEY=dev:abc; unset CONVEX_DEPLOY_KEY; " + _D),
    ("export inside a subshell does not survive it",
     "(export CONVEX_DEPLOY_KEY=dev:abc); " + _D),
    ("export then env -u removes it for the deploy",
     "export CONVEX_DEPLOY_KEY=dev:abc; env -u CONVEX_DEPLOY_KEY " + _D),
    ("DEVICE is not DEV",
     "CONVEX_DEPLOY_KEY=$CONVEX_DEPLOY_KEY_DEVICE " + _D),
]
KEY_MUST_PASS = [
    ("literal dev key, own prefix",
     "CONVEX_DEPLOY_KEY=dev:abc " + _D),
    ("DEV in the middle of a real fleet name",
     'CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY_DEV_VANTAGE_IMMO" ' + _D),
    ("dev key through env on the deploy segment itself",
     "env CONVEX_DEPLOY_KEY=dev:abc " + _D),
    ("the development push that needs no deploy key",
     "npx convex dev --once"),
]
MUST_BLOCK += KEY_MUST_BLOCK
MUST_PASS += KEY_MUST_PASS


import pytest  # noqa: E402


@pytest.mark.parametrize("label,cmd", KEY_MUST_BLOCK, ids=[c[0] for c in KEY_MUST_BLOCK])
def test_key_scoping_must_block(tmp_path, label, cmd):
    repo = tmp_path / "A"
    _make_repo(repo)
    rc, err = _run_hook(cmd, repo, tmp_path, fresh_qa=False)
    assert rc == 2, label


@pytest.mark.parametrize("label,cmd", KEY_MUST_PASS, ids=[c[0] for c in KEY_MUST_PASS])
def test_key_scoping_must_pass(tmp_path, label, cmd):
    repo = tmp_path / "A"
    _make_repo(repo)
    rc, err = _run_hook(cmd, repo, tmp_path, fresh_qa=False)
    assert rc == 0, err


if __name__ == "__main__":
    sys.exit(main())
