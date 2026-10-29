"""Poles for enforce-parallel-pr-config-separation.py.

Each case builds a real git repository with an `origin` remote, a feature
branch, and a stub `gh` on PATH that answers `gh pr list` from a JSON file.
The hook is run as a subprocess exactly as the harness runs it.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HOOK = Path(__file__).resolve().parents[1] / "enforce-parallel-pr-config-separation.py"


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


def _write(root, rel, text="x\n"):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


@pytest.fixture
def repo(tmp_path):
    origin = tmp_path / "origin.git"
    work = tmp_path / "work"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    work.mkdir()
    _git(work, "init", "-q", "-b", "main")
    _git(work, "remote", "add", "origin", str(origin))
    _write(work, "package.json", '{"name":"a"}\n')
    _write(work, "src/app.ts", "export const a = 1;\n")
    _git(work, "add", "-A")
    _git(work, "commit", "-q", "-m", "init")
    _git(work, "push", "-q", "-u", "origin", "main")
    _git(work, "remote", "set-head", "origin", "main")
    _git(work, "checkout", "-q", "-b", "feat/x")
    return work


def _stub_gh(tmp_path, prs=None, fail=False):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    data = tmp_path / "prs.json"
    data.write_text(json.dumps(prs or []))
    script = bindir / "gh"
    if fail:
        script.write_text("#!/bin/sh\necho 'network down' >&2\nexit 1\n")
    else:
        script.write_text(f"#!/bin/sh\ncat '{data}'\n")
    script.chmod(0o755)
    return bindir


def _run(cwd, command, bindir, payload_cwd=None):
    payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": str(payload_cwd or cwd)}
    env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}"}
    return subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload),
                          capture_output=True, text=True, cwd=cwd, env=env)


def _commit(work, *files):
    for f in files:
        _write(work, f, f"changed {f}\n")
    _git(work, "add", "-A")
    _git(work, "commit", "-q", "-m", "change")


OTHER_PR_TOUCHING_PACKAGE = [
    {"number": 41, "headRefName": "feat/other", "files": [{"path": "package.json"}, {"path": "src/b.ts"}]},
]


# --- the violation poles first: these must block ---------------------------

def test_bundle_with_overlapping_open_pr_blocks(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    r = _run(repo, "gh pr create --title t --body b", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 2, r.stderr
    assert "#41" in r.stderr and "package.json" in r.stderr
    assert "allow-config-feature-bundle" in r.stderr


def test_wrapped_invocation_blocks(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    r = _run(repo, "bash -c 'gh pr create --fill'", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 2, r.stderr
    assert "BLOCKED" in r.stderr and "#41" in r.stderr


def test_lockfile_and_workflow_count_as_config(repo, tmp_path):
    _commit(repo, "pnpm-lock.yaml", ".github/workflows/ci.yml", "src/app.ts")
    prs = [{"number": 7, "headRefName": "feat/y", "files": [{"path": ".github/workflows/ci.yml"}]}]
    r = _run(repo, "gh pr create --fill", _stub_gh(tmp_path, prs))
    assert r.returncode == 2, r.stderr
    assert "#7" in r.stderr and ".github/workflows/ci.yml" in r.stderr


# --- the poles that must pass -----------------------------------------------

def test_bundle_without_overlapping_pr_passes(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    prs = [{"number": 9, "headRefName": "feat/z", "files": [{"path": "src/c.ts"}]}]
    r = _run(repo, "gh pr create --fill", _stub_gh(tmp_path, prs))
    assert r.returncode == 0, r.stderr


def test_config_only_pr_passes_even_with_overlap(repo, tmp_path):
    _commit(repo, "package.json")
    r = _run(repo, "gh pr create --fill", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 0, r.stderr


def test_feature_only_pr_passes(repo, tmp_path):
    _commit(repo, "src/app.ts")
    r = _run(repo, "gh pr create --fill", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 0, r.stderr


def test_markdown_is_not_a_feature_file(repo, tmp_path):
    _commit(repo, "package.json", "CHANGELOG.md", "docs/guide.md")
    r = _run(repo, "gh pr create --fill", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 0, r.stderr


def test_own_branch_in_open_list_is_ignored(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    prs = [{"number": 50, "headRefName": "feat/x", "files": [{"path": "package.json"}]}]
    r = _run(repo, "gh pr create --fill", _stub_gh(tmp_path, prs))
    assert r.returncode == 0, r.stderr


def test_override_in_command_passes(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    cmd = "gh pr create --fill  # allow-config-feature-bundle: sole PR touching deps this week"
    r = _run(repo, cmd, _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 0, r.stderr


def test_override_in_body_file_passes(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    body = tmp_path / "body.md"
    body.write_text("Summary\n\n// allow-config-feature-bundle: #41 lands after this one\n")
    r = _run(repo, f"gh pr create --title t --body-file {body}", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 0, r.stderr


def test_short_override_reason_does_not_pass(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    cmd = "gh pr create --fill  # allow-config-feature-bundle: ok"
    r = _run(repo, cmd, _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 2, r.stderr
    assert "BLOCKED" in r.stderr and "#41" in r.stderr


def test_quoted_mention_is_not_an_invocation(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    r = _run(repo, "echo 'gh pr create'", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 0, r.stderr


def test_gh_failure_refuses_to_judge(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    r = _run(repo, "gh pr create --fill", _stub_gh(tmp_path, fail=True))
    assert r.returncode == 2
    assert "REFUSING TO JUDGE" in r.stderr and "allow-config-feature-bundle" in r.stderr


# --- the station form: the repository is reached by a cd, not by the payload cwd ---

def _elsewhere(tmp_path):
    other = tmp_path / "workspace"
    other.mkdir()
    _git(other, "init", "-q", "-b", "main")
    return other


def test_cd_then_create_judges_the_cd_target(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    r = _run(repo, f"cd {repo} && gh pr create --fill", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE),
             payload_cwd=_elsewhere(tmp_path))
    assert r.returncode == 2, r.stderr
    assert "BLOCKED" in r.stderr and "#41" in r.stderr


def test_subshell_cd_then_create_judges_the_cd_target(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    r = _run(repo, f"(cd {repo}; gh pr create --fill)", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE),
             payload_cwd=_elsewhere(tmp_path))
    assert r.returncode == 2, r.stderr
    assert "BLOCKED" in r.stderr and "#41" in r.stderr


def test_unresolvable_cd_refuses_to_judge(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    r = _run(repo, "cd $REPO_DIR && gh pr create --fill", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 2
    assert "REFUSING TO JUDGE" in r.stderr


def test_missing_origin_refuses_to_judge(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    _git(repo, "remote", "remove", "origin")
    r = _run(repo, "gh pr create --fill", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 2
    assert "REFUSING TO JUDGE" in r.stderr


def test_repo_flag_naming_another_repository_refuses_to_judge(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    r = _run(repo, "gh pr create -R someone/elsewhere --fill", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 2
    assert "REFUSING TO JUDGE" in r.stderr


def test_nested_tsconfig_variant_is_config(repo, tmp_path):
    _commit(repo, "apps/web/tsconfig.app.json", "src/app.ts")
    prs = [{"number": 12, "headRefName": "feat/w", "files": [{"path": "apps/web/tsconfig.app.json"}]}]
    r = _run(repo, "gh pr create --fill", _stub_gh(tmp_path, prs))
    assert r.returncode == 2, r.stderr
    assert "#12" in r.stderr


def test_pushd_then_create_judges_the_pushd_target(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    ws = _elsewhere(tmp_path)
    r = _run(repo, f"pushd {repo} && gh pr create --fill", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE),
             payload_cwd=ws)
    assert r.returncode == 2, r.stderr
    assert "BLOCKED" in r.stderr and "#41" in r.stderr


def test_relative_cd_chain_is_followed(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    r = _run(repo, f"cd {repo.parent} && cd {repo.name} && gh pr create --fill",
             _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE), payload_cwd=_elsewhere(tmp_path))
    assert r.returncode == 2, r.stderr
    assert "#41" in r.stderr


def test_popd_refuses_to_judge(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    r = _run(repo, f"pushd {repo} && popd && gh pr create --fill", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 2
    assert "REFUSING TO JUDGE" in r.stderr


def test_cd_dash_refuses_to_judge(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    r = _run(repo, "cd - && gh pr create --fill", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 2
    assert "REFUSING TO JUDGE" in r.stderr


def test_bare_cd_refuses_to_judge(repo, tmp_path):
    _commit(repo, "package.json", "src/app.ts")
    r = _run(repo, "cd && gh pr create --fill", _stub_gh(tmp_path, OTHER_PR_TOUCHING_PACKAGE))
    assert r.returncode == 2
    assert "REFUSING TO JUDGE" in r.stderr
