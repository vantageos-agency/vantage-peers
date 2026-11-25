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


# ---------------------------------------------------------------------------
# VERSIONED / PATH-QUALIFIED HEADS and DECOY DEV HOSTS, per interpreter family
# (task k17bx73va6s36bg1qdqw0enjch8f97h2, review REVISE on PR #1768, head 48c5740a).
#
# 1. `python3.12 -c`, `/usr/bin/python3.14 -c`, `node22 -e` walked past the head test.
# 2. A dev host string in the SAME write segment certified the write as dev while the
#    URL came from an unresolved environment read (`os.environ['DEPLOY_HOST']`).
# ---------------------------------------------------------------------------
FAMILY_BLOCK_CASES = {
    "python_versioned_python3_12": (
        "python3.12 -c \"import os,urllib.request; urllib.request.urlopen("
        "os.environ['VP_CONVEX_URL'] + '/api/mutation', data=b'{}')\""
    ),
    "python_path_qualified_python3_14": (
        "/usr/bin/python3.14 -c \"import os,urllib.request; urllib.request.urlopen("
        "os.environ['VP_CONVEX_URL'] + '/api/mutation', data=b'{}')\""
    ),
    "node_versioned_node22": (
        "node22 -e \"fetch(process.env.VP_CONVEX_URL + '/api/mutation', "
        "{method:'POST', body:'{}'})\""
    ),
    "bun_versioned_bun1": (
        "bun1 -e \"fetch(process.env.VP_CONVEX_URL + '/api/mutation', {method:'POST'})\""
    ),
    "deno_versioned_deno2": (
        "deno2 eval \"fetch(Deno.env.get('VP_CONVEX_URL') + '/api/mutation', {method:'POST'})\""
    ),
    "ruby_versioned_ruby3_3": (
        "ruby3.3 -e \"require 'net/http'; Net::HTTP.post(URI(ENV['VP_CONVEX_URL'] + "
        "'/api/mutation'), '{}')\""
    ),
    "perl_versioned_perl5_38": (
        "perl5.38 -e 'use LWP::Simple; post($ENV{VP_CONVEX_URL} . \"/api/mutation\", \"{}\")'"
    ),
    "php_versioned_php8_3": (
        "php8.3 -r 'file_get_contents(getenv(\"VP_CONVEX_URL\") . \"/api/mutation\");'"
    ),
    "curl_path_qualified": (
        "/usr/bin/curl -X POST \"$VP_CONVEX_URL/api/mutation\" -d '{}'"
    ),
    "wget_versioned_wget2": (
        "wget2 --post-data='{}' \"$VP_CONVEX_URL/api/mutation\""
    ),
    "http_versioned_http2": (
        "http2 POST \"$VP_CONVEX_URL/api/mutation\" a=b"
    ),
    "python_decoy_dev_host_unresolved_env": (
        "python3 -c \"import os,urllib.request; d='https://fake-dev-y.convex.cloud'; "
        "urllib.request.urlopen(os.environ['DEPLOY_HOST'] + '/api/mutation', data=b'{}')\""
    ),
    "node_decoy_dev_host_unresolved_env": (
        "node -e \"const d='https://fake-dev-y.convex.cloud'; fetch(process.env.DEPLOY_HOST "
        "+ '/api/mutation', {method:'POST', body:'{}'})\""
    ),
    "bun_decoy_dev_host_unresolved_env": (
        "bun -e \"const d='https://fake-dev-y.convex.cloud'; fetch(process.env.DEPLOY_HOST "
        "+ '/api/mutation', {method:'POST'})\""
    ),
    "deno_decoy_dev_host_unresolved_env": (
        "deno eval \"const d='https://fake-dev-y.convex.cloud'; fetch(Deno.env.get('DEPLOY_HOST') "
        "+ '/api/mutation', {method:'POST'})\""
    ),
    "ruby_decoy_dev_host_unresolved_env": (
        "ruby -e \"d='https://fake-dev-y.convex.cloud'; require 'net/http'; "
        "Net::HTTP.post(URI(ENV['DEPLOY_HOST'] + '/api/mutation'), '{}')\""
    ),
    "perl_decoy_dev_host_unresolved_env": (
        "perl -e 'my $d=\"https://fake-dev-y.convex.cloud\"; use LWP::Simple; "
        "post($ENV{DEPLOY_HOST} . \"/api/mutation\", \"{}\")'"
    ),
    "php_decoy_dev_host_unresolved_env": (
        "php -r '$d=\"https://fake-dev-y.convex.cloud\"; "
        "file_get_contents(getenv(\"DEPLOY_HOST\") . \"/api/mutation\");'"
    ),
    "curl_decoy_dev_host_unresolved_var": (
        "curl -H 'X: https://fake-dev-y.convex.cloud' -X POST \"$DEPLOY_HOST/api/mutation\" -d '{}'"
    ),
    "wget_decoy_dev_host_unresolved_var": (
        "wget --header='X: https://fake-dev-y.convex.cloud' --post-data='{}' "
        "\"$DEPLOY_HOST/api/mutation\""
    ),
    "http_decoy_dev_host_unresolved_var": (
        "http --headers='X: https://fake-dev-y.convex.cloud' POST \"$DEPLOY_HOST/api/mutation\" a=b"
    ),
}

