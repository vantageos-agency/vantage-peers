"""Both-pole tests for enforce-vercel-cache-policy.py (task k17fh8wpad5pa0v9xbyftnrhs989k15g).

The Vercel CLI is replaced by a fake `vercel` executable on PATH whose
`env ls <scope>` output is chosen per test (and per scope when needed), so
every pole runs the hook's real subprocess path. The fake also records one
argv line per call. v1.1.0 (REVISE on #1561): `vc` is the same CLI, every one
of the three scopes is measured, and a could-not-judge reaches the model.
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


SCOPES = ["production", "preview", "development"]


def make_fake(tmp_path, listing="", rc=0, per_scope=None, name="vercel"):
    """`per_scope` maps a scope to its own listing; others get `listing`."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "argv.log"
    (tmp_path / "listing.txt").write_text(listing)
    for scope, text in (per_scope or {}).items():
        (tmp_path / f"listing-{scope}.txt").write_text(text)
    fake = bindir / name
    fake.write_text(
        "#!/bin/sh\n"
        f'echo "$@" >> "{log}"\n'
        f'f="{tmp_path}/listing-$3.txt"; [ -f "$f" ] || f="{tmp_path}/listing.txt"\n'
        '/bin/cat "$f"\n'
        f"exit {rc}\n"
    )
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    return bindir, log


def calls(log):
    return [line.split() for line in log.read_text().splitlines()]


def run_hook_full(command, path):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run(
        [sys.executable, str(HOOK)], input=payload, capture_output=True,
        text=True, timeout=30, env={**os.environ, "PATH": str(path)},
    )
    return proc.returncode, proc.stdout, proc.stderr


def run_hook(command, path):
    rc, _, err = run_hook_full(command, path)
    return rc, err


def test_deploy_blocked_when_var_absent(tmp_path):
    bindir, log = make_fake(tmp_path, LISTING_WITHOUT)
    rc, err = run_hook("vercel deploy --prod", bindir)
    assert rc == 2, err
    assert "vercel env add" in err
    assert calls(log) == [["env", "ls", s] for s in SCOPES]


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
    measured = [c[2] for c in calls(log)]
    assert measured[0] == target
    assert set(SCOPES) <= set(measured)


def test_scope_and_cwd_are_forwarded_to_the_measurement(tmp_path):
    bindir, log = make_fake(tmp_path, LISTING_WITH)
    rc, err = run_hook("vercel deploy --prod --scope elpi --cwd apps/web", bindir)
    assert rc == 0, err
    assert calls(log) == [
        ["env", "ls", s, "--scope", "elpi", "--cwd", "apps/web"] for s in SCOPES
    ]


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


# --- v1.1.0, REVISE on #1561 -------------------------------------------------

@pytest.mark.parametrize("cmd", ["vc --prod", "vc deploy", "npx vc@latest --prod", "bash -c 'vc deploy --prod'"])
def test_vc_alias_is_gated(tmp_path, cmd):
    bindir, log = make_fake(tmp_path, LISTING_WITHOUT)
    rc, err = run_hook(cmd, bindir)
    assert rc == 2, f"{cmd}: {err}"
    assert log.exists()


def test_vc_alias_passes_when_var_present(tmp_path):
    bindir, _ = make_fake(tmp_path, LISTING_WITH)
    rc, err = run_hook("vc --prod", bindir)
    assert rc == 0, err


def test_vc_only_install_is_used_to_measure(tmp_path):
    # Only `vc` on PATH: the measurement runs through it rather than failing open.
    bindir, log = make_fake(tmp_path, LISTING_WITHOUT, name="vc")
    rc, err = run_hook("vercel --prod", bindir)
    assert rc == 2, err
    assert calls(log)[0][:3] == ["env", "ls", "production"]


@pytest.mark.parametrize("cmd", ["vc env ls preview", "vc ls", "echo vc deploy"])
def test_vc_non_deploy_not_gated(tmp_path, cmd):
    bindir, log = make_fake(tmp_path, LISTING_WITHOUT)
    rc, err = run_hook(cmd, bindir)
    assert rc == 0, f"{cmd}: {err}"
    assert not log.exists()


@pytest.mark.parametrize("missing", SCOPES)
def test_prod_deploy_blocked_when_any_scope_lacks_the_var(tmp_path, missing):
    # Present on the deploy target, absent on one other scope: still non-compliant.
    bindir, _ = make_fake(tmp_path, LISTING_WITH, per_scope={missing: LISTING_WITHOUT})
    rc, err = run_hook("vercel deploy --prod", bindir)
    assert rc == 2, err
    assert f"missing on scope(s): {missing}" in err


def test_all_three_scopes_present_passes(tmp_path):
    bindir, log = make_fake(tmp_path, LISTING_WITH)
    rc, err = run_hook("vercel deploy --prod", bindir)
    assert rc == 0, err
    assert sorted(c[2] for c in calls(log)) == sorted(SCOPES)


def test_custom_target_is_measured_on_top_of_the_three(tmp_path):
    bindir, log = make_fake(tmp_path, LISTING_WITH, per_scope={"staging": LISTING_WITHOUT})
    rc, err = run_hook("vercel deploy --target=staging", bindir)
    assert rc == 2, err
    assert [c[2] for c in calls(log)] == ["staging", *SCOPES]


def test_could_not_judge_reaches_operator_and_model(tmp_path):
    bindir, _ = make_fake(tmp_path, "Error: not authorized", rc=1)
    rc, out, err = run_hook_full("vercel deploy --prod", bindir)
    assert rc == 0
    payload = json.loads(out)
    assert "NOT MEASURED" in payload["systemMessage"]
    ctx = payload["hookSpecificOutput"]
    assert ctx["hookEventName"] == "PreToolUse"
    assert "NOT MEASURED" in ctx["additionalContext"] and "not a pass" in ctx["additionalContext"]
    assert "NOT MEASURED" in err


def test_cli_absent_could_not_judge_reaches_the_model(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    rc, out, _ = run_hook_full("vc --prod", empty)
    assert rc == 0
    assert "NOT MEASURED" in json.loads(out)["hookSpecificOutput"]["additionalContext"]


def test_measured_pass_prints_nothing_on_stdout(tmp_path):
    bindir, _ = make_fake(tmp_path, LISTING_WITH)
    rc, out, _ = run_hook_full("vercel deploy --prod", bindir)
    assert rc == 0 and out == ""


def test_partial_measurement_absent_wins_over_unmeasured(tmp_path):
    # One scope absent, the fake errors nowhere else: block, never fail-open.
    bindir, _ = make_fake(tmp_path, LISTING_WITH, per_scope={"preview": LISTING_WITHOUT})
    rc, out, err = run_hook_full("vc", bindir)
    assert rc == 2 and out == "", err
