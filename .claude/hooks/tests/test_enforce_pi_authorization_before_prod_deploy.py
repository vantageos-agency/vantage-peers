"""RED-then-GREEN tests for enforce-pi-authorization-before-prod-deploy.py.

The predicate must decide on the ACTION (deploy / env set / mutation call),
never on the NAME of a deployment or the mere presence of a convex.cloud URL.
Fail-open cases come FIRST: real deploy forms that must block, varying the
wrapper (sudo, env, subshell, if, interpreter -c) — the axis a guard's own
author never probes. Read-only paths must pass: /api/query is not
/api/mutation, and that distinction gets a named test.
"""
import contextlib
import http.server
import importlib.util
import itertools
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import threading
import time

import pytest

HOOK = pathlib.Path(__file__).resolve().parent.parent / "enforce-pi-authorization-before-prod-deploy.py"
HOOKS_DIR = HOOK.parent

# The token fetch NEVER leaves this machine in these tests. By default it is
# pointed at a closed loopback port (connection refused -> could-not-judge);
# the ALLOW poles point it at a local stub of `tasks:get` instead.
DEAD_URL = "http://127.0.0.1:9"


# Per-test scratch root. Every temp path in this file lives under pytest's
# `tmp_path`, which pytest prunes; nothing is created with a bare `mkdtemp`
# (1582 leaked `pi-guard-degraded-*` directories, 1.8G, before this).
_TEST_TMP = None
_scratch_counter = itertools.count()


@pytest.fixture(autouse=True)
def _per_test_tmp(tmp_path):
    global _TEST_TMP
    _TEST_TMP = tmp_path
    yield
    _TEST_TMP = None


def _scratch_dir(prefix=""):
    path = _TEST_TMP / f"{prefix}{next(_scratch_counter)}"
    path.mkdir()
    return path



def run_hook(command: str, extra_env=None):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    env = dict(os.environ)
    env.pop("PI_AUTHORIZED_TASK_ID", None)
    env.pop("PI_AUTH_ORCHESTRATOR", None)
    env["VP_CONVEX_URL"] = DEAD_URL
    # HERMETIC. The guard now mints a service identity from a dotenv when one
    # is not in its environment; a test must never reach Clerk nor read this
    # station's real `.env.local`. Poles that want an identity say so
    # explicitly via STUB_IDENTITY_ENV.
    env.pop("VP_GUARD_CONVEX_TOKEN", None)
    env["VP_GUARD_ENV_FILE"] = "/nonexistent/hermetic/.env.local"
    env["VP_GUARD_AUDIT_LOG"] = str(_TEST_TMP / "pi-auth-test-audit.log")
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        [sys.executable, str(HOOK)], input=payload,
        capture_output=True, text=True, timeout=15, env=env,
    )
    return proc.returncode, proc.stderr + proc.stdout


def token_task(title="[PROD-DEPLOY-AUTHORIZED] deploy sigma", age_sec=0,
               assigned_to="sigma", tags=None):
    """A task shaped like a real issued token: marker in the TITLE, tags null."""
    return {
        "title": title,
        "tags": tags,
        "createdAt": (time.time() - age_sec) * 1000,
        "assignedTo": assigned_to,
    }


@contextlib.contextmanager
def stub_vp(tasks):
    """Serve `tasks:get` on loopback from `tasks` (id -> task dict).

    An id absent from `tasks` answers `{"status":"success","value":null}`,
    exactly what the real query returns for an id that names no task."""

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - http.server API
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            path = body.get("path")
            if path != "tasks:get":
                # The guard's POSITIVE CONTROL: a query this deployment can
                # always answer, asked only to tell "the id names nothing"
                # apart from "the store is down".
                payload = {"status": "success", "value": []}
            elif body.get("args", {}).get("taskId") in tasks:
                payload = {"status": "success",
                           "value": tasks[body["args"]["taskId"]]}
            else:
                # MEASURED against the real deployment: an id that names no
                # row does NOT come back as success+null -- the `v.id("tasks")`
                # validator throws and prod returns an opaque Server Error.
                # The stub said success+null for years, which is why this suite
                # could not see the outage.
                payload = {"status": "error",
                           "errorMessage": "[Request ID: stub] Server Error"}
            out = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def run_with_tasks(command, tasks, extra_env=None):
    with stub_vp(tasks) as url:
        # The guard reads its token as an IDENTIFIED caller now, so every pole
        # that expects it to be SERVED must supply an identity. The permissive
        # stub ignores the header; supplying it here keeps these poles testing
        # what they were written to test (token VALIDITY) rather than silently
        # turning them all into could-not-check.
        env = {"VP_CONVEX_URL": url, "VP_GUARD_CONVEX_TOKEN": "stub-identity-not-a-real-token"}
        env.update(extra_env or {})
        return run_hook(command, env)


def load_hook_module():
    """Import the hook in-process without running its stdin entrypoint."""
    spec = importlib.util.spec_from_file_location("pi_guard_under_test", HOOK)
    module = importlib.util.module_from_spec(spec)
    module._TESTING = True
    spec.loader.exec_module(module)
    return module


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

_ID_A = "k" + "a" * 31
_ID_B = "k" + "b" * 31


def test_pi_authorized_comment_passes():
    rc, out = run_with_tasks(
        f"npx convex deploy --yes # pi-authorized: {_ID_A}", {_ID_A: token_task()})
    assert rc == 0, f"a valid fresh token must allow, rc={rc} out={out}"


def test_laurent_override_passes():
    rc, _ = run_hook("npx convex deploy --yes # laurent-direct-deploy")
    assert rc == 0


def test_authorized_interpreter_deploy_passes():
    rc, _ = run_with_tasks(
        f"bash -c 'npx convex deploy --prod' # pi-authorized: {_ID_B}",
        {_ID_B: token_task()})
    assert rc == 0, "authorization must also unlock wrapped forms"


# --- TOKEN VALIDATION: the id must name a live, valid task (rc=2 otherwise) -

def test_invented_token_refused():
    """The defect this union closes: a well-SPELLED id that names no task."""
    rc, out = run_with_tasks(f"npx convex deploy --yes # pi-authorized: {_ID_A}", {})
    assert rc == 2, f"an invented id must be refused, rc={rc} out={out}"
    # Was "task-unreadable-or-absent": the guard used to collapse "you may
    # not see it" and "it is not there" into one word, which is exactly
    # what froze the fleet. The token is now READ as an identified caller,
    # so a well-spelled id naming nothing is a plain ABSENCE and says so.
    assert "token-absent" in out
    assert "COULD NOT CHECK" not in out, "an absence is not a could-not-check"


def _guard_ttl_sec():
    """Read the window from the executing file, never restate it here.

    A test that types its own copy of the number passes while the two disagree:
    the window moved from 3600 to 7200 and this test went on asserting against a
    figure no longer in the guard, so it failed on a guard that was correct. The
    number has one home and the test reads it there.
    """
    src = (pathlib.Path(__file__).resolve().parents[1]
           / "enforce-pi-authorization-before-prod-deploy.py").read_text()
    m = re.search(r"^TASK_TTL_SEC\s*=\s*(\d+)", src, re.M)
    assert m, "TASK_TTL_SEC not found in the guard -- the test cannot derive the window"
    return int(m.group(1))


def test_expired_token_refused():
    ttl = _guard_ttl_sec()
    rc, out = run_with_tasks(
        f"npx convex deploy --yes # pi-authorized: {_ID_A}",
        {_ID_A: token_task(age_sec=ttl + 1)})
    assert rc == 2, (
        f"a token older than the guard's own window ({ttl}s) must be refused, "
        f"rc={rc} out={out}")
    assert "task-invalid" in out


def test_token_just_inside_the_window_is_accepted():
    """The other pole. Without it, a guard refusing EVERY token passes above."""
    ttl = _guard_ttl_sec()
    rc, out = run_with_tasks(
        f"npx convex deploy --yes # pi-authorized: {_ID_A}",
        {_ID_A: token_task(age_sec=ttl - 60)})
    assert rc == 0, f"a token inside the window must pass, rc={rc} out={out}"


def test_token_without_marker_refused():
    rc, _ = run_with_tasks(
        f"npx convex deploy --yes # pi-authorized: {_ID_A}",
        {_ID_A: token_task(title="unrelated task")})
    assert rc == 2, "a task without [PROD-DEPLOY-AUTHORIZED] authorizes nothing"


def test_marker_in_tags_still_accepted():
    rc, _ = run_with_tasks(
        f"npx convex deploy --yes # pi-authorized: {_ID_A}",
        {_ID_A: token_task(title="deploy", tags=["[PROD-DEPLOY-AUTHORIZED]"])})
    assert rc == 0, "the marker is honoured in tags as well as in the title"


def test_foreign_assignee_refused_when_caller_declared():
    rc, out = run_with_tasks(
        f"npx convex deploy --yes # pi-authorized: {_ID_A}",
        {_ID_A: token_task(assigned_to="omega")},
        {"PI_AUTH_ORCHESTRATOR": "sigma"})
    assert rc == 2, f"a token assigned to another orchestrator must be refused, rc={rc} out={out}"


def test_own_assignee_passes_when_caller_declared():
    rc, out = run_with_tasks(
        f"npx convex deploy --yes # pi-authorized: {_ID_A}",
        {_ID_A: token_task(assigned_to="sigma")},
        {"PI_AUTH_ORCHESTRATOR": "sigma"})
    assert rc == 0, f"a token assigned to the declared caller must allow, rc={rc} out={out}"


def test_unreachable_vp_refused():
    """Could-not-judge is a refusal: the fetch fails (connection refused)."""
    rc, out = run_hook(f"npx convex deploy --yes # pi-authorized: {_ID_A}")
    assert rc == 2, f"an unreachable token store must refuse, rc={rc} out={out}"