FAMILY_ALLOW_CASES = {
    "python_versioned_dev": (
        f"CONVEX_URL=https://{DEV_NAME}.convex.cloud python3.12 -c \"import os,urllib.request; "
        "urllib.request.urlopen(os.environ['CONVEX_URL'] + '/api/mutation', data=b'{}')\""
    ),
    "node_versioned_dev": (
        f"CONVEX_URL=https://{DEV_NAME}.convex.cloud node22 -e \"fetch(process.env.CONVEX_URL "
        "+ '/api/mutation', {method:'POST', body:'{}'})\""
    ),
    "ruby_versioned_dev": (
        f"CONVEX_URL=https://{DEV_NAME}.convex.cloud ruby3.3 -e \"require 'net/http'; "
        "Net::HTTP.post(URI(ENV['CONVEX_URL'] + '/api/mutation'), '{}')\""
    ),
    "curl_dev_inline": (
        f"CONVEX_URL=https://{DEV_NAME}.convex.cloud /usr/bin/curl -X POST "
        "\"$CONVEX_URL/api/mutation\" -d '{}'"
    ),
}


@pytest.mark.parametrize("name", sorted(FAMILY_BLOCK_CASES))
def test_versioned_head_or_decoy_dev_host_blocks(name, guard_env_file, tmp_path):
    rc, out = run(FAMILY_BLOCK_CASES[name], guard_env_file, tmp_path)
    assert rc == 2, f"{name}: expected BLOCK (exit 2), got {rc}. output: {out}"


@pytest.mark.parametrize("name", sorted(FAMILY_ALLOW_CASES))
def test_versioned_head_resolved_to_dev_passes(name, guard_env_file, tmp_path):
    rc, out = run(FAMILY_ALLOW_CASES[name], guard_env_file, tmp_path)
    assert rc == 0, f"{name}: expected ALLOW (exit 0), got {rc}. output: {out}"


# ---------------------------------------------------------------------------
# DECOY CLASS: the write's URL ARGUMENT decides, not the dev host in the segment
# (origin: task k179p2pkn0s9zgt6pdc5ps86wn8jw599, follow-up of PR #1768).
#
# A dev host string elsewhere in the segment certified a write whose URL came from
# a source the guard did not resolve. The reviewer's six cases, each run through
# the real hook with the prod host named by a variable, exit 0 on main and must exit 2.
# ---------------------------------------------------------------------------
PROD_URL = f"https://{PROD_LITERAL_NAME}.convex.cloud"
DEV_URL = f"https://{DEV_NAME}.convex.cloud"
PROD_STATION_ENV = {"VP_CONVEX_URL": PROD_URL, "CONVEX_DEPLOYMENT": f"dev:{DEV_NAME}"}

# origin k179p2pkn0s9zgt6pdc5ps86wn8jw599
DECOY_CLASS_BLOCK_CASES = {
    "python_auth_substring_authority_name": (
        "python3 -c \"d='https://fake-dev-y.convex.cloud'; import os,urllib.request; "
        "urllib.request.urlopen(os.environ['PROD_AUTHORITY']+'/api/mutation', data=b'{}')\"",
        {"PROD_AUTHORITY": PROD_URL},
    ),
    "python_auth_substring_key_name": (
        "python3 -c \"d='https://fake-dev-y.convex.cloud'; import os,urllib.request; "
        "urllib.request.urlopen(os.environ['MONKEY_URL']+'/api/mutation', data=b'{}')\"",
        {"MONKEY_URL": PROD_URL},
    ),
    "python_aliased_environ_from_import": (
        "python3 -c \"from os import environ as E; import urllib.request; "
        "d='https://fake-dev-y.convex.cloud'; "
        "urllib.request.urlopen(E['DEPLOY_HOST']+'/api/mutation', data=b'{}')\"",
        {"DEPLOY_HOST": PROD_URL},
    ),
    "node_destructured_process_env": (
        "node -e \"const {DEPLOY_HOST:h}=process.env; const d='https://fake-dev-y.convex.cloud'; "
        "fetch(h+'/api/mutation',{method:'POST'})\"",
        {"DEPLOY_HOST": PROD_URL},
    ),
    "pypy3_head_outside_interpreter_families": (
        "pypy3 -c \"import os,urllib.request; d='https://fake-dev-y.convex.cloud'; "
        "urllib.request.urlopen(os.environ['VP_CONVEX_URL']+'/api/mutation', data=b'{}')\"",
        {},
    ),
    "uv_run_python_head_outside_interpreter_families": (
        "uv run python -c \"import os,urllib.request; d='https://fake-dev-y.convex.cloud'; "
        "urllib.request.urlopen(os.environ['VP_CONVEX_URL']+'/api/mutation', data=b'{}')\"",
        {},
    ),
}


