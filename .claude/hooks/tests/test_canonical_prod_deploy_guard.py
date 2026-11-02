"""The canonical prod-deploy guard: one body for every fab1 station.

Task k1734bhdgzpr9njbbfp2f01hn58hff7p. The canonical body is the catalogue
copy (pipe / heredoc / process-substitution / command-string hardening) plus
this repo's two fixes: the Clerk domain is read from configuration with NO
default, and the `# read-only-query:` marker admits only a CLOSED set of reads.
CLERK_JWT_TEMPLATE is resolved like the domain; its default is the protocol
constant `convex` (the audience `convex/auth.config.ts` accepts).

Poles pinned here:
  (a) bipolar domain probe: the stale gamma line (`os.environ.get("CLERK_DOMAIN")
      or CLERK_DEFAULT_DOMAIN`) refuses to judge, the canonical line mints --
      SAME credential, SAME fake Clerk.
  (b) every carrier of a prod action is still blocked.
  (c) a Pi-authorized deploy is allowed with a valid (fake) minted identity.
  (d) the read-only marker admits only the closed read set.

Nothing leaves this machine: Clerk and the store are a scripted transport, the
credentials are placeholders, and no test prints a credential value.
"""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys

import pytest

HOOKS_DIR = pathlib.Path(__file__).resolve().parent.parent
HOOK = HOOKS_DIR / "enforce-pi-authorization-before-prod-deploy.py"
VP_IDENTITY = HOOKS_DIR / "_lib" / "vp_identity.py"
DEAD_URL = "http://127.0.0.1:9"

FAKE_SECRET = "sk_test_placeholder_never_a_real_secret"
FAKE_USER = "user_placeholder_service_account"
CONFIGURED_DOMAIN = "https://clerk.configured.invalid"
RETIRED_DOMAIN = "https://retired-dev-instance.clerk.accounts.invalid"
MINTED_JWT = "jwt-placeholder-minted-by-fake-clerk"
TOKEN_ID = "k" + "c" * 31
AUTHORIZED_DEPLOY = f"npx convex deploy --yes # pi-authorized: {TOKEN_ID}"

# The stale line as it stands in gamma-workspace (sha256 ae136fdc315f...), with
# the retired instance replaced by a placeholder. It is grafted onto the
# canonical body in place of the canonical resolution, so the ONLY difference
# between pole A and pole B is the domain line.
CANONICAL_DOMAIN_BLOCK_START = '    domain = (_credential("CLERK_DOMAIN") or "").rstrip("/")\n'
GAMMA_DOMAIN_LINE = f'    domain = os.environ.get("CLERK_DOMAIN") or "{RETIRED_DOMAIN}"\n'

_DRIVER = r"""
import json, os, sys, time, types
hook_path = os.environ["CANON_TEST_HOOK"]
source = open(hook_path).read()
graft = os.environ.get("CANON_TEST_GRAFT")
if graft:
    old, new = json.loads(graft)
    assert source.count(old) == 1, "graft anchor moved"
    source = source.replace(old, new)
guard = types.ModuleType("guard_under_canonical_test")
guard.__file__ = hook_path
guard._TESTING = True
sys.modules[guard.__name__] = guard
exec(compile(source, hook_path, "exec"), guard.__dict__)

configured = os.environ["CANON_TEST_DOMAIN"]
jwt = os.environ["CANON_TEST_JWT"]
token_id = os.environ["CANON_TEST_TOKEN_ID"]
calls = []

def fake_post_json(url, payload, headers, *, form=None):
    calls.append(url)
    if url.endswith("/sign_in_tokens"):
        return {"token": "ticket-placeholder"}
    if url.endswith("/v1/client/sign_ins"):
        # Only the instance the secret belongs to redeems the ticket; any other
        # instance answers what Clerk answers there: 401.
        if not url.startswith(configured + "/"):
            raise OSError("HTTP 401")
        return {"response": {"created_session_id": "sess-placeholder"}}
    if "/sessions/" in url and "/tokens/" in url:
        return {"jwt": jwt}
    if url.endswith("/api/query"):
        if headers.get("Authorization") != f"Bearer {jwt}":
            return {"status": "error", "errorMessage": "Server Error",
                    "errorData": "RBAC_DENIED: Missing scope for org null"}
        if payload.get("path") == "tasks:get":
            if payload.get("args", {}).get("taskId") != token_id:
                return {"status": "error", "errorMessage": "Server Error"}
            return {"status": "success", "value": {
                "title": "[PROD-DEPLOY-AUTHORIZED] deploy sigma", "tags": None,
                "createdAt": time.time() * 1000, "assignedTo": "sigma"}}
        return {"status": "success", "value": []}
    raise OSError("unexpected url in test transport")

guard._post_json = fake_post_json
mode = os.environ["CANON_TEST_MODE"]
if mode == "identity":
    token, why = guard.guard_identity()
    print(json.dumps({"minted": token == jwt, "token_is_none": token is None,
                      "why": why, "calls": calls}))
else:
    rc = guard.main(sys.stdin.read())
    print(json.dumps({"rc": rc, "calls": calls}))
    sys.exit(rc)
"""


