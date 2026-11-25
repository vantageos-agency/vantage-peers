"""Poles for the RUNTIME-ASSEMBLED Convex write vector of the prod-write guard.

enforce-pi-authorization-before-prod-deploy.py decided "is this a prod write"
from the LITERAL text `https://<name>.convex.cloud/api/mutation`. A write whose
URL is assembled at runtime (os.environ concatenation, an f-string, a variable
host, urljoin, node process.env, a split fragment) was waved through.

The predicate is now the ACTION: an HTTP client or interpreter whose text
reaches a Convex write surface. The TARGET is then resolved from what the
command names: a literal deployment host, a CONVEX_*URL reference (inline or
in the environment), the prod name, or the dev name in the station's
CONVEX_DEPLOYMENT. A write that does not resolve to DEV is refused.

Every pole runs the REAL hook through its stdin JSON payload.
"""
import json
import os
import pathlib
import subprocess
import sys

import pytest

HOOK = pathlib.Path(__file__).resolve().parent.parent / "enforce-pi-authorization-before-prod-deploy.py"

DEAD_URL = "http://127.0.0.1:9"
DEV_NAME = "fake-dev-y"
PROD_LITERAL_NAME = "fake-prod-x"


@pytest.fixture
def guard_env_file(tmp_path):
    """A dotenv that names ONE dev deployment, as a station's .env.local does."""
    path = tmp_path / "station.env"
    path.write_text(f"CONVEX_DEPLOYMENT=dev:{DEV_NAME}\n", encoding="utf-8")
    return path


def run(command, guard_env_file, tmp_path, extra_env=None):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    env = dict(os.environ)
    # HERMETIC: nothing from this station's shell or dotenv may decide a pole.
    for name in ("PI_AUTHORIZED_TASK_ID", "PI_AUTH_ORCHESTRATOR", "VP_GUARD_CONVEX_TOKEN",
                 "CONVEX_URL", "CONVEX_DEPLOYMENT", "CONVEX_DEPLOY_KEY", "CONVEX_SITE_URL"):
        env.pop(name, None)
    env["VP_CONVEX_URL"] = DEAD_URL
    env["VP_GUARD_ENV_FILE"] = str(guard_env_file)
    env["VP_GUARD_AUDIT_LOG"] = str(tmp_path / "audit.log")
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        [sys.executable, str(HOOK)], input=payload,
        capture_output=True, text=True, timeout=20, env=env,
    )
    return proc.returncode, proc.stderr + proc.stdout


# ---------------------------------------------------------------------------
# BLOCK poles: a runtime-assembled (or unresolvable) Convex write -> exit 2
# ---------------------------------------------------------------------------
BLOCK_CASES = {
    "python_concat_env_url": (
        'python3 -c \'import os,urllib.request; urllib.request.urlopen('
        'os.environ["CONVEX_URL"] + "/api/mutation", data=b"{}")\''
    ),
    "python_fstring_env_url": (
        'python3 -c "import os,urllib.request; urllib.request.urlopen('
        "f'{os.environ[\\\"CONVEX_URL\\\"]}/api/mutation', data=b'{}')\""
    ),
    "python_urljoin_env_base": (
        'python3 -c "import os,urllib.request; from urllib.parse import urljoin; '
        "urllib.request.urlopen(urljoin(os.environ['CONVEX_URL'], '/api/mutation'), data=b'{}')\""
    ),
    "shell_variable_host": (
        'H=https://fake-prod-x.convex.cloud; curl -X POST "$H/api/mutation" -d \'{}\''
    ),
    "shell_variable_host_dev_elsewhere": (
        f'H=https://{DEV_NAME}.convex.cloud; curl -X POST "$H/api/mutation" -d \'{{}}\''
    ),
    "node_process_env_concat": (
        "node -e \"fetch(process.env.CONVEX_URL + '/api/mutation', "
        "{method:'POST', body:'{}'})\""
    ),
    "node_process_env_action": (
        "node -e \"fetch(process.env.CONVEX_URL + '/api/action', {method:'POST', body:'{}'})\""
    ),
    "split_fragment_shell_quotes": (
        'curl -X POST "$CONVEX_URL/api/mut""ation" -d \'{}\''
    ),
    "inline_prod_env_then_curl": (
        f'CONVEX_URL=https://{PROD_LITERAL_NAME}.convex.cloud '
        'curl -X POST "$CONVEX_URL/api/mutation" -d \'{}\''
    ),
    "client_library_method_mutation": (
        "node -e \"new (require('convex/browser').ConvexHttpClient)(process.env.CONVEX_URL)"
        ".mutation('tasks:create', {})\""
    ),
    "unknown_endpoint_post_env": (
        'curl -X POST "$CONVEX_URL/api/run/tasks/create" -d \'{}\''
    ),
    "literal_prod_mutation_still_blocks": (
        f"curl -X POST https://{PROD_LITERAL_NAME}.convex.cloud/api/mutation -d '{{}}'"
    ),
    "dev_deploy_key_cannot_excuse_runtime_write": (
        "CONVEX_DEPLOY_KEY='dev:fake-dev-y|secret' npx convex deploy; "
        "python3 -c \"import os,urllib.request; urllib.request.urlopen("
        "os.environ['CONVEX_URL'] + '/api/mutation', data=b'{}')\""
    ),
    "read_only_marker_cannot_excuse_runtime_write": (
        "npx convex run --prod tasks:list; "
        "python3 -c \"import os,urllib.request; urllib.request.urlopen("
        "os.environ['CONVEX_URL'] + '/api/mutation', data=b'{}')\" "
        "# read-only-query: list the tasks"
    ),
}