@pytest.mark.parametrize("name", sorted(DECOY_CLASS_BLOCK_CASES))
def test_decoy_dev_host_does_not_certify_the_url_argument(name, guard_env_file, tmp_path):
    """The URL ARGUMENT is judged; AUTH-named variables are excluded by name component."""
    command, env = DECOY_CLASS_BLOCK_CASES[name]
    rc, out = run(command, guard_env_file, tmp_path, extra_env={**PROD_STATION_ENV, **env})
    assert rc == 2, f"{name}: expected BLOCK (exit 2), got {rc}. output: {out}"


# Must-pass poles for the same class: a write whose URL argument resolves to DEV still passes.
DECOY_CLASS_ALLOW_CASES = {
    "dev_literal_mutation_with_auth_header_deploy_key": (
        f"curl -X POST -H \"Authorization: Bearer $CONVEX_DEPLOY_KEY\" "
        f"https://{DEV_NAME}.convex.cloud/api/mutation -d '{{}}'",
        {},
    ),
    "python_authority_name_resolving_to_dev": (
        "python3 -c \"import os,urllib.request; urllib.request.urlopen("
        "os.environ['PROD_AUTHORITY']+'/api/mutation', data=b'{}')\"",
        {"PROD_AUTHORITY": DEV_URL},
    ),
    "node_destructured_env_resolving_to_dev": (
        "node -e \"const {DEPLOY_HOST:h}=process.env; fetch(h+'/api/mutation',{method:'POST'})\"",
        {"DEPLOY_HOST": DEV_URL},
    ),
    "uv_run_python_inline_dev_write": (
        f"CONVEX_URL={DEV_URL} uv run python -c \"import os,urllib.request; "
        "urllib.request.urlopen(os.environ['CONVEX_URL']+'/api/mutation', data=b'{}')\"",
        {},
    ),
}


@pytest.mark.parametrize("name", sorted(DECOY_CLASS_ALLOW_CASES))
def test_decoy_class_dev_url_argument_passes(name, guard_env_file, tmp_path):
    command, env = DECOY_CLASS_ALLOW_CASES[name]
    rc, out = run(command, guard_env_file, tmp_path, extra_env=env)
    assert rc == 0, f"{name}: expected ALLOW (exit 0), got {rc}. output: {out}"


# Runner heads that name their program as the next word, and the PyPy family, in the
# decoy class (origin k179p2pkn0s9zgt6pdc5ps86wn8jw599). Each names a prod source in
# the URL argument and a dev decoy elsewhere in the segment.
HEAD_FAMILY_DECOY_CASES = {
    "poetry_run_python_decoy": (
        "poetry run python -c \"d='https://fake-dev-y.convex.cloud'; import os,urllib.request; "
        "urllib.request.urlopen(os.environ['PROD_AUTHORITY']+'/api/mutation', data=b'{}')\"",
        {"PROD_AUTHORITY": PROD_URL},
    ),
    "pipx_run_python_decoy": (
        "pipx run python -c \"d='https://fake-dev-y.convex.cloud'; import os,urllib.request; "
        "urllib.request.urlopen(os.environ['PROD_AUTHORITY']+'/api/mutation', data=b'{}')\"",
        {"PROD_AUTHORITY": PROD_URL},
    ),
    "uv_run_with_flag_before_python_decoy": (
        "uv run --with requests python -c \"d='https://fake-dev-y.convex.cloud'; import os,urllib.request; "
        "urllib.request.urlopen(os.environ['PROD_AUTHORITY']+'/api/mutation', data=b'{}')\"",
        {"PROD_AUTHORITY": PROD_URL},
    ),
    "npx_node_decoy": (
        "npx node -e \"const d='https://fake-dev-y.convex.cloud'; "
        "fetch(process.env.DEPLOY_HOST+'/api/mutation',{method:'POST'})\"",
        {"DEPLOY_HOST": PROD_URL},
    ),
    "npx_tsx_decoy": (
        "npx tsx -e \"const d='https://fake-dev-y.convex.cloud'; "
        "fetch(process.env.DEPLOY_HOST+'/api/mutation',{method:'POST'})\"",
        {"DEPLOY_HOST": PROD_URL},
    ),
    "pypy_literal_prod_mutation": (
        f"pypy -c \"import urllib.request; urllib.request.urlopen('{PROD_URL}/api/mutation', data=b'{{}}')\"",
        {},
    ),
}


@pytest.mark.parametrize("name", sorted(HEAD_FAMILY_DECOY_CASES))
def test_runner_and_pypy_heads_judge_the_url_argument(name, guard_env_file, tmp_path):
    command, env = HEAD_FAMILY_DECOY_CASES[name]
    rc, out = run(command, guard_env_file, tmp_path, extra_env={**PROD_STATION_ENV, **env})
    assert rc == 2, f"{name}: expected BLOCK (exit 2), got {rc}. output: {out}"