def _base_env(tmp_path, extra=None):
    env = dict(os.environ)
    for name in ("PI_AUTHORIZED_TASK_ID", "PI_AUTH_ORCHESTRATOR", "VP_GUARD_CONVEX_TOKEN",
                 "CLERK_SECRET_KEY", "CLERK_SERVICE_ACCOUNT_USER_ID", "CLERK_DOMAIN",
                 "CLERK_JWT_TEMPLATE"):
        env.pop(name, None)
        env.pop(name + "_VANTAGE_PEERS", None)
    env.update({
        "VP_CONVEX_URL": DEAD_URL,
        "VP_GUARD_ENV_FILE": "/nonexistent/hermetic/.env.local",
        "VP_GUARD_AUDIT_LOG": str(tmp_path / "audit.log"),
    })
    env.update(extra or {})
    return env


# The station credential both poles of (a) share: project-suffixed names, as
# fab1 carries them. The bare CLERK_DOMAIN is ABSENT, which is exactly the
# shape on which the stale line falls through to its typed default.
SHARED_CREDENTIAL = {
    "CLERK_SECRET_KEY_VANTAGE_PEERS": FAKE_SECRET,
    "CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS": FAKE_USER,
    "CLERK_DOMAIN_VANTAGE_PEERS": CONFIGURED_DOMAIN,
}


def _drive(tmp_path, mode, credential, *, graft=None, command=AUTHORIZED_DEPLOY,
           vp_url="http://store.placeholder.invalid"):
    env = _base_env(tmp_path, credential)
    env.update({
        "VP_CONVEX_URL": vp_url,
        "CANON_TEST_HOOK": str(HOOK),
        "CANON_TEST_DOMAIN": CONFIGURED_DOMAIN,
        "CANON_TEST_JWT": MINTED_JWT,
        "CANON_TEST_TOKEN_ID": TOKEN_ID,
        "CANON_TEST_MODE": mode,
    })
    if graft:
        env["CANON_TEST_GRAFT"] = json.dumps(graft)
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run([sys.executable, "-c", _DRIVER], input=payload,
                          capture_output=True, text=True, timeout=30, env=env)
    lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("{")]
    assert lines, f"driver produced no result: rc={proc.returncode} err={proc.stderr[-800:]}"
    result = json.loads(lines[-1])
    result["stderr"] = proc.stderr
    for secret_value in (FAKE_SECRET, MINTED_JWT):
        assert secret_value not in proc.stderr, "a credential value reached operator text"
    return result


GAMMA_GRAFT = (CANONICAL_DOMAIN_BLOCK_START, GAMMA_DOMAIN_LINE)


# --- (a) bipolar domain probe ----------------------------------------------

