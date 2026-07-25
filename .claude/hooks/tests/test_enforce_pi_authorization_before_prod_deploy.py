"""RED-then-GREEN tests for enforce-pi-authorization-before-prod-deploy.py.

The predicate must decide on the ACTION (deploy / env set / mutation call),
never on the NAME of a deployment or the mere presence of a convex.cloud URL.
Fail-open cases come FIRST: real deploy forms that must block, varying the
wrapper (sudo, env, subshell, if, interpreter -c) — the axis a guard's own
author never probes. Read-only paths must pass: /api/query is not
/api/mutation, and that distinction gets a named test.
"""
import json
import os
import pathlib
import subprocess
import sys

HOOK = pathlib.Path(__file__).resolve().parent.parent / "enforce-pi-authorization-before-prod-deploy.py"


def run_hook(command: str, extra_env=None):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    env = dict(os.environ)
    env.pop("PI_AUTHORIZED_TASK_ID", None)
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        [sys.executable, str(HOOK)], input=payload,
        capture_output=True, text=True, timeout=15, env=env,
    )
    return proc.returncode, proc.stderr + proc.stdout


# --- FAIL-OPEN CASES FIRST: real deploys that MUST block (rc=2) -------------

def test_bare_deploy_blocks():
    rc, out = run_hook("npx convex deploy --yes")
    assert rc == 2, f"bare prod deploy must block, rc={rc} out={out}"


def test_sudo_wrapped_deploy_blocks():
    rc, _ = run_hook("sudo npx convex deploy --yes")
    assert rc == 2, "sudo wrapper must not hide a deploy"


def test_env_wrapped_deploy_blocks():
    rc, _ = run_hook("env CONVEX_DEPLOY_KEY=x npx convex deploy")
    assert rc == 2, "env wrapper must not hide a deploy"


def test_subshell_deploy_blocks():
    rc, _ = run_hook("( cd repo && npx convex deploy )")
    assert rc == 2, "subshell must not hide a deploy"


def test_if_wrapped_deploy_blocks():
    rc, _ = run_hook("if true; then npx convex deploy; fi")
    assert rc == 2, "conditional must not hide a deploy"


def test_interpreter_dash_c_deploy_blocks():
    rc, _ = run_hook("bash -c 'npx convex deploy --prod'")
    assert rc == 2, "a deploy quoted as an interpreter -c argument is still a deploy"


def test_run_prod_blocks():
    rc, _ = run_hook("npx convex run tasks:purge '{}' --prod")
    assert rc == 2, "convex run --prod is a prod action"


def test_env_set_prod_blocks():
    rc, _ = run_hook("npx convex env set FEATURE_FLAG true --prod")
    assert rc == 2, "convex env set --prod mutates prod state"


def test_curl_mutation_endpoint_blocks():
    rc, _ = run_hook(
        "curl -X POST https://compassionate-goldfinch-737.convex.cloud/api/mutation "
        "-d '{\"path\":\"tasks:purge\"}'")
    assert rc == 2, "a raw HTTP call to /api/mutation is a prod write"


def test_eval_wrapped_deploy_blocks():
    """Eta REVISE survivor A: eval is the shell sibling of bash -c."""
    rc, _ = run_hook("eval 'npx convex deploy --prod'")
    assert rc == 2, "a deploy quoted as an eval argument is still a deploy"
    rc2, _ = run_hook('eval "npx convex deploy"')
    assert rc2 == 2, "double-quoted eval form must also block"


def test_curl_action_endpoint_blocks():
    """Eta REVISE survivor B: /api/action runs server-side, can runMutation."""
    rc, _ = run_hook(
        "curl -X POST https://compassionate-goldfinch-737.convex.cloud/api/action "
        "-d '{\"path\":\"jobs:kick\"}'")
    assert rc == 2, "a raw HTTP call to /api/action is a prod write vector"


# --- READ-ONLY AND PROSE: must pass (rc=0) ----------------------------------

def test_curl_query_endpoint_passes():
    """/api/query is not /api/mutation — the distinction Eta demanded by name."""
    rc, out = run_hook(
        "curl -s https://compassionate-goldfinch-737.convex.cloud/api/query "
        "-d '{\"path\":\"tasks:list\"}'")
    assert rc == 0, f"read-only /api/query must pass, rc={rc} out={out}"