def test_fetch_raising_refused():
    """The read RAISES (a malformed URL). It must refuse rather than fall open.

    This used to reach main()'s crash handler ("could not run"). It is now
    classified where it belongs -- the read could not be completed, so it is
    the THIRD state and says COULD NOT CHECK. Same exit code, honest text.
    """
    rc, out = run_hook(
        f"npx convex deploy --yes # pi-authorized: {_ID_A}",
        {"VP_CONVEX_URL": "not-a-url",
         "VP_GUARD_CONVEX_TOKEN": "stub-identity-not-a-real-token"})
    assert rc == 2, f"a read that raises must refuse, rc={rc} out={out}"
    assert "COULD NOT CHECK" in out, f"a failed read is a could-not-check, out={out}"
    assert "BLOCKED:" not in out, (
        "a failed read must not be spelled as a refusal of the token")


# --- CRASH POLE: the entrypoint fails CLOSED on a prod action --------------

def test_crash_on_prod_deploy_exits_2():
    guard = load_hook_module()

    def boom(_command):
        raise RuntimeError("simulated crash")

    guard.run_hook = boom
    payload = json.dumps({"tool_name": "Bash",
                          "tool_input": {"command": "npx convex deploy --yes"}})
    assert guard.main(payload) == 2, "a crash on a prod deploy must refuse"


def test_crash_on_benign_command_stays_open():
    guard = load_hook_module()

    def boom(_command):
        raise RuntimeError("simulated crash")

    guard.run_hook = boom
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "ls -la"}})
    assert guard.main(payload) == 0, "a crash on ordinary work must not block it"


# --- DEV vs PROD KEY DISCRIMINATION (Day-142, task k17256kq) ----------------
# A `convex deploy` reaches whatever CONVEX_DEPLOY_KEY names. This guard's
# intention is "no PROD deploy without Pi" -- a DEV deploy must be zero-friction.

_DEV = "dev:efficient-guineapig-356"
_PROD = "prod:serious-mastodon-42"  # prefix-only is read; not a real secret
_TOKEN = f"# pi-authorized: {_ID_A}"


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
    rc, out = run_with_tasks(
        f"CONVEX_DEPLOY_KEY={_PROD} npx convex deploy --yes {_TOKEN}",
        {_ID_A: token_task()})
    assert rc == 0, f"prod deploy + valid Pi token must pass, rc={rc} out={out}"


def test_prod_inline_deploy_with_invented_token_blocks():
    rc, _ = run_with_tasks(f"CONVEX_DEPLOY_KEY={_PROD} npx convex deploy --yes {_TOKEN}", {})
    assert rc == 2, "a prod-keyed deploy with an invented token must block"


def test_dev_quoted_full_key_passes_without_token():
    """A real key contains `|`: quoted, it reaches the deploy -> DEV door."""
    rc, out = run_hook("CONVEX_DEPLOY_KEY='dev:fake|x' npx convex deploy --yes")
    assert rc == 0, f"a quoted dev key must open the DEV door, rc={rc} out={out}"


def test_prod_quoted_full_key_blocks_without_token():
    rc, _ = run_hook("CONVEX_DEPLOY_KEY='prod:fake|x' npx convex deploy --yes")
    assert rc == 2, "a quoted prod key without a token must block"


def test_prod_unquoted_full_key_blocks_without_token():
    rc, _ = run_hook("CONVEX_DEPLOY_KEY=prod:fake|x npx convex deploy --yes")
    assert rc == 2, "a prod key without a token must block"


def test_dev_unquoted_full_key_blocks():
    """Unquoted, the `|` is a PIPE: the key stays in stage one and the deploy
    in stage two runs with the AMBIENT key. It is not a DEV deploy."""
    rc, _ = run_hook("CONVEX_DEPLOY_KEY=dev:fake|x npx convex deploy --yes")
    assert rc == 2, "a dev key that never reaches the deploy must not open the DEV door"


def test_dev_key_on_another_segment_blocks():
    rc, _ = run_hook(f"CONVEX_DEPLOY_KEY={_DEV} true; npx convex deploy --yes")
    assert rc == 2, "a dev key assigned to a different command does not reach the deploy"


def test_dev_then_prod_key_same_segment_blocks():
    rc, _ = run_hook(
        f"CONVEX_DEPLOY_KEY={_DEV} CONVEX_DEPLOY_KEY={_PROD} npx convex deploy --yes")
    assert rc == 2, "any prod assignment on the deploy segment wins over a dev one"


def test_untokenizable_export_of_key_name_passes():
    """The variable NAME CONVEX_DEPLOY_KEY is not a deploy action."""
    rc, out = run_hook('export CONVEX_DEPLOY_KEY="$(cat /dev/null)"')
    assert rc == 0, f"exporting the key is not a deploy, rc={rc} out={out}"


def test_opaque_var_key_blocks():
    rc, _ = run_hook("CONVEX_DEPLOY_KEY=$MYKEY npx convex deploy --yes")
    assert rc == 2, "an opaque $VAR key is conservative -> require auth"


def test_dev_key_with_explicit_prod_env_set_blocks():
    rc, _ = run_hook(f"CONVEX_DEPLOY_KEY={_DEV} npx convex env set FF true --prod")
    assert rc == 2, "an explicit --prod surface is never downgraded by a dev key"


# --- DEV-DOOR MESSAGE REDIRECT (Laurent Day 156 friction fix) ---------------
# Prod protection unchanged: a prod-tinted deploy with no Pi token still BLOCKS.
# The block MESSAGE must now NAME the DEV door so the orchestrator stops
# fighting the prod gauntlet and switches to the one-line dev command.

def test_prod_block_message_names_dev_door():
    rc, out = run_hook(f"CONVEX_DEPLOY_KEY={_PROD} npx convex deploy --yes")
    assert rc == 2, "prod deploy without Pi token must still block"
    assert "convex dev --once" in out, (
        f"block message must name the DEV door, out={out}"
    )


def test_convex_dev_once_passes():
    rc, _ = run_hook("npx convex dev --once")
    assert rc == 0, "a bare `npx convex dev --once` is never blocked by this guard"


# --- IMPORT-GUARDED FALLBACK: the shared module cannot be reached ----------
# Ported from ElPi-Corp PR #170 (head 94809653, APPROVED). Three corrections
# over the pre-port guard, each with its own test below:
#   (1) the `_lib.command_predicate` import is itself guarded -- a raw
#       command naming a convex deploy is REFUSED (rc=2, "REFUSING TO
#       JUDGE" + the module name), anything else stays open (rc=0);
#   (2) strip_quoted_strings unquotes a quoted single word with no
#       whitespace inside (an ARGUMENT), while a quoted run containing
#       whitespace stays inert (PROSE);
#   (3) the degraded fallback strips quote CHARACTERS outright (never a
#       space) and matches convex...deploy by ORDER, not ADJACENCY.

def build_degraded_world(delete_module=False, strip_carries_prod_action=False):
    """Copy `.claude/hooks/` into a fresh tmp dir and degrade the shared
    module there -- never touch the real checkout. Returns the path to the
    copied guard script.

    `delete_module=True`  -> world (a): the module file is gone entirely.
    `strip_carries_prod_action=True` -> world (b): the module is present but
    stale -- missing the very name the guard imports.
    """
    tmp = _scratch_dir("pi-guard-degraded-")
    dest_hooks = tmp / "hooks"
    shutil.copytree(HOOKS_DIR, dest_hooks, ignore=shutil.ignore_patterns("__pycache__"))
    module_path = dest_hooks / "_lib" / "command_predicate.py"
    if delete_module:
        module_path.unlink()
    elif strip_carries_prod_action:
        src = module_path.read_text()
        match = re.search(r"\ndef carries_prod_action\(.*?\n(?=\ndef |\Z)", src, re.DOTALL)
        assert match, "carries_prod_action definition not found to strip"
        module_path.write_text(src[: match.start()] + "\n" + src[match.end() :])
    return dest_hooks / "enforce-pi-authorization-before-prod-deploy.py"


def run_degraded_hook(guard_path, command, extra_env=None):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    env = dict(os.environ)
    env.pop("PI_AUTHORIZED_TASK_ID", None)
    env.pop("PI_AUTH_ORCHESTRATOR", None)
    env["VP_CONVEX_URL"] = DEAD_URL
    # HERMETIC. The guard now mints a service identity from a dotenv when one
    # is not in its environment; a test must never reach Clerk nor read this
    # station's real `.env.local`. Poles that want an identity say so
    # explicitly via STUB_IDENTITY_ENV.
    env.pop("VP_GUARD_CONVEX_TOKEN", None)
    env["VP_GUARD_ENV_FILE"] = "/nonexistent/hermetic/.env.local"
    env["VP_GUARD_AUDIT_LOG"] = str(_TEST_TMP / "pi-auth-test-audit.log")
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        [sys.executable, str(guard_path)], input=payload,
        capture_output=True, text=True, timeout=15, env=env, cwd=str(guard_path.parent),
    )
    return proc.returncode, proc.stderr + proc.stdout


def test_import_failure_module_deleted_refuses_named_prod_deploy():
    guard = build_degraded_world(delete_module=True)
    rc, out = run_degraded_hook(guard, "CONVEX_DEPLOY_KEY=prod:y npx convex deploy --yes")
    assert rc == 2, f"a named prod deploy must refuse when the module is gone, rc={rc} out={out}"
    assert "REFUSING TO JUDGE" in out and "command_predicate" in out


def test_import_failure_module_deleted_allows_benign_command():
    guard = build_degraded_world(delete_module=True)
    rc, out = run_degraded_hook(guard, "ls -la")
    assert rc == 0, f"a command not naming a deploy must stay open, rc={rc} out={out}"


def test_import_failure_stale_module_refuses_named_prod_deploy():
    guard = build_degraded_world(strip_carries_prod_action=True)
    rc, out = run_degraded_hook(guard, "CONVEX_DEPLOY_KEY=prod:y npx convex deploy --yes")
    assert rc == 2, f"a stale module missing carries_prod_action must still refuse, rc={rc} out={out}"
    assert "REFUSING TO JUDGE" in out


def test_import_failure_stale_module_allows_benign_command():
    guard = build_degraded_world(strip_carries_prod_action=True)
    rc, out = run_degraded_hook(guard, "npx convex dev --once")
    assert rc == 0, f"dev subcommand must stay open on a stale module, rc={rc} out={out}"