def test_pole_a_gamma_line_refuses_to_judge_with_the_station_credential(tmp_path):
    ident = _drive(tmp_path, "identity", SHARED_CREDENTIAL, graft=GAMMA_GRAFT)
    assert ident["token_is_none"], ident
    assert any(c.startswith(RETIRED_DOMAIN) for c in ident["calls"]), ident["calls"]
    assert "HTTP 401" in ident["why"], ident
    run = _drive(tmp_path, "main", SHARED_CREDENTIAL, graft=GAMMA_GRAFT)
    assert run["rc"] == 2, run
    assert "COULD NOT" in run["stderr"].upper() or "could not" in run["stderr"], run["stderr"]


def test_pole_b_canonical_line_mints_with_the_same_credential(tmp_path):
    ident = _drive(tmp_path, "identity", SHARED_CREDENTIAL)
    assert ident["minted"], ident
    assert f"{CONFIGURED_DOMAIN}/v1/client/sign_ins" in ident["calls"], ident["calls"]
    assert not any(c.startswith(RETIRED_DOMAIN) for c in ident["calls"]), ident["calls"]


def test_graft_anchor_is_the_canonical_resolution():
    """Pole A is only a probe of the domain line if the graft replaces it."""
    text = HOOK.read_text()
    assert text.count(CANONICAL_DOMAIN_BLOCK_START) == 1
    for banned in ("CLERK_LIVE_FRONTEND", "CLERK_DEFAULT_DOMAIN", "clerk.vantagepeers.com",
                   "accounts.dev", "_frontend_domain", "vp_identity"):
        assert banned not in text, f"{banned!r} is back in the canonical hook"


# --- CLERK_JWT_TEMPLATE: resolved like the domain, protocol default named ---

def test_template_default_is_the_convex_audience(tmp_path):
    ident = _drive(tmp_path, "identity", SHARED_CREDENTIAL)
    assert any(c.endswith("/tokens/convex") for c in ident["calls"]), ident["calls"]
    auth_config = (HOOKS_DIR.parent.parent / "convex" / "auth.config.ts").read_text()
    assert 'applicationID: "convex"' in auth_config, "the protocol constant moved"


def test_template_project_suffixed_name_wins(tmp_path):
    cred = dict(SHARED_CREDENTIAL, CLERK_JWT_TEMPLATE_VANTAGE_PEERS="vp-template",
                CLERK_JWT_TEMPLATE="other-project-template")
    ident = _drive(tmp_path, "identity", cred)
    assert any(c.endswith("/tokens/vp-template") for c in ident["calls"]), ident["calls"]


def test_template_read_from_the_dotenv(tmp_path):
    dotenv = tmp_path / "guard.env"
    dotenv.write_text("CLERK_JWT_TEMPLATE_VANTAGE_PEERS=from-dotenv\n")
    cred = dict(SHARED_CREDENTIAL, VP_GUARD_ENV_FILE=str(dotenv))
    ident = _drive(tmp_path, "identity", cred)
    assert any(c.endswith("/tokens/from-dotenv") for c in ident["calls"]), ident["calls"]


# --- (b) MUST_BLOCK carriers stay blocked -------------------------------------

MUST_BLOCK = [
    "echo 'npx convex deploy --yes' | sh",
    "printf 'npx convex deploy --yes\\n' | bash",
    "bash <<'EOF'\nnpx convex deploy --yes\nEOF",
    "sh <<EOF\nnpx convex deploy --prod\nEOF",
    "bash <(echo 'npx convex deploy --yes')",
    "bash -c 'npx convex deploy --prod'",
    "su -c 'npx convex deploy --yes'",
    "npx convex env set FOO bar --prod",
    "npx convex deploy --yes",
    "npx convex deploy --yes # read-only-query: peek",
]


@pytest.mark.parametrize("command", MUST_BLOCK)
def test_carrier_without_token_is_blocked(tmp_path, command):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run([sys.executable, str(HOOK)], input=payload, capture_output=True,
                          text=True, timeout=15, env=_base_env(tmp_path))
    assert proc.returncode == 2, f"{command!r} passed: {proc.stderr}"


