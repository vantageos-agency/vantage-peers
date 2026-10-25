"""Both-pole tests for enforce-vercel-cache-policy.py (task k17fh8wpad5pa0v9xbyftnrhs989k15g).

The Vercel CLI is replaced by a fake `vercel` executable on PATH whose
`env ls <target>` output is chosen per test, so every pole runs the hook's
real subprocess path. The fake also records the argv it received.
"""
import json
import os
import pathlib
import stat
import subprocess
import sys

import pytest

HOOK = pathlib.Path(__file__).resolve().parent.parent / "enforce-vercel-cache-policy.py"
VAR = "VERCEL_FORCE_NO_BUILD_CACHE"

LISTING_WITH = f""" name                          value               environments
 {VAR}   Encrypted           Production, Preview, Development
 NEXT_PUBLIC_URL               Encrypted           Production
"""
LISTING_WITHOUT = """ name                          value               environments
 NEXT_PUBLIC_URL               Encrypted           Production
 VERCEL_FORCE_NO_BUILD_CACHE_OLD Encrypted         Preview
"""


def make_fake(tmp_path, listing="", rc=0):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "argv.log"
    out = tmp_path / "listing.txt"
    out.write_text(listing)
    fake = bindir / "vercel"
    fake.write_text(
        "#!/bin/sh\n"
        f'echo "$@" >> "{log}"\n'
        f'/bin/cat "{out}"\n'
        f"exit {rc}\n"
    )
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    return bindir, log


def run_hook(command, path):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run(
        [sys.executable, str(HOOK)], input=payload, capture_output=True,
        text=True, timeout=30, env={**os.environ, "PATH": str(path)},
    )
    return proc.returncode, proc.stderr


def test_deploy_blocked_when_var_absent(tmp_path):
    bindir, log = make_fake(tmp_path, LISTING_WITHOUT)
    rc, err = run_hook("vercel deploy --prod", bindir)
    assert rc == 2, err
    assert "vercel env add" in err
    assert log.read_text().split() == ["env", "ls", "production"]


def test_deploy_passes_when_var_present(tmp_path):
    bindir, _ = make_fake(tmp_path, LISTING_WITH)
    rc, err = run_hook("vercel deploy --prod", bindir)
    assert rc == 0, err


def test_override_marker_passes(tmp_path):
    bindir, log = make_fake(tmp_path, LISTING_WITHOUT)
    rc, err = run_hook("vercel --prod  # // allow-vercel-cache: incident bisect in flight", bindir)
    assert rc == 0, err
    assert not log.exists(), "override must not even measure"


def test_short_override_reason_does_not_pass(tmp_path):
    bindir, _ = make_fake(tmp_path, LISTING_WITHOUT)
    rc, _ = run_hook("vercel --prod  # // allow-vercel-cache: x", bindir)
    assert rc == 2


def test_cli_absent_fails_open_loudly(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    rc, err = run_hook("vercel deploy --prod", empty)
    assert rc == 0
    assert "NOT MEASURED" in err


def test_env_ls_error_fails_open_loudly(tmp_path):
    bindir, _ = make_fake(tmp_path, "Error: not authorized", rc=1)
    rc, err = run_hook("vercel deploy", bindir)
    assert rc == 0
    assert "NOT MEASURED" in err and "exited 1" in err


@pytest.mark.parametrize("cmd", [
    f"vercel env add {VAR} production",
    "vercel env ls preview",
    "vercel ls",
    "vercel pull --yes",
    "vercel build",
    "vercel promote https://x.vercel.app",
    "echo vercel deploy",
    "grep -rn 'vercel deploy' docs/",
])
def test_non_deploy_commands_not_gated(tmp_path, cmd):
    bindir, log = make_fake(tmp_path, LISTING_WITHOUT)
    rc, err = run_hook(cmd, bindir)
    assert rc == 0, f"{cmd}: {err}"
    assert not log.exists(), f"{cmd} must not trigger a measurement"


@pytest.mark.parametrize("cmd,target", [
    ("vercel", "preview"),
    ("vercel ./apps/web", "preview"),
    ("npx vercel --prod", "production"),
    ("bunx vercel@latest deploy --target=staging", "staging"),
    ("cd apps/web && vercel redeploy https://x.vercel.app --target production", "production"),
    ("bash -c 'vercel deploy --prod'", "production"),
])
def test_deploy_forms_are_gated_on_their_target(tmp_path, cmd, target):
    bindir, log = make_fake(tmp_path, LISTING_WITHOUT)
    rc, err = run_hook(cmd, bindir)
    assert rc == 2, f"{cmd}: {err}"
    assert log.read_text().split()[:3] == ["env", "ls", target]


def test_scope_and_cwd_are_forwarded_to_the_measurement(tmp_path):
    bindir, log = make_fake(tmp_path, LISTING_WITH)
    rc, err = run_hook("vercel deploy --prod --scope elpi --cwd apps/web", bindir)
    assert rc == 0, err
    assert log.read_text().split() == ["env", "ls", "production", "--scope", "elpi", "--cwd", "apps/web"]


@pytest.mark.parametrize("cmd", [
    "vercel deploy --prod --force",
    f"vercel deploy -b {VAR}=1",
    f"vercel --prod --build-env={VAR}=1",
])
def test_deploy_that_disables_cache_itself_passes(tmp_path, cmd):
    bindir, log = make_fake(tmp_path, LISTING_WITHOUT)
    rc, err = run_hook(cmd, bindir)
    assert rc == 0, f"{cmd}: {err}"


def test_similar_variable_name_is_not_a_match(tmp_path):
    # LISTING_WITHOUT carries VERCEL_FORCE_NO_BUILD_CACHE_OLD: a substring hit would be a false pass.
    bindir, _ = make_fake(tmp_path, LISTING_WITHOUT)
    rc, _ = run_hook("vercel", bindir)
    assert rc == 2


def test_other_tools_ignored(tmp_path):
    payload = json.dumps({"tool_name": "Edit", "tool_input": {"command": "vercel --prod"}})
    proc = subprocess.run([sys.executable, str(HOOK)], input=payload,
                          capture_output=True, text=True, timeout=10)
    assert proc.returncode == 0