@pytest.mark.parametrize("name", sorted(BLOCK_CASES))
def test_runtime_assembled_or_unresolvable_write_blocks(name, guard_env_file, tmp_path):
    rc, out = run(BLOCK_CASES[name], guard_env_file, tmp_path)
    assert rc == 2, f"{name}: expected BLOCK (exit 2), got {rc}. output: {out}"


# ---------------------------------------------------------------------------
# ALLOW poles: a write that resolves to DEV, and commands that write nothing
# ---------------------------------------------------------------------------
ALLOW_CASES = {
    "dev_inline_env_python_write": (
        f'CONVEX_URL=https://{DEV_NAME}.convex.cloud python3 -c "import os,urllib.request; '
        "urllib.request.urlopen(os.environ['CONVEX_URL'] + '/api/mutation', data=b'{}')\""
    ),
    "dev_inline_env_node_write": (
        f"CONVEX_URL=https://{DEV_NAME}.convex.cloud node -e \"fetch(process.env.CONVEX_URL "
        "+ '/api/mutation', {method:'POST', body:'{}'})\""
    ),
    "dev_literal_mutation": (
        f"curl -X POST https://{DEV_NAME}.convex.cloud/api/mutation -d '{{}}'"
    ),
    "read_query_env_url_is_not_a_write": (
        'curl -X POST "$CONVEX_URL/api/query" -d \'{}\''
    ),
    "read_query_literal_is_not_a_write": (
        f"curl https://{PROD_LITERAL_NAME}.convex.cloud/api/query"
    ),
    "interpreter_prints_env_writes_nothing": (
        'python3 -c "import os; print(os.environ.get(\'CONVEX_URL\'))"'
    ),
    "plain_interpreter_writes_nothing": 'python3 -c "print(1)"',
    "commit_message_prose_cites_the_write": (
        'git commit -m "docs: CONVEX_URL and the mutation path, see /api/mutation"'
    ),
    "echo_prose_with_literal_url_and_phrase": (
        f'echo "see https://{PROD_LITERAL_NAME}.convex.cloud/api/mutation for details"'
    ),
}


@pytest.mark.parametrize("name", sorted(ALLOW_CASES))
def test_dev_resolved_or_non_write_passes(name, guard_env_file, tmp_path):
    rc, out = run(ALLOW_CASES[name], guard_env_file, tmp_path)
    assert rc == 0, f"{name}: expected ALLOW (exit 0), got {rc}. output: {out}"


# ---------------------------------------------------------------------------
# HEREDOC BODIES that a program consumes AS CODE (task k17bx73va6s36bg1qdqw0enjch8f97h2).
# The body of `python3 - <<EOF` or `bash <<EOF` is the program the interpreter runs,
# not data; the guard used to strip it before any judgement.
# ---------------------------------------------------------------------------
HEREDOC_BLOCK_CASES = {
    "heredoc_fed_to_python_dash_runtime_write": (
        "python3 - <<'EOF'\n"
        "import os,urllib.request\n"
        "urllib.request.urlopen(os.environ['CONVEX_URL'] + '/api/mutation', data=b'{}')\n"
        "EOF"
    ),
    "heredoc_fed_to_python_bare_runtime_write": (
        "python3 <<'EOF'\n"
        "import os,urllib.request\n"
        "urllib.request.urlopen(os.environ['CONVEX_URL'] + '/api/mutation', data=b'{}')\n"
        "EOF"
    ),
    "heredoc_fed_to_bash_runtime_write": (
        "bash <<'EOF'\n"
        "curl -X POST \"$CONVEX_URL/api/mutation\" -d '{}'\n"
        "EOF"
    ),
    "dev_deploy_key_cannot_excuse_heredoc_write": (
        "CONVEX_DEPLOY_KEY='dev:fake-dev-y|secret' npx convex deploy; "
        "python3 - <<'EOF'\n"
        "import os,urllib.request\n"
        "urllib.request.urlopen(os.environ['CONVEX_URL'] + '/api/mutation', data=b'{}')\n"
        "EOF"
    ),
}

HEREDOC_ALLOW_CASES = {
    "heredoc_fed_to_python_dev_write": (
        "CONVEX_URL=https://fake-dev-y.convex.cloud python3 - <<'EOF'\n"
        "import os,urllib.request\n"
        "urllib.request.urlopen(os.environ['CONVEX_URL'] + '/api/mutation', data=b'{}')\n"
        "EOF"
    ),
    "heredoc_fed_to_python_read_only": (
        "python3 - <<'EOF'\n"
        "import os,urllib.request\n"
        "urllib.request.urlopen(os.environ['CONVEX_URL'] + '/api/query')\n"
        "EOF"
    ),
    "heredoc_consumed_as_data_by_cat": (
        "cat <<'EOF'\n"
        "curl -X POST $CONVEX_URL/api/mutation\n"
        "EOF"
    ),
}


@pytest.mark.parametrize("name", sorted(HEREDOC_BLOCK_CASES))
def test_heredoc_program_runtime_write_blocks(name, guard_env_file, tmp_path):
    rc, out = run(HEREDOC_BLOCK_CASES[name], guard_env_file, tmp_path)
    assert rc == 2, f"{name}: expected BLOCK (exit 2), got {rc}. output: {out}"


@pytest.mark.parametrize("name", sorted(HEREDOC_ALLOW_CASES))
def test_heredoc_dev_or_data_passes(name, guard_env_file, tmp_path):
    rc, out = run(HEREDOC_ALLOW_CASES[name], guard_env_file, tmp_path)
    assert rc == 0, f"{name}: expected ALLOW (exit 0), got {rc}. output: {out}"