@pytest.mark.parametrize("command", MUST_BLOCK)
def test_carrier_is_blocked_even_with_a_valid_identity(tmp_path, command):
    """A minted identity does not substitute for a token."""
    run = _drive(tmp_path, "main", SHARED_CREDENTIAL, command=command)
    assert run["rc"] == 2, (command, run)


def test_unreadable_command_string_in_convex_context_is_blocked(tmp_path):
    command = 'CONVEX_DEPLOY_KEY=prod:x bash -c "$CMD"'
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run([sys.executable, str(HOOK)], input=payload, capture_output=True,
                          text=True, timeout=15, env=_base_env(tmp_path))
    assert proc.returncode == 2, proc.stderr


@pytest.mark.parametrize("command", [
    "echo hello | sh",
    "bash -c 'ls -la'",
    "grep -c 'convex deploy' notes.md",
])
def test_benign_carriers_stay_open(tmp_path, command):
    """The other pole: the carrier rules refuse a prod action, not a shell."""
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run([sys.executable, str(HOOK)], input=payload, capture_output=True,
                          text=True, timeout=15, env=_base_env(tmp_path))
    assert proc.returncode == 0, (command, proc.stderr)


# --- (c) a Pi-authorized deploy is allowed with a valid minted identity -----

def test_pi_authorized_deploy_allowed_with_minted_identity(tmp_path):
    run = _drive(tmp_path, "main", SHARED_CREDENTIAL)
    assert run["rc"] == 0, run
    assert any(c.endswith("/api/query") for c in run["calls"]), run["calls"]
    assert f"{CONFIGURED_DOMAIN}/v1/client/sign_ins" in run["calls"], run["calls"]


def test_pi_authorized_deploy_refused_when_identity_cannot_mint(tmp_path):
    cred = {k: v for k, v in SHARED_CREDENTIAL.items() if not k.startswith("CLERK_DOMAIN")}
    run = _drive(tmp_path, "main", cred)
    assert run["rc"] == 2, run
    assert not any("/v1/client/sign_ins" in c for c in run["calls"]), run["calls"]
    assert "CLERK_DOMAIN_VANTAGE_PEERS" in run["stderr"], run["stderr"]


def test_invented_token_refused_with_minted_identity(tmp_path):
    run = _drive(tmp_path, "main", SHARED_CREDENTIAL,
                 command="npx convex deploy --yes # pi-authorized: k" + "d" * 31)
    assert run["rc"] == 2, run


# --- (d) the read-only marker admits only the closed read set ---------------

@pytest.mark.parametrize("command", [
    "npx convex env remove FOO --prod # read-only-query: peek",
    "npx convex env rm FOO --prod # read-only-query: peek",
    "npx convex env unset FOO --prod # read-only-query: peek",
    "npx convex env set FOO bar --prod # read-only-query: peek",
    "npx convex env default set FOO bar --prod # read-only-query: peek",
    "npx convex deployment delete --prod # read-only-query: peek",
    "npx convex import --prod x.jsonl # read-only-query: peek",
    "npx convex export --prod # read-only-query: peek",
    "npx convex some-future-verb --prod # read-only-query: peek",
])
def test_marker_refuses_writes_and_unknown_verbs(tmp_path, command):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run([sys.executable, str(HOOK)], input=payload, capture_output=True,
                          text=True, timeout=15, env=_base_env(tmp_path))
    assert proc.returncode == 2, (command, proc.stderr)


@pytest.mark.parametrize("command", [
    "npx convex data --prod leases # read-only-query: count",
    "npx convex logs --prod # read-only-query: boot line",
    "npx convex env list --prod # read-only-query: names",
    "npx convex env get FOO --prod # read-only-query: one value",
    "npx convex function-spec --prod # read-only-query: spec",
    "npx convex insights --prod # read-only-query: insights",
    "npx convex run --prod leases:list # read-only-query: count",
])
def test_marker_admits_the_closed_read_set(tmp_path, command):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run([sys.executable, str(HOOK)], input=payload, capture_output=True,
                          text=True, timeout=15, env=_base_env(tmp_path))
    assert proc.returncode == 0, (command, proc.stderr)