def test_plain_convex_cloud_url_read_passes():
    rc, _ = run_hook("curl -sI https://proper-alligator-8.convex.cloud | head -1")
    assert rc == 0, "hitting a deployment URL without a mutating action is a read"


def test_commit_message_mentioning_deploy_passes():
    rc, _ = run_hook('git commit -m "docs: how to npx convex deploy --prod safely"')
    assert rc == 0, "prose in a commit message is not an action"


def test_heredoc_body_mentioning_deploy_passes():
    rc, _ = run_hook(
        "python3 - <<'EOF'\ncmd = \"bash -c 'npx convex deploy --prod'\"\nprint(cmd)\nEOF")
    assert rc == 0, "a heredoc body is data, not a command the shell runs"


def test_convex_dev_passes():
    rc, _ = run_hook("npx convex dev")
    assert rc == 0


# --- AUTHORIZATION PATHS: an authorized deploy must still pass (rc=0) -------

def test_pi_authorized_comment_passes():
    rc, out = run_hook("npx convex deploy --yes # pi-authorized: k" + "a" * 31)
    assert rc == 0, f"Pi-signed token must allow, rc={rc} out={out}"


def test_laurent_override_passes():
    rc, _ = run_hook("npx convex deploy --yes # laurent-direct-deploy")
    assert rc == 0


def test_authorized_interpreter_deploy_passes():
    rc, _ = run_hook("bash -c 'npx convex deploy --prod' # pi-authorized: k" + "b" * 31)
    assert rc == 0, "authorization must also unlock wrapped forms"


# --- DEV vs PROD KEY DISCRIMINATION (Day-142, task k17256kq) ----------------
# A `convex deploy` reaches whatever CONVEX_DEPLOY_KEY names. This guard's
# intention is "no PROD deploy without Pi" -- a DEV deploy must be zero-friction.

_DEV = "dev:efficient-guineapig-356"
_PROD = "prod:serious-mastodon-42"  # prefix-only is read; not a real secret
_TOKEN = "# pi-authorized: k" + "a" * 31


def test_dev_inline_deploy_passes():
    rc, out = run_hook(f"CONVEX_DEPLOY_KEY={_DEV} npx convex deploy --yes")
    assert rc == 0, f"a DEV deploy must be zero-friction, rc={rc} out={out}"


def test_dev_env_wrapped_deploy_passes():
    rc, _ = run_hook(f"env CONVEX_DEPLOY_KEY={_DEV} npx convex deploy")
    assert rc == 0, "env-wrapped dev deploy still names a dev target"


def test_dev_versioned_deploy_passes():
    rc, _ = run_hook(f"CONVEX_DEPLOY_KEY={_DEV} npx convex@latest deploy --yes")
    assert rc == 0, "@latest suffix must not defeat the dev downgrade"


def test_prod_inline_deploy_blocks():
    rc, _ = run_hook(f"CONVEX_DEPLOY_KEY={_PROD} npx convex deploy --yes")
    assert rc == 2, "a prod-keyed deploy without Pi authorization must block"


def test_prod_inline_deploy_with_token_passes():
    rc, out = run_hook(f"CONVEX_DEPLOY_KEY={_PROD} npx convex deploy --yes {_TOKEN}")
    assert rc == 0, f"prod deploy + Pi token must pass, rc={rc} out={out}"


def test_opaque_var_key_blocks():
    rc, _ = run_hook("CONVEX_DEPLOY_KEY=$MYKEY npx convex deploy --yes")
    assert rc == 2, "an opaque $VAR key is conservative -> require auth"


def test_dev_key_with_explicit_prod_env_set_blocks():
    rc, _ = run_hook(f"CONVEX_DEPLOY_KEY={_DEV} npx convex env set FF true --prod")
    assert rc == 2, "an explicit --prod surface is never downgraded by a dev key"


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                fails += 1
                print(f"FAIL {name}: {e}")
            except Exception as e:
                fails += 1
                print(f"ERROR {name}: {e}")
    sys.exit(1 if fails else 0)