def test_import_failure_matches_by_order_not_adjacency():
    """Corner (1)+(3): a flag BETWEEN the two words defeats an adjacency
    check but not an order check."""
    guard = build_degraded_world(delete_module=True)
    rc, out = run_degraded_hook(guard, "CONVEX_DEPLOY_KEY=prod:y npx convex --verbose deploy")
    assert rc == 2, f"words in order (not adjacent) must still be refused, rc={rc} out={out}"


def test_import_failure_strips_quote_characters_split_binary():
    """Corner (3): quote CHARACTERS are deleted (never replaced by a space),
    so a split binary `"con"'vex'` still reads as the single word convex."""
    guard = build_degraded_world(delete_module=True)
    rc, out = run_degraded_hook(guard, "CONVEX_DEPLOY_KEY=prod:y npx \"con\"'vex' deploy")
    assert rc == 2, f"split binary must be caught by the degraded fallback, rc={rc} out={out}"


def test_import_failure_strips_quote_characters_split_verb():
    guard = build_degraded_world(delete_module=True)
    rc, out = run_degraded_hook(guard, "CONVEX_DEPLOY_KEY=prod:y npx convex de''ploy")
    assert rc == 2, f"split verb must be caught by the degraded fallback, rc={rc} out={out}"


def test_import_failure_interpreter_and_pipe_wrapped_prod_refused():
    guard = build_degraded_world(delete_module=True)
    for cmd in (
        'bash -c "npx convex deploy --yes"',
        "sh -c 'npx convex deploy --yes'",
        'eval "npx convex deploy --yes"',
        "echo 'npx convex deploy --yes' | bash",
    ):
        rc, out = run_degraded_hook(guard, cmd)
        assert rc == 2, f"{cmd!r} must be refused in the degraded world, rc={rc} out={out}"


def test_import_failure_dev_subcommand_still_passes():
    """The degraded fallback cannot see a dev key at all -- but a bare
    `convex dev --once` never names the deploy action words to begin with."""
    guard = build_degraded_world(delete_module=True)
    rc, out = run_degraded_hook(guard, "npx convex dev --once")
    assert rc == 0, f"dev subcommand must not be refused, rc={rc} out={out}"


def test_import_failure_lookalike_binary_not_matched():
    """`"con"'ex'` spells conex, never convex -- the degraded fallback must
    not over-match a binary name that merely resembles convex."""
    guard = build_degraded_world(delete_module=True)
    rc, out = run_degraded_hook(guard, "npx \"con\"'ex' deploy")
    assert rc == 0, f"conex is not convex, rc={rc} out={out}"


# --- The degraded fallback refuses the guard's WHOLE production set -------
# Not `deploy` alone: every form the healthy path refuses without a token
# (a `--prod` flag on any subcommand, a `run --push --prod` code upload) must
# be refused when the module is gone or stale. `--push` WITHOUT `--prod`
# targets the default (dev) deployment and passes in the healthy world, so it
# passes here too -- the fallback mirrors the healthy set, it does not invent
# a wider one.

DEGRADED_PROD_MUST_BLOCK = (
    "npx convex env set FOO bar --prod",
    "npx convex env remove FOO --prod",
    "npx convex run someModule:fn --prod",
    "npx convex import --prod data.zip",
    "npx convex run someModule:fn --push --prod",
    "npx convex@1.2.3 run someModule:fn --prod",
    "npx \"con\"'vex' env set FOO bar --prod",
    "bash -c \"npx convex run someModule:fn --prod\"",
)

DEGRADED_PROD_MUST_PASS = (
    "ls",
    "npx convex dev --once",
    "npx \"con\"'ex' deploy",
    "npx \"con\"'ex' run someModule:fn --prod",
    "npx convex run someModule:fn --push",
    "npx convex env set FOO bar",
    "git commit -m \"fix: the prod flag is documented\"",
    "export CONVEX_DEPLOY_KEY_NAME=x; echo --prod",
)


def _degraded_cells(guard, commands, expected_rc):
    wrong = []
    for cmd in commands:
        rc, out = run_degraded_hook(guard, cmd)
        if rc != expected_rc:
            wrong.append((cmd, rc))
        elif expected_rc == 2:
            assert "REFUSING TO JUDGE" in out and "command_predicate" in out, (
                f"{cmd!r} refused without naming the module: {out}"
            )
    return wrong


def test_import_failure_module_deleted_refuses_every_prod_form():
    guard = build_degraded_world(delete_module=True)
    wrong = _degraded_cells(guard, DEGRADED_PROD_MUST_BLOCK, 2)
    assert not wrong, f"module deleted: these must refuse (cmd, rc): {wrong}"


def test_import_failure_stale_module_refuses_every_prod_form():
    guard = build_degraded_world(strip_carries_prod_action=True)
    wrong = _degraded_cells(guard, DEGRADED_PROD_MUST_BLOCK, 2)
    assert not wrong, f"stale module: these must refuse (cmd, rc): {wrong}"


def test_import_failure_module_deleted_non_prod_stays_open():
    guard = build_degraded_world(delete_module=True)
    wrong = _degraded_cells(guard, DEGRADED_PROD_MUST_PASS, 0)
    assert not wrong, f"module deleted: these must stay open (cmd, rc): {wrong}"


def test_import_failure_stale_module_non_prod_stays_open():
    guard = build_degraded_world(strip_carries_prod_action=True)
    wrong = _degraded_cells(guard, DEGRADED_PROD_MUST_PASS, 0)
    assert not wrong, f"stale module: these must stay open (cmd, rc): {wrong}"


# --- strip_quoted_strings: an argument is unquoted, a phrase stays inert ---

def test_strip_quoted_single_word_unquotes_as_argument():
    """Corner (2): `npx 'convex' deploy` -- the quotes carry an ARGUMENT the
    shell would run identically unquoted, so they are noise and removed."""
    guard = load_hook_module()
    assert guard.strip_quoted_strings("npx 'convex' deploy --yes") == "npx convex deploy --yes"
    assert guard.strip_quoted_strings('npx "convex" deploy --yes') == "npx convex deploy --yes"


def test_strip_quoted_phrase_with_whitespace_stays_inert():
    """A quoted run containing whitespace is PROSE -- it is emptied, not
    unquoted, so a search string is never read as a command."""
    guard = load_hook_module()
    assert guard.strip_quoted_strings('grep -r "convex deploy" docs/') == 'grep -r "" docs/'