# --- _lib/vp_identity.py carries the same resolution -----------------------

def _load_vp_identity():
    sys.path.insert(0, str(HOOKS_DIR))
    try:
        spec = importlib.util.spec_from_file_location("vp_identity_under_test", VP_IDENTITY)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(HOOKS_DIR))


@pytest.fixture
def vpi(monkeypatch):
    for name in ("VP_GUARD_CONVEX_TOKEN", "CLERK_SECRET_KEY", "CLERK_SERVICE_ACCOUNT_USER_ID",
                 "CLERK_DOMAIN", "CLERK_JWT_TEMPLATE"):
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name + "_VANTAGE_PEERS", raising=False)
    monkeypatch.setenv("VP_GUARD_ENV_FILE", "/nonexistent/hermetic/.env.local")
    module = _load_vp_identity()
    calls = []

    def fake_post_json(url, payload, headers, *, form=None, timeout=None):
        calls.append(url)
        if url.endswith("/sign_in_tokens"):
            return {"token": "t"}
        if url.endswith("/v1/client/sign_ins"):
            return {"response": {"created_session_id": "s"}}
        return {"jwt": "j"}

    def no_get(*_a, **_k):
        raise AssertionError("vp_identity must not discover a domain over the network")

    module.post_json = fake_post_json
    module.get_json = no_get
    module._calls = calls
    return module


def test_vp_identity_has_no_typed_domain(vpi):
    text = VP_IDENTITY.read_text()
    for banned in ("CLERK_LIVE_FRONTEND", "clerk.vantagepeers.com", "accounts.dev"):
        assert banned not in text, banned


def test_vp_identity_refuses_without_domain_and_calls_nothing(vpi, monkeypatch):
    monkeypatch.setenv("CLERK_SECRET_KEY_VANTAGE_PEERS", FAKE_SECRET)
    monkeypatch.setenv("CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS", FAKE_USER)
    token, why = vpi.guard_identity()
    assert token is None and vpi._calls == [], (token, vpi._calls)
    assert "CLERK_DOMAIN_VANTAGE_PEERS" in why and FAKE_SECRET not in why
    assert vpi._frontend_domain(FAKE_SECRET) is None, "old call signature must fail closed"


def test_vp_identity_reads_domain_and_template_like_the_secret(vpi, monkeypatch):
    monkeypatch.setenv("CLERK_SECRET_KEY_VANTAGE_PEERS", FAKE_SECRET)
    monkeypatch.setenv("CLERK_SERVICE_ACCOUNT_USER_ID_VANTAGE_PEERS", FAKE_USER)
    monkeypatch.setenv("CLERK_DOMAIN_VANTAGE_PEERS", CONFIGURED_DOMAIN + "/")
    monkeypatch.setenv("CLERK_DOMAIN", "https://bare-name-of-another-project.invalid")
    token, why = vpi.guard_identity()
    assert token == "j", why
    assert vpi._calls[1] == f"{CONFIGURED_DOMAIN}/v1/client/sign_ins", vpi._calls
    assert vpi._calls[2].endswith("/tokens/convex"), vpi._calls
    monkeypatch.setenv("CLERK_JWT_TEMPLATE_VANTAGE_PEERS", "vp-template")
    vpi._calls.clear()
    vpi.guard_identity()
    assert vpi._calls[2].endswith("/tokens/vp-template"), vpi._calls


def test_hook_and_vp_identity_agree_on_the_template_default(vpi):
    spec = importlib.util.spec_from_file_location("guard_for_constant", HOOK)
    guard = importlib.util.module_from_spec(spec)
    guard._TESTING = True
    spec.loader.exec_module(guard)
    assert guard.CLERK_JWT_TEMPLATE_DEFAULT == vpi.CLERK_JWT_TEMPLATE_DEFAULT == "convex"
