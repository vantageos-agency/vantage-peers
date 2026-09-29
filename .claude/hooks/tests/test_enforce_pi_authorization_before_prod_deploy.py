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
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

HOOK = pathlib.Path(__file__).resolve().parent.parent / "enforce-pi-authorization-before-prod-deploy.py"
HOOKS_DIR = HOOK.parent

# The token fetch NEVER leaves this machine in these tests. By default it is
# pointed at a closed loopback port (connection refused -> could-not-judge);
# the ALLOW poles point it at a local stub of `tasks:get` instead.
DEAD_URL = "http://127.0.0.1:9"


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
    env["VP_GUARD_AUDIT_LOG"] = os.path.join(tempfile.gettempdir(), "pi-auth-test-audit.log")
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


def test_expired_token_refused():
    rc, out = run_with_tasks(
        f"npx convex deploy --yes # pi-authorized: {_ID_A}",
        {_ID_A: token_task(age_sec=3601)})
    assert rc == 2, f"a token older than 60 minutes must be refused, rc={rc} out={out}"
    assert "task-invalid" in out


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
    tmp = tempfile.mkdtemp(prefix="pi-guard-degraded-")
    dest_hooks = pathlib.Path(tmp) / "hooks"
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
    env["VP_GUARD_AUDIT_LOG"] = os.path.join(tempfile.gettempdir(), "pi-auth-test-audit.log")
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
    log = pathlib.Path(tempfile.mkdtemp()) / "audit.log"
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

# What each scripted Clerk transport answers, in call order. A callable raises.
# None of these carries a bearer, so the ONLY thing that differs between the
# four scenarios is which step of the mint flow came back empty.
_MINT_SCENARIOS = {
    "credentials-absent": None,  # no Clerk call is ever made
    "no-sign-in-ticket": [{}],
    "no-session-from-exchange": [{"token": "t"}, {}],
    "no-jwt-for-template": [{"token": "t"}, {"response": {"created_session_id": "s"}}, {}],
}

# The word(s) that place each failure at its step. Distinctness is the pole;
# these keep a reworded reason from drifting away from the step it names.
_STEP_MARKER = {
    "credentials-absent": "no credential is reachable",
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
                 "CLERK_SECRET_KEY", "CLERK_SERVICE_ACCOUNT_USER_ID"):
        env.pop(name, None)
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
        log = pathlib.Path(tempfile.mkdtemp()) / "audit.log"
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
    assert len(set(whys.values())) == 4, (
        f"four different failed steps collapsed into fewer distinct texts: {whys}"
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
    log = pathlib.Path(tempfile.mkdtemp()) / "audit.log"
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