# ---------------------------------------------------------------------------
# THE DOOR (task k172pesxfj94bm3ed6q790fhnx8f628x).
#
# Every stub above answers `tasks:get` to ANY reader. The real deployment does
# not: `convex/tasks.ts`'s `get` resolves `withOrgScope(ctx, {refuseWithoutThrow:
# true})` and returns null through `isRowVisibleToScope` when the caller has no
# scope. An unidentified reader therefore gets `{"status":"success","value":null}`
# for EVERY task, including ones that exist. Because the permissive stub never
# modelled that door, this suite stayed green while production could not deploy
# at all -- the tests proved the guard's TEXT handling, never its ability to be
# SERVED. `stub_vp_requiring_identity` closes that gap: it is the same stub with
# the door in front of it.
#
# THE TRAP these three poles pin: `value: null` means BOTH "no such task" and
# "you may not see it". A guard that collapses them into "absent" blocks every
# honest caller today, and -- once it is taught to allow -- would ALLOW on a
# refusal tomorrow. So the guard must end in THREE states, not two.
#
# On exit codes: ALLOW is 0. BLOCK and REFUSE-TO-JUDGE are BOTH 2, and
# deliberately so -- under the Claude Code hook protocol only 2 actually stops
# the tool call, so a refusal that exited anything else would let the deploy
# run. The two are separated where the operator reads them: the stderr text and
# the audit log's `reason` field. "I could not check" and "this is not
# authorised" must never be the same sentence.
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def stub_vp_requiring_identity(tasks, *, status_code=200, force_error=False,
                               credential_accepted=True):
    """`tasks:get` behind the SAME door the real deployment puts in front of it.

    No `Authorization` header -> `{"status":"success","value":null}` whatever
    the id, exactly as `isRowVisibleToScope` returns for a scope-less caller.
    With a bearer -> the row, or null when the id truly names no task.
    """

    seen = {"authorized_reads": 0, "anonymous_reads": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - http.server API
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if force_error:
                out = json.dumps(
                    {"status": "error", "errorMessage": "Server Error"}
                ).encode()
                self.send_response(status_code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)
                return
            bearer = self.headers.get("Authorization", "")
            identified = (
                bearer.startswith("Bearer ")
                and len(bearer) > len("Bearer ")
                and credential_accepted
            )
            if body.get("path") != "tasks:get":
                # THE POSITIVE CONTROL. It cannot succeed without an accepted
                # credential: `missions:list` calls requireScope, which THROWS
                # for a scope-less caller, and the throw is a ConvexError whose
                # payload reaches the wire as `errorData`. Measured on the real
                # deployment (anonymous -> RBAC_DENIED, identified -> rows).
                if identified:
                    payload = {"status": "success", "value": []}
                else:
                    payload = {
                        "status": "error",
                        "errorMessage": "[Request ID: stub] Server Error",
                        "errorData": 'RBAC_DENIED: Missing scope "view-own-missions" for org "null"',
                    }
            elif not identified:
                seen["anonymous_reads"] += 1
                # The door: null for EVERY id, present or not.
                payload = {"status": "success", "value": None}
            else:
                seen["authorized_reads"] += 1
                if body.get("args", {}).get("taskId") in tasks:
                    payload = {"status": "success",
                               "value": tasks[body["args"]["taskId"]]}
                else:
                    payload = {"status": "error",
                               "errorMessage": "[Request ID: stub] Server Error"}
            out = json.dumps(payload).encode()
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", seen
    finally:
        server.shutdown()
        server.server_close()


# A stub identity. The test never mints a real one and never reads a real
# secret: it names the variable the guard reads and supplies a placeholder, so
# the suite exercises the PRESENTING of an identity without any credential
# leaving (or entering) this machine.
STUB_IDENTITY_ENV = {"VP_GUARD_CONVEX_TOKEN": "stub-identity-not-a-real-token"}

AUTHORIZED_DEPLOY = "npx convex deploy --yes # pi-authorized: k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


def _run_against_door(command, tasks, *, extra_env=None, **stub_kwargs):
    with stub_vp_requiring_identity(tasks, **stub_kwargs) as (url, seen):
        env = {"VP_CONVEX_URL": url}
        env.update(STUB_IDENTITY_ENV)
        env.update(extra_env or {})
        rc, out = run_hook(command, env)
    return rc, out, seen


def test_valid_token_allows():
    """POSITIVE POLE FIRST. A valid, unexpired, correctly-shaped token behind
    the real door must ALLOW -- the guard has to present an identity to be
    served the grant it legitimately holds."""
    tasks = {"k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa": token_task()}
    rc, out, seen = _run_against_door(AUTHORIZED_DEPLOY, tasks)
    assert seen["authorized_reads"] >= 1, (
        "the guard read the token WITHOUT presenting an identity, so the door "
        f"served it null: anonymous_reads={seen['anonymous_reads']} out={out}"
    )
    assert rc == 0, f"a valid token must ALLOW, rc={rc} out={out}"


def test_forged_token_blocks():
    """A token READ SUCCESSFULLY that names no task is a BLOCK, and the text
    must say so -- not 'I could not check'."""
    rc, out, seen = _run_against_door(AUTHORIZED_DEPLOY, {})
    assert rc == 2, f"a forged token must BLOCK, rc={rc} out={out}"
    assert "BLOCKED" in out, f"a forged token must read as BLOCKED, out={out}"
    assert "could not be completed" not in out, (
        "a forged token was reported as unjudgeable; a refusal and an absence "
        f"must stay distinguishable, out={out}"
    )


def test_unreadable_server_refuses_to_judge():
    """The read itself could not be completed. Not a BLOCK, not an ALLOW: a
    third, visibly distinct answer."""
    rc, out, _ = _run_against_door(AUTHORIZED_DEPLOY, {}, force_error=True)
    assert rc == 2, f"an unreadable store must refuse, rc={rc} out={out}"
    assert "COULD NOT CHECK" in out, (
        f"the third state must be visibly distinct in the text, out={out}"
    )
    assert "BLOCKED:" not in out, (
        f"'I could not check' must not be spelled as 'this is not authorised', out={out}"
    )


def test_missing_credential_refuses_to_judge_rather_than_blocking():
    """No credential reachable is the SAME third state: the guard cannot
    identify itself, so it refuses to judge and names that -- it never invents
    a bypass, and never silently reports the token as absent."""
    tasks = {"k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa": token_task()}
    with stub_vp_requiring_identity(tasks) as (url, _seen):
        rc, out = run_hook(
            AUTHORIZED_DEPLOY,
            {"VP_CONVEX_URL": url, "VP_GUARD_CONVEX_TOKEN": "",
             "VP_GUARD_ENV_FILE": "/nonexistent/.env.local"},
        )
    assert rc == 2, f"no credential must refuse, rc={rc} out={out}"
    assert "COULD NOT CHECK" in out, f"must read as could-not-check, out={out}"
    assert "VP_GUARD_CONVEX_TOKEN" in out, (
        f"the refusal must NAME the variable it needs (never its value), out={out}"
    )


def test_control_refuses_an_unidentified_caller():
    """THE CONTROL'S OWN NEGATIVE POLE, in the suite.

    The first control here (`tasks:listUnlinkedBlocked`) answered an anonymous
    caller with 159 rows -- identical to an identified one -- so it could
    succeed WITHOUT the credential and proved nothing about identity. A control
    never run on its own negative pole is an instrument nobody has checked.
    """
    guard = load_hook_module()
    assert guard.LIVENESS_PATH == "missions:list", (
        "the control must be a path that REFUSES an unidentified caller"
    )
    with stub_vp_requiring_identity({}, credential_accepted=False) as (url, _):
        os.environ["VP_CONVEX_URL"] = url
        try:
            guard.VP_CONVEX_URL = url
            state, why = guard.store_is_answering("a-credential-the-store-rejects")
        finally:
            os.environ.pop("VP_CONVEX_URL", None)
    assert state == guard.CONTROL_NOT_IDENTIFIED, (
        f"a rejected credential must read as not-identified, got {state} ({why})"
    )


def test_control_serves_an_identified_caller():
    """POSITIVE POLE of the same instrument -- both poles, never one."""
    guard = load_hook_module()
    with stub_vp_requiring_identity({}) as (url, _):
        guard.VP_CONVEX_URL = url
        state, _ = guard.store_is_answering("a-credential-the-store-accepts")
    assert state == guard.CONTROL_SERVED, f"an accepted credential must be served, got {state}"


def test_broken_credential_refuses_to_judge_rather_than_blocking():
    """THE REGRESSION THIS CONTROL EXISTS FOR.

    The credential is rejected by the deployment, so the token read fails. A
    guard whose control could pass without the credential would read that as
    "the id names nothing" and BLOCK a perfectly valid token. The truth is
    "I could not identify myself", and the honest answer is REFUSE TO JUDGE.
    """
    tasks = {"k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa": token_task()}
    rc, out, _ = _run_against_door(AUTHORIZED_DEPLOY, tasks, credential_accepted=False)
    assert rc == 2, f"a rejected credential must refuse, rc={rc} out={out}"
    assert "COULD NOT CHECK" in out, (
        f"a rejected credential is a could-not-check, never a BLOCK, out={out}"
    )
    assert "token-absent" not in out, (
        "a valid token was reported as absent because the credential failed -- "
        f"this is the collapse the control exists to prevent, out={out}"
    )


def test_three_states_are_distinct_in_the_audit_log():
    """ALLOW / BLOCK / REFUSE-TO-JUDGE must be three different `reason` values
    in /tmp/pi-auth-prod-deploy.log, not two."""
    log = _scratch_dir("audit-") / "audit.log"
    tasks = {"k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa": token_task()}
    env = {"VP_GUARD_AUDIT_LOG": str(log)}
    _run_against_door(AUTHORIZED_DEPLOY, tasks, extra_env=env)
    _run_against_door(AUTHORIZED_DEPLOY, {}, extra_env=env)
    _run_against_door(AUTHORIZED_DEPLOY, {}, extra_env=env, force_error=True)
    reasons = [json.loads(line)["reason"] for line in
               log.read_text().splitlines() if line.strip()]
    assert len(set(reasons)) == 3, (
        f"three outcomes must leave three distinct reasons, got {reasons}"
    )


# ---------------------------------------------------------------------------
# GUARD IDENTITY: a mint failure names the STEP that failed, and still refuses.
#
# `guard_identity()` has four ways to end without a bearer. Before these poles
# the behaviour existed and NOTHING pinned it: collapsing the four reasons into
# one sentence, reclassifying a mint failure as `block`, dropping the
# VP_GUARD_CONVEX_TOKEN escape, or turning could-not-judge into allow would each
# have left every other pole green. A control that has never been shown to fail
# is not a control.
#
# The Clerk round-trips are the ONLY thing faked. The driver below loads the
# real hook, replaces its `_post_json` transport with a scripted sequence, and
# runs the real `main()` -- so the text, the audit line and the exit code are
# the hook's own, end to end. Nothing leaves this machine; the credentials are
# placeholders and are asserted never to be echoed.
# ---------------------------------------------------------------------------

_FAKE_SECRET = "sk_test_placeholder_never_a_real_secret"
_FAKE_USER = "user_placeholder_service_account"
_FAKE_DOMAIN = "https://clerk.placeholder.invalid"

# What each scripted Clerk transport answers, in call order. A callable raises.
# None of these carries a bearer, so the ONLY thing that differs between the
# four scenarios is which step of the mint flow came back empty.
_MINT_SCENARIOS = {
    "credentials-absent": None,  # no Clerk call is ever made
    "domain-absent": [],  # secret and user present, no domain: no Clerk call either
    "no-sign-in-ticket": [{}],
    "no-session-from-exchange": [{"token": "t"}, {}],
    "no-jwt-for-template": [{"token": "t"}, {"response": {"created_session_id": "s"}}, {}],
}

# The word(s) that place each failure at its step. Distinctness is the pole;
# these keep a reworded reason from drifting away from the step it names.
_STEP_MARKER = {
    "credentials-absent": "no credential is reachable",
    "domain-absent": "no Clerk frontend domain is configured",
    "no-sign-in-ticket": "no sign-in ticket",
    "no-session-from-exchange": "returned no session",
    "no-jwt-for-template": "no JWT",
}

_MINT_DRIVER = r"""
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("guard_under_mint_test", os.environ["MINT_TEST_HOOK"])
guard = importlib.util.module_from_spec(spec)
guard._TESTING = True
spec.loader.exec_module(guard)
script = json.loads(os.environ["MINT_TEST_SCRIPT"])
calls = iter(script)
def scripted_post_json(url, payload, headers, *, form=None):
    step = next(calls)
    if step == "raise":
        raise OSError("HTTP 403")
    return step
guard._post_json = scripted_post_json
sys.exit(guard.main(sys.stdin.read()))
"""


def _run_mint_failure(scenario, audit_log_path):
    """Run the real hook to a mint failure; return (rc, operator_text)."""
    script = _MINT_SCENARIOS[scenario]
    env = dict(os.environ)
    for name in ("PI_AUTHORIZED_TASK_ID", "PI_AUTH_ORCHESTRATOR", "VP_GUARD_CONVEX_TOKEN",
                 "CLERK_SECRET_KEY", "CLERK_SERVICE_ACCOUNT_USER_ID", "CLERK_DOMAIN"):
        env.pop(name, None)
        env.pop(name + "_VANTAGE_PEERS", None)
    env.update({
        "VP_CONVEX_URL": DEAD_URL,
        "VP_GUARD_ENV_FILE": "/nonexistent/hermetic/.env.local",
        "VP_GUARD_AUDIT_LOG": str(audit_log_path),
        "MINT_TEST_HOOK": str(HOOK),
        "MINT_TEST_SCRIPT": json.dumps(script or []),
    })
    if script is not None:
        env["CLERK_SECRET_KEY"] = _FAKE_SECRET
        env["CLERK_SERVICE_ACCOUNT_USER_ID"] = _FAKE_USER
        if scenario != "domain-absent":
            env["CLERK_DOMAIN"] = _FAKE_DOMAIN
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": AUTHORIZED_DEPLOY}})
    proc = subprocess.run(
        [sys.executable, "-c", _MINT_DRIVER], input=payload,
        capture_output=True, text=True, timeout=15, env=env,
    )
    return proc.returncode, proc.stderr + proc.stdout


def _what_happened(out):
    match = re.search(r"What happened: (.*)\n", out)
    assert match, f"the refusal must carry a 'What happened:' line, out={out}"
    return match.group(1)


def _mint_failures():
    """Run all four scenarios; return {scenario: (rc, out, audit_entries)}."""
    results = {}
    for scenario in _MINT_SCENARIOS:
        log = _scratch_dir("audit-") / "audit.log"
        rc, out = _run_mint_failure(scenario, log)
        entries = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
        results[scenario] = (rc, out, entries)
    return results


def test_identity_failure_names_its_step():
    """The four mint failures must produce FOUR DIFFERENT operator-facing texts.

    Asserting that "a reason is printed" would pass against the version that
    collapsed all four into one sentence -- that is the defect restated. So the
    pole compares the four with each other, then checks each names its own step.
    """
    results = _mint_failures()
    whys = {scenario: _what_happened(out) for scenario, (_, out, _) in results.items()}
    assert len(set(whys.values())) == len(_MINT_SCENARIOS), (
        f"different failed steps collapsed into fewer distinct texts: {whys}"
    )
    for scenario, why in whys.items():
        assert _STEP_MARKER[scenario] in why, (
            f"{scenario!r} does not name its own step ({_STEP_MARKER[scenario]!r}): {why!r}"
        )
    for scenario, (_, out, entries) in results.items():
        assert _FAKE_SECRET not in out and _FAKE_USER not in out, (
            f"{scenario!r}: the refusal echoed a credential VALUE, out={out}"
        )
        assert entries and entries[-1]["detail"] == whys[scenario][:300], (
            f"{scenario!r}: the audit line must carry the same reason the operator read, "
            f"entries={entries}"
        )


def test_identity_failure_transport_error_names_its_exception():
    """A fifth ending: the mint call itself RAISES. It must be told apart from
    the four 'came back empty' steps, and must carry the exception, not hide it."""
    log = _scratch_dir("audit-") / "audit.log"
    _MINT_SCENARIOS["transport-raised"] = ["raise"]
    try:
        rc, out = _run_mint_failure("transport-raised", log)
    finally:
        del _MINT_SCENARIOS["transport-raised"]
    assert rc == 2, f"a raising mint must refuse, rc={rc} out={out}"
    why = _what_happened(out)
    assert "minting the service identity failed" in why and "OSError" in why, why
    assert _FAKE_SECRET not in out, f"the refusal echoed a credential VALUE, out={out}"


def test_identity_failure_is_refuse_to_judge_never_block():
    """A guard that could not identify itself has judged NOTHING. It must say so
    in the audit line, never as `block`: `block` means 'the token was read and
    does not authorise', which is false here."""
    for scenario, (_, out, entries) in _mint_failures().items():
        assert len(entries) == 1, f"{scenario!r}: expected one audit line, got {entries}"
        entry = entries[0]
        assert entry["verdict"] == "refuse-to-judge", (
            f"{scenario!r}: a mint failure must be refuse-to-judge, got {entry}"
        )
        assert entry["verdict"] != "block" and entry.get("reason") != "token-absent", entry
        assert "COULD NOT CHECK" in out and "BLOCKED:" not in out, (
            f"{scenario!r}: 'I could not check' must not read as 'not authorised', out={out}"
        )


def test_identity_failure_still_refuses():
    """The opposite defect, and the dangerous one: turning could-not-judge into
    allow. Every mint failure must exit 2 -- the only code that stops the tool."""
    for scenario, (rc, out, _) in _mint_failures().items():
        assert rc == 2, f"{scenario!r}: a mint failure must REFUSE (exit 2), rc={rc} out={out}"


def test_identity_failure_names_the_preminted_token_escape():
    """The refusal must tell the operator how to unblock a station whose Clerk
    path fails. The sentence is checked OUTSIDE the 'What happened' line: the
    credentials-absent reason names the variable in its own text, which would
    otherwise satisfy this pole even after the escape sentence was deleted."""
    for scenario, (_, out, _) in _mint_failures().items():
        remainder = out.replace(_what_happened(out), "")
        assert "VP_GUARD_CONVEX_TOKEN" in remainder, (
            f"{scenario!r}: the refusal no longer names the VP_GUARD_CONVEX_TOKEN "
            f"escape outside its reason line, out={out}"
        )


_URL_DRIVER = r"""
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("guard_under_domain_test", os.environ["MINT_TEST_HOOK"])
guard = importlib.util.module_from_spec(spec)
guard._TESTING = True
spec.loader.exec_module(guard)
answers = iter([{"token": "t"}, {"response": {"created_session_id": "s"}}, {"jwt": "j"}])
urls = []
def recording_post_json(url, payload, headers, *, form=None):
    urls.append(url)
    return next(answers)
guard._post_json = recording_post_json
token, why = guard.guard_identity()
print(json.dumps({"token": token, "why": why, "urls": urls}))
"""


def _identity_with(env_extra):
    env = dict(os.environ)
    for name in ("VP_GUARD_CONVEX_TOKEN", "CLERK_SECRET_KEY", "CLERK_SERVICE_ACCOUNT_USER_ID",
                 "CLERK_DOMAIN"):
        env.pop(name, None)
        env.pop(name + "_VANTAGE_PEERS", None)
    env.update({"VP_GUARD_ENV_FILE": "/nonexistent/hermetic/.env.local",
                "MINT_TEST_HOOK": str(HOOK)})
    env.update(env_extra)
    proc = subprocess.run([sys.executable, "-c", _URL_DRIVER], capture_output=True,
                          text=True, timeout=15, env=env)
    return json.loads(proc.stdout.strip().splitlines()[-1])


def test_ticket_is_redeemed_on_the_configured_domain():
    """The sign-in ticket must be redeemed on the instance the secret belongs to,
    read from configuration -- the project-suffixed name first, like the secret."""
    out = _identity_with({
        "CLERK_SECRET_KEY_VANTAGE_PEERS": _FAKE_SECRET,
        "CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS": _FAKE_USER,
        "CLERK_DOMAIN_VANTAGE_PEERS": _FAKE_DOMAIN + "/",
        "CLERK_DOMAIN": "https://bare-name-of-another-project.invalid",
    })
    assert out["token"] == "j", out
    assert out["urls"][1] == _FAKE_DOMAIN + "/v1/client/sign_ins", out["urls"]


def test_no_domain_means_no_clerk_call_and_no_default():
    """Without a configured domain the guard must not fall back to any instance:
    it makes no Clerk call at all and names the missing variable."""
    out = _identity_with({
        "CLERK_SECRET_KEY": _FAKE_SECRET,
        "CLERK_SERVICE_ACCOUNT_USER_ID": _FAKE_USER,
    })
    assert out["token"] is None and out["urls"] == [], out
    assert "CLERK_DOMAIN_VANTAGE_PEERS" in out["why"], out
    assert "accounts.dev" not in HOOK.read_text(), "a hardcoded Clerk instance domain is back"


# ---------------------------------------------------------------------------
# THE READ-ONLY MARKER COVERS READS ONLY (Pi ruling b, task k17chc5nf667yv5byc7dhp3y818ggxmx).
#
# Measured on the guard before this change: `npx convex import --prod x.jsonl
# # read-only-query: peek` -> rc=0 -- a prod WRITE admitted by a marker named
# "read-only". The marker now admits a prod READ and nothing the CLI itself
# defines as a write. `convex run` stays admitted: whether the function it
# runs is a query or a mutation cannot be decided from argv (declared).
# ---------------------------------------------------------------------------

_READS_UNDER_MARKER = [
    "npx convex data --prod leases # read-only-query: G3 count of leases",
    "npx convex logs --prod # read-only-query: read the boot line",
    "npx convex env list --prod # read-only-query: names only",
    "npx convex run --prod leases:list # read-only-query: G3 count",
    "npx convex env get FOO --prod # read-only-query: read one value",
    "npx convex function-spec --prod # read-only-query: list the functions",
    "npx convex insights --prod # read-only-query: read the insights",
]
_WRITES_UNDER_MARKER = [
    ("npx convex import --prod x.jsonl # read-only-query: peek", "import"),
    ("npx convex import --replace --prod x.jsonl # read-only-query: peek", "import"),
    ("npx convex env set FOO bar --prod # read-only-query: peek", "env set"),
    ("npx convex env remove FOO --prod # read-only-query: peek", "env remove"),
    ("npx convex deploy --yes # read-only-query: peek", "deploy"),
    # Eta #1535: aliases and verbs an open writer list missed (convex 1.42.1 cli/env.js:117
    # Command("remove").alias("rm").alias("unset")). The marker admits a CLOSED set of reads.
    ("npx convex env rm FOO --prod # read-only-query: peek", "env rm"),
    ("npx convex env unset FOO --prod # read-only-query: peek", "env unset"),
    ("npx convex deployment delete --prod # read-only-query: peek", "deployment delete"),
    ("npx convex env default set FOO bar --prod # read-only-query: peek", "env default set"),
    ("npx convex export --prod --path snap.zip # read-only-query: peek", "export"),
    ("npx convex some-future-verb --prod # read-only-query: peek", "unknown verb"),
]


def test_read_only_marker_admits_prod_reads():
    for command in _READS_UNDER_MARKER:
        rc, out = run_hook(command)
        assert rc == 0, f"a prod READ under the marker must pass: {command!r} rc={rc} out={out}"


def test_read_only_marker_never_admits_a_prod_write():
    for command, verb in _WRITES_UNDER_MARKER:
        rc, out = run_hook(command)
        assert rc == 2, f"a prod WRITE must be refused even with the marker: {command!r} rc={rc}"
        assert "BLOCKED" in out, out


def test_refusal_names_what_the_marker_covers():
    rc, out = run_hook("npx convex data --prod leases")
    assert rc == 2
    for verb in ("convex data", "convex logs", "convex env list", "convex run"):
        assert verb in out, f"the refusal must name {verb!r} as covered by the marker: {out}"
    assert "import" in out and "env set" in out and "env remove" in out, (
        f"the refusal must name the writes the marker never covers: {out}"
    )


# ---------------------------------------------------------------------------
# OFFLINE SIGNATURE (task k176yhdtn9kbht75skevmhgwn18fb6wp)
#
# The guard decides whether a prod deploy is authorised by verifying an Ed25519
# SIGNATURE locally. No network on the authorisation path: a third party being
# unreachable (or filtering our User-Agent) can never again be the reason the
# fleet cannot deploy.
#
# Every pole here runs the REAL hook with the network REMOVED: socket.connect,
# socket.create_connection, socket.getaddrinfo and urllib.request.urlopen all
# raise inside the hook's own process (see _NO_NETWORK_DRIVER), and every
# attempt is recorded so a test can assert there were ZERO. A pole that passes
# only because the network happened to answer would measure nothing.
#
# The three exits stay three, and each refusal is told apart by the audit
# line's `reason` (a bare rc==2 is the same bytes for all of them, which is the
# defect `refusal-is-distinguishable-from-absence.md` names):
#   allow            reason offline-signature-valid
#   block            reasons offline-signature-invalid / -expired / -unknown-issuer
#                    / -field-mismatch (with `field`)
#   refuse-to-judge  reason offline-signature-could-not-be-verified
# ---------------------------------------------------------------------------

import base64  # noqa: E402

_OFFLINE_NAME = "offline-test-123"
_OFFLINE_URL = f"https://{_OFFLINE_NAME}.convex.cloud"
_OFFLINE_TASK = "kofflinetesttoken0123456789abcdef"
_OFFLINE_OTHER_TASK = "kotherofflinetoken0123456789abcde"
_OFFLINE_DEPLOY = "npx convex deploy --yes"
SCRIPTS_DIR = HOOKS_DIR.parent / "scripts"
SIGNER = SCRIPTS_DIR / "sign-deploy-authorization.py"

_NO_NETWORK_DRIVER = r"""
import os, runpy, socket, sys, urllib.request
def _no(*args, **kwargs):
    with open(os.environ["OFFLINE_TEST_ATTEMPTS"], "a") as handle:
        handle.write("network attempted\n")
    raise OSError("network removed by the test")
socket.socket.connect = _no
socket.socket.connect_ex = _no
socket.create_connection = _no
socket.getaddrinfo = _no
urllib.request.urlopen = _no
sys.argv = [os.environ["OFFLINE_TEST_HOOK"]]
runpy.run_path(os.environ["OFFLINE_TEST_HOOK"], run_name="__main__")
"""

_OFFLINE_ENV_DROP = (
    "PI_AUTHORIZED_TASK_ID", "PI_AUTH_ORCHESTRATOR", "VP_GUARD_CONVEX_TOKEN",
    "VP_GUARD_ED25519_BACKEND", "CLERK_SECRET_KEY", "CLERK_SERVICE_ACCOUNT_USER_ID",
    "CLERK_DOMAIN",
)


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _canonical(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def _ed25519():
    sys.path.insert(0, str(HOOKS_DIR))
    from _lib import ed25519_offline  # noqa: PLC0415 - fails until the module exists
    return ed25519_offline


def _flip_payload_byte(fragments: str) -> str:
    """The same fragments with ONE byte of the signed payload changed.

    The byte is the first character of the signed floor, so the payload still
    parses as JSON: it is the SIGNATURE that must catch the change, not the parser."""
    _, _, rest = fragments.partition("# pi-auth-payload: ")
    encoded, _, tail = rest.partition(" ")
    raw = bytearray(_unb64u(encoded))
    raw[raw.index(b'"floor":"') + len(b'"floor":"')] ^= 0x01
    return f"# pi-auth-payload: {_b64u(bytes(raw))} {tail}"


@pytest.fixture
def offline_repo(tmp_path):
    """A throwaway git repository: `floor` is an ancestor of HEAD, HEAD is one commit later."""
    repo = tmp_path / "offline-repo"
    repo.mkdir()
    git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid",
           "-c", "commit.gpgsign=false", "-C", str(repo)]
    subprocess.run([*git, "init", "-q", "-b", "main"], check=True)
    (repo / "a.txt").write_text("one\n")
    subprocess.run([*git, "add", "a.txt"], check=True)
    subprocess.run([*git, "commit", "-q", "-m", "floor"], check=True)
    floor = subprocess.run([*git, "rev-parse", "HEAD"], capture_output=True, text=True,
                           check=True).stdout.strip()
    (repo / "a.txt").write_text("two\n")
    subprocess.run([*git, "commit", "-q", "-am", "head"], check=True)
    head = subprocess.run([*git, "rev-parse", "HEAD"], capture_output=True, text=True,
                          check=True).stdout.strip()
    return {"path": repo, "floor": floor, "head": head}


@pytest.fixture
def offline_key():
    return os.urandom(32)  # an Ed25519 seed


def _pub_b64(seed: bytes) -> str:
    return base64.b64encode(_ed25519().public_key(seed)).decode("ascii")


def _write_pubkeys(tmp_path, issuers, name="pubkeys.json"):
    path = tmp_path / name
    path.write_text(json.dumps(issuers))
    return path


def _payload(base_floor, **over):
    body = {
        "v": 1, "purpose": "PROD-DEPLOY-AUTHORIZED", "task": _OFFLINE_TASK,
        "floor": base_floor, "deployment": _OFFLINE_NAME, "issuer": "pi",
        "orchestrator": "sigma", "iat": int(time.time()),
    }
    body.update(over)
    return body


def _fragments(seed, payload, *, raw_payload=None, signing_seed=None):
    raw = raw_payload if raw_payload is not None else _canonical(payload)
    signature = _ed25519().sign(signing_seed or seed, raw)
    return f"# pi-auth-payload: {_b64u(raw)} # pi-auth-sig: {_b64u(signature)}"


def _run_offline(command, *, pubkeys, repo, tmp_path, extra_env=None, network_off=True):
    """Run the real hook, network removed, in the throwaway repository."""
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    env = {k: v for k, v in os.environ.items() if k not in _OFFLINE_ENV_DROP}
    attempts = tmp_path / "network-attempts.log"
    audit = tmp_path / "offline-audit.log"
    env.update({
        "VP_CONVEX_URL": _OFFLINE_URL,
        "VP_GUARD_ENV_FILE": "/nonexistent/hermetic/.env.local",
        "VP_GUARD_AUDIT_LOG": str(audit),
        "VP_GUARD_PUBKEYS_FILE": str(pubkeys),
        "OFFLINE_TEST_HOOK": str(HOOK),
        "OFFLINE_TEST_ATTEMPTS": str(attempts),
    })
    env.update(extra_env or {})
    argv = ([sys.executable, "-c", _NO_NETWORK_DRIVER] if network_off
            else [sys.executable, str(HOOK)])
    proc = subprocess.run(argv, input=payload, capture_output=True, text=True,
                          timeout=30, env=env, cwd=str(repo["path"]))
    entries = [json.loads(line) for line in audit.read_text().splitlines()] if audit.exists() else []
    return {
        "rc": proc.returncode, "out": proc.stderr + proc.stdout,
        "audit": entries[-1] if entries else {},
        "attempts": attempts.read_text() if attempts.exists() else "",
    }


def _signed_run(tmp_path, repo, seed, *, payload_over=None, command=_OFFLINE_DEPLOY,
                task=_OFFLINE_TASK, issuers=None, extra_env=None, raw_payload=None,
                signing_seed=None, mutate=None):
    payload = _payload(repo["floor"], **(payload_over or {}))
    fragments = _fragments(seed, payload, raw_payload=raw_payload, signing_seed=signing_seed)
    if mutate:
        fragments = mutate(fragments)
    pubkeys = _write_pubkeys(tmp_path, issuers if issuers is not None else {"pi": [_pub_b64(seed)]})
    full = f"{command} # pi-authorized: {task} {fragments}"
    return _run_offline(full, pubkeys=pubkeys, repo=repo, tmp_path=tmp_path, extra_env=extra_env)


# --- the measurement this task exists for -----------------------------------

def test_offline_signature_valid_token_allows_with_the_network_removed(
        tmp_path, offline_repo, offline_key):
    result = _signed_run(tmp_path, offline_repo, offline_key)
    assert result["rc"] == 0, result["out"]
    assert result["attempts"] == "", f"the auth path touched the network: {result['attempts']}"
    assert result["audit"].get("verdict") == "allow", result["audit"]
    assert result["audit"].get("reason") == "offline-signature-valid", result["audit"]
    assert result["audit"].get("task_id") == _OFFLINE_TASK
    assert result["audit"].get("issuer") == "pi"
    assert result["audit"].get("verifier") in ("cryptography", "pure-python"), result["audit"]


@pytest.mark.parametrize("backend", ["pure-python", "cryptography"])
def test_offline_signature_both_verifier_backends_allow_and_block_alike(
        tmp_path, offline_repo, offline_key, backend):
    """The audit line says WHICH verifier ran; both give the same verdicts."""
    if backend == "cryptography":
        pytest.importorskip("cryptography")
    env = {"VP_GUARD_ED25519_BACKEND": backend}
    ok = _signed_run(tmp_path, offline_repo, offline_key, extra_env=env)
    assert ok["rc"] == 0, ok["out"]
    assert ok["audit"].get("verifier") == backend, ok["audit"]
    bad = _signed_run(tmp_path, offline_repo, offline_key, extra_env=env, mutate=_flip_payload_byte)
    assert bad["rc"] == 2, bad["out"]
    assert bad["audit"].get("reason") == "offline-signature-invalid", bad["audit"]
    assert bad["audit"].get("verifier") == backend, bad["audit"]


def test_offline_signature_auto_backend_prefers_cryptography_when_importable(
        tmp_path, offline_repo, offline_key):
    pytest.importorskip("cryptography")
    ok = _signed_run(tmp_path, offline_repo, offline_key)
    assert ok["audit"].get("verifier") == "cryptography", ok["audit"]


# --- BLOCK poles: each says WHICH thing was wrong ---------------------------

def test_offline_signature_one_changed_payload_byte_blocks(tmp_path, offline_repo, offline_key):
    result = _signed_run(tmp_path, offline_repo, offline_key, mutate=_flip_payload_byte)
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("verdict") == "block"
    assert result["audit"].get("reason") == "offline-signature-invalid", result["audit"]
    assert "BLOCKED" in result["out"] and "signature" in result["out"].lower()


def test_offline_signature_signed_by_another_key_blocks(tmp_path, offline_repo, offline_key):
    result = _signed_run(tmp_path, offline_repo, offline_key, signing_seed=os.urandom(32))
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("verdict") == "block"
    assert result["audit"].get("reason") == "offline-signature-invalid", result["audit"]


def test_offline_signature_garbage_signature_blocks(tmp_path, offline_repo, offline_key):
    result = _signed_run(
        tmp_path, offline_repo, offline_key,
        mutate=lambda f: f.rsplit("# pi-auth-sig: ", 1)[0] + "# pi-auth-sig: AAAA")
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("reason") == "offline-signature-invalid", result["audit"]


def test_offline_signature_unknown_issuer_blocks_naming_it(tmp_path, offline_repo, offline_key):
    result = _signed_run(tmp_path, offline_repo, offline_key,
                         issuers={"eta": [_pub_b64(offline_key)]})
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("reason") == "offline-signature-unknown-issuer", result["audit"]
    assert "'pi'" in result["out"]


def test_offline_signature_rotation_second_listed_key_verifies(tmp_path, offline_repo, offline_key):
    retired = _pub_b64(os.urandom(32))
    result = _signed_run(tmp_path, offline_repo, offline_key,
                         issuers={"pi": [retired, _pub_b64(offline_key)]})
    assert result["rc"] == 0, result["out"]
    assert result["audit"].get("reason") == "offline-signature-valid", result["audit"]


def test_offline_signature_past_the_window_blocks_naming_age(tmp_path, offline_repo, offline_key):
    result = _signed_run(tmp_path, offline_repo, offline_key,
                         payload_over={"iat": int(time.time()) - 7200 - 120})
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("reason") == "offline-signature-expired", result["audit"]
    assert "age" in result["out"].lower() and "iat" in result["out"]
    assert result["audit"].get("age_sec", 0) >= 7200


def test_offline_signature_inside_the_window_still_allows(tmp_path, offline_repo, offline_key):
    """The window is the SAME length as before (TASK_TTL_SEC, 120 minutes)."""
    result = _signed_run(tmp_path, offline_repo, offline_key,
                         payload_over={"iat": int(time.time()) - 7100})
    assert result["rc"] == 0, result["out"]
    assert result["audit"].get("reason") == "offline-signature-valid", result["audit"]


def test_offline_signature_issued_in_the_future_blocks(tmp_path, offline_repo, offline_key):
    result = _signed_run(tmp_path, offline_repo, offline_key,
                         payload_over={"iat": int(time.time()) + 3600})
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("reason") == "offline-signature-expired", result["audit"]
    assert "future" in result["out"].lower()


@pytest.mark.parametrize("field,over,env", [
    ("floor", {"floor": "0" * 40}, None),
    ("deployment", {"deployment": "some-other-deployment-999"}, None),
    ("task", {"task": _OFFLINE_OTHER_TASK}, None),
    ("orchestrator", {"orchestrator": "eta"}, {"PI_AUTH_ORCHESTRATOR": "sigma"}),
])
def test_offline_signature_field_mismatch_blocks_naming_the_field(
        tmp_path, offline_repo, offline_key, field, over, env):
    result = _signed_run(tmp_path, offline_repo, offline_key, payload_over=over, extra_env=env)
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("reason") == "offline-signature-field-mismatch", result["audit"]
    assert result["audit"].get("field") == field, result["audit"]
    assert field in result["out"]


def test_offline_signature_deployment_is_read_from_an_inline_deploy_key(
        tmp_path, offline_repo, offline_key):
    """The command names a DIFFERENT deployment than the one signed -> BLOCK."""
    command = "CONVEX_DEPLOY_KEY='prod:another-deploy-456|secretvalue' npx convex deploy --yes"
    result = _signed_run(tmp_path, offline_repo, offline_key, command=command)
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("field") == "deployment", result["audit"]
    matching = f"CONVEX_DEPLOY_KEY='prod:{_OFFLINE_NAME}|secretvalue' npx convex deploy --yes"
    ok = _signed_run(tmp_path, offline_repo, offline_key, command=matching)
    assert ok["rc"] == 0, ok["out"]


def test_offline_signature_floor_given_to_the_deploy_script_must_match(
        tmp_path, offline_repo, offline_key):
    script = f".claude/scripts/convex-prod-deploy.sh {_OFFLINE_TASK}"
    wrong = f"{script} {'1' * 40} && {_OFFLINE_DEPLOY}"
    result = _signed_run(tmp_path, offline_repo, offline_key, command=wrong)
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("field") == "floor", result["audit"]
    right = f"{script} {offline_repo['floor']} && {_OFFLINE_DEPLOY}"
    ok = _signed_run(tmp_path, offline_repo, offline_key, command=right)
    assert ok["rc"] == 0, ok["out"]


def test_offline_signature_floor_must_be_an_ancestor_of_the_checkout(
        tmp_path, offline_repo, offline_key):
    """No floor in the command: the signed floor must be reachable from this checkout's HEAD."""
    unknown = _signed_run(tmp_path, offline_repo, offline_key, payload_over={"floor": "f" * 40})
    assert unknown["rc"] == 2, unknown["out"]
    assert unknown["audit"].get("field") == "floor", unknown["audit"]
    at_head = _signed_run(tmp_path, offline_repo, offline_key,
                          payload_over={"floor": offline_repo["head"]})
    assert at_head["rc"] == 0, at_head["out"]


def test_offline_signature_absent_marker_part_blocks_naming_it(tmp_path, offline_repo, offline_key):
    only_payload = _signed_run(
        tmp_path, offline_repo, offline_key,
        mutate=lambda f: f.rsplit("# pi-auth-sig: ", 1)[0])
    assert only_payload["rc"] == 2, only_payload["out"]
    assert only_payload["audit"].get("reason") == "offline-signature-invalid", only_payload["audit"]
    assert "pi-auth-sig" in only_payload["out"]
    only_sig = _signed_run(
        tmp_path, offline_repo, offline_key,
        mutate=lambda f: "# pi-auth-sig: " + f.rsplit("# pi-auth-sig: ", 1)[1])
    assert only_sig["rc"] == 2, only_sig["out"]
    assert only_sig["audit"].get("reason") == "offline-signature-invalid", only_sig["audit"]
    assert "pi-auth-payload" in only_sig["out"]


def test_offline_signature_payload_must_be_canonical(tmp_path, offline_repo, offline_key):
    """A validly SIGNED payload that is not the canonical form (spaces, unsorted) is refused."""
    loose = json.dumps(_payload(offline_repo["floor"]), sort_keys=False, indent=1).encode("utf-8")
    result = _signed_run(tmp_path, offline_repo, offline_key, raw_payload=loose)
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("reason") == "offline-signature-invalid", result["audit"]
    assert "canonical" in result["out"].lower()


def test_offline_signature_bad_signature_never_falls_back_to_the_network_path(
        tmp_path, offline_repo, offline_key):
    """A presented signature that fails decides alone: a good network token cannot rescue it."""
    with stub_vp({_OFFLINE_TASK: token_task()}) as url:
        pubkeys = _write_pubkeys(tmp_path, {"pi": [_pub_b64(offline_key)]})
        fragments = _fragments(offline_key, _payload(offline_repo["floor"]),
                               signing_seed=os.urandom(32))
        result = _run_offline(
            f"{_OFFLINE_DEPLOY} # pi-authorized: {_OFFLINE_TASK} {fragments}",
            pubkeys=pubkeys, repo=offline_repo, tmp_path=tmp_path, network_off=False,
            extra_env={"VP_CONVEX_URL": url, "VP_GUARD_CONVEX_TOKEN": "stub-identity"})
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("reason") == "offline-signature-invalid", result["audit"]


_PHASE_TWO_DRIVER = r"""
import importlib.util, os, sys, urllib.request
spec = importlib.util.spec_from_file_location("guard_phase_two", os.environ["OFFLINE_TEST_HOOK"])
guard = importlib.util.module_from_spec(spec)
guard._TESTING = True
spec.loader.exec_module(guard)
guard.NETWORK_AUTH_PATH_ENABLED = False
def _no(*args, **kwargs):
    with open(os.environ["OFFLINE_TEST_ATTEMPTS"], "a") as handle:
        handle.write("network attempted\n")
    raise OSError("network removed by the test")
urllib.request.urlopen = _no
sys.exit(guard.main(sys.stdin.read()))
"""


def test_offline_signature_switch_off_refuses_an_unsigned_token_without_touching_the_network(
        tmp_path, offline_repo, offline_key):
    """NETWORK_AUTH_PATH_ENABLED = False (phase 2): a bare `# pi-authorized:` is not enough."""
    attempts = tmp_path / "phase-two-attempts.log"
    audit = tmp_path / "phase-two-audit.log"
    env = {k: v for k, v in os.environ.items() if k not in _OFFLINE_ENV_DROP}
    env.update({
        "VP_CONVEX_URL": _OFFLINE_URL, "VP_GUARD_ENV_FILE": "/nonexistent/hermetic/.env.local",
        "VP_GUARD_AUDIT_LOG": str(audit), "OFFLINE_TEST_HOOK": str(HOOK),
        "OFFLINE_TEST_ATTEMPTS": str(attempts),
        "VP_GUARD_PUBKEYS_FILE": str(_write_pubkeys(tmp_path, {"pi": [_pub_b64(offline_key)]})),
    })
    payload = json.dumps({"tool_name": "Bash", "tool_input": {
        "command": f"{_OFFLINE_DEPLOY} # pi-authorized: {_OFFLINE_TASK}"}})
    proc = subprocess.run([sys.executable, "-c", _PHASE_TWO_DRIVER], input=payload,
                          capture_output=True, text=True, timeout=30, env=env,
                          cwd=str(offline_repo["path"]))
    assert proc.returncode == 2, proc.stderr
    assert not attempts.exists(), "the refusal touched the network"
    entry = json.loads(audit.read_text().splitlines()[-1])
    assert entry.get("verdict") == "block" and entry.get("reason") == "offline-signature-required", entry


# --- REFUSE TO JUDGE: the guard could not verify ---------------------------

@pytest.mark.parametrize("content", [
    "not json at all",
    json.dumps([1, 2]),
    json.dumps({"pi": "not-a-list"}),
    json.dumps({"pi": []}),
    json.dumps({"pi": ["!!!not-base64!!!"]}),
    json.dumps({"pi": [base64.b64encode(b"short").decode()]}),
    json.dumps({"pi": [42]}),
], ids=["not-json", "top-level-list", "value-not-list", "empty-key-list",
        "bad-base64", "wrong-key-length", "key-not-string"])
def test_offline_signature_malformed_pubkey_config_refuses_to_judge(
        tmp_path, offline_repo, offline_key, content):
    pubkeys = tmp_path / "broken.json"
    pubkeys.write_text(content)
    fragments = _fragments(offline_key, _payload(offline_repo["floor"]))
    result = _run_offline(f"{_OFFLINE_DEPLOY} # pi-authorized: {_OFFLINE_TASK} {fragments}",
                          pubkeys=pubkeys, repo=offline_repo, tmp_path=tmp_path)
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("verdict") == "refuse-to-judge", result["audit"]
    assert result["audit"].get("reason") == "offline-signature-could-not-be-verified"
    assert "COULD NOT CHECK" in result["out"], result["out"]


def test_offline_signature_absent_pubkey_config_refuses_to_judge(tmp_path, offline_repo, offline_key):
    fragments = _fragments(offline_key, _payload(offline_repo["floor"]))
    result = _run_offline(f"{_OFFLINE_DEPLOY} # pi-authorized: {_OFFLINE_TASK} {fragments}",
                          pubkeys=tmp_path / "does-not-exist.json", repo=offline_repo,
                          tmp_path=tmp_path)
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("verdict") == "refuse-to-judge", result["audit"]
    assert result["audit"].get("reason") == "offline-signature-could-not-be-verified"


def test_offline_signature_broken_verifier_refuses_to_judge(tmp_path, offline_repo, offline_key):
    result = _signed_run(tmp_path, offline_repo, offline_key,
                         extra_env={"VP_GUARD_ED25519_BACKEND": "no-such-backend"})
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("verdict") == "refuse-to-judge", result["audit"]
    assert result["audit"].get("reason") == "offline-signature-could-not-be-verified"
    assert "COULD NOT CHECK" in result["out"]


def test_offline_signature_not_a_git_checkout_refuses_to_judge_the_floor(
        tmp_path, offline_repo, offline_key):
    bare = tmp_path / "not-a-repo"
    bare.mkdir()
    result = _signed_run(tmp_path, {**offline_repo, "path": bare}, offline_key)
    assert result["rc"] == 2, result["out"]
    assert result["audit"].get("verdict") == "refuse-to-judge", result["audit"]
    assert result["audit"].get("reason") == "offline-signature-could-not-be-verified"


# --- the verifier itself: RFC 8032 vectors, both backends -------------------

_RFC8032 = [
    ("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
     "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
     "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
    ("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
     "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
     "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
    ("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
     "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
     "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"),
]
_L = 2**252 + 27742317777372353535851937790883648493


@pytest.mark.parametrize("backend", ["pure-python", "cryptography"])
@pytest.mark.parametrize("seed,public,message,signature", _RFC8032, ids=["rfc-1", "rfc-2", "rfc-3"])
def test_offline_signature_rfc8032_vectors_verify_on_every_backend(
        backend, seed, public, message, signature):
    if backend == "cryptography":
        pytest.importorskip("cryptography")
    lib = _ed25519()
    pub, msg, sig = bytes.fromhex(public), bytes.fromhex(message), bytes.fromhex(signature)
    ok, used = lib.verify(pub, msg, sig, backend=backend)
    assert ok is True and used == backend
    assert lib.verify(pub, msg + b"x", sig, backend=backend)[0] is False
    flipped = bytearray(sig)
    flipped[5] ^= 1
    assert lib.verify(pub, msg, bytes(flipped), backend=backend)[0] is False
    assert lib.verify(pub, msg, sig[:-1], backend=backend)[0] is False
    # a malleated S (S + L) satisfies the same equation and must be refused: S must be < L
    s_value = int.from_bytes(sig[32:], "little") + _L
    if s_value < 2**256:
        malleated = sig[:32] + s_value.to_bytes(32, "little")
        assert lib.verify(pub, msg, malleated, backend=backend)[0] is False


@pytest.mark.parametrize("backend", ["pure-python", "cryptography"])
@pytest.mark.parametrize("seed,public,message,signature", _RFC8032, ids=["rfc-1", "rfc-2", "rfc-3"])
def test_offline_signature_rfc8032_public_key_and_signature_derive_from_the_seed(
        backend, seed, public, message, signature):
    if backend == "cryptography":
        pytest.importorskip("cryptography")
    lib = _ed25519()
    assert lib.public_key(bytes.fromhex(seed), backend=backend).hex() == public
    assert lib.sign(bytes.fromhex(seed), bytes.fromhex(message), backend=backend).hex() == signature


def test_offline_signature_backends_agree_on_random_inputs():
    pytest.importorskip("cryptography")
    lib = _ed25519()
    for _ in range(20):
        seed, message = os.urandom(32), os.urandom(os.urandom(1)[0])
        pub, sig = lib.public_key(seed), lib.sign(seed, message)
        assert lib.verify(pub, message, sig, backend="pure-python")[0] is True
        assert lib.verify(pub, message, sig, backend="cryptography")[0] is True
        bad = bytearray(sig)
        bad[63 - (os.urandom(1)[0] % 31)] ^= 0x10
        assert lib.verify(pub, message, bytes(bad), backend="pure-python")[0] is False
        assert lib.verify(pub, message, bytes(bad), backend="cryptography")[0] is False


def test_offline_signature_unknown_backend_raises_instead_of_guessing():
    lib = _ed25519()
    with pytest.raises(lib.VerifierUnavailable):
        lib.verify(b"\0" * 32, b"", b"\0" * 64, backend="no-such-backend")


# --- the signing tool -------------------------------------------------------

def _run_signer(args, env_extra=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("DEPLOY_AUTHORITY_SIGNING_KEY")}
    env.update(env_extra or {})
    return subprocess.run([sys.executable, str(SIGNER), *args], capture_output=True, text=True,
                          timeout=30, env=env)


def test_offline_signature_signer_output_is_accepted_by_the_guard(
        tmp_path, offline_repo, offline_key):
    seed_b64 = base64.b64encode(offline_key).decode()
    proc = _run_signer(
        ["--issuer", "pi", "--task", _OFFLINE_TASK, "--floor", offline_repo["floor"],
         "--deployment", _OFFLINE_NAME, "--orchestrator", "sigma"],
        {"DEPLOY_AUTHORITY_SIGNING_KEY_PI": seed_b64})
    assert proc.returncode == 0, proc.stderr
    assert seed_b64 not in proc.stdout + proc.stderr, "the signer printed the private key"
    fragments = proc.stdout.strip()
    assert fragments.startswith("# pi-auth-payload: ") and "# pi-auth-sig: " in fragments
    pubkeys = _write_pubkeys(tmp_path, {"pi": [_pub_b64(offline_key)]})
    result = _run_offline(f"{_OFFLINE_DEPLOY} # pi-authorized: {_OFFLINE_TASK} {fragments}",
                          pubkeys=pubkeys, repo=offline_repo, tmp_path=tmp_path)
    assert result["rc"] == 0, result["out"]
    assert result["audit"].get("reason") == "offline-signature-valid", result["audit"]


def test_offline_signature_signer_refuses_without_the_injected_key(offline_repo):
    proc = _run_signer(["--issuer", "pi", "--task", _OFFLINE_TASK, "--floor", offline_repo["floor"],
                        "--deployment", _OFFLINE_NAME, "--orchestrator", "sigma"])
    assert proc.returncode != 0
    assert "DEPLOY_AUTHORITY_SIGNING_KEY_PI" in proc.stderr
    assert "infisical run" in proc.stderr


def test_offline_signature_signer_has_no_flag_that_takes_a_private_key():
    source = SIGNER.read_text()
    for forbidden in ("--private-key", "--seed", "--secret", "--key-file", "--signing-key"):
        assert forbidden not in source, f"signer accepts a key through {forbidden!r}"


def test_offline_signature_signer_rejects_a_short_floor(offline_key, offline_repo):
    proc = _run_signer(
        ["--issuer", "pi", "--task", _OFFLINE_TASK, "--floor", offline_repo["floor"][:12],
         "--deployment", _OFFLINE_NAME, "--orchestrator", "sigma"],
        {"DEPLOY_AUTHORITY_SIGNING_KEY_PI": base64.b64encode(offline_key).decode()})
    assert proc.returncode != 0
    assert "floor" in proc.stderr


def test_offline_signature_generate_keypair_prints_the_private_key_only_as_an_env_line():
    proc = _run_signer(["--generate-keypair", "--issuer", "pi"])
    assert proc.returncode == 0, proc.stderr
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    assert len(lines) == 1 and lines[0].startswith("DEPLOY_AUTHORITY_SIGNING_KEY_PI="), proc.stdout
    seed_b64 = lines[0].split("=", 1)[1]
    assert len(base64.b64decode(seed_b64)) == 32
    assert seed_b64 not in proc.stderr, "the private key leaked to stderr"
    public_b64 = base64.b64encode(_ed25519().public_key(base64.b64decode(seed_b64))).decode()
    assert public_b64 in proc.stderr, "the public key must be printed for the config"
    assert public_b64 not in proc.stdout


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
