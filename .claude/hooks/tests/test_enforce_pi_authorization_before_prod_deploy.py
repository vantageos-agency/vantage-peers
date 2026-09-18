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
            value = tasks.get(body.get("args", {}).get("taskId"))
            out = json.dumps({"status": "success", "value": value}).encode()
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
        env = {"VP_CONVEX_URL": url}
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
    assert "task-unreadable-or-absent" in out


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
    """The fetch RAISES (an exception fetch_task does not swallow): the
    entrypoint must refuse a prod deploy rather than fall open."""
    rc, out = run_hook(
        f"npx convex deploy --yes # pi-authorized: {_ID_A}",
        {"VP_CONVEX_URL": "not-a-url"})
    assert rc == 2, f"a fetch that raises must refuse, rc={rc} out={out}"
    assert "could not run" in out


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
