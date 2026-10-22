#!/usr/bin/env python3
"""Write one station's agent credential to the Infisical vault, then prove it by readback.

Usage: vault-put-agent-secret.py --role <role> --secret-file <path> --config <path> [--host <hostname>]

The secret is read from a file the caller keeps on memory-backed storage; it never reaches argv,
stdout, stderr or disk. Config, API base checks, identity file reading and the host to slug
mapping come from the shared helper mcp_headers_vault.py (VP_VAULT_HELPER, default
/opt/vantage-secrets/mcp_headers_vault.py), so the write path and the read path cannot drift.
The vault location is /agent-secrets/<slug>, key <ROLE>_SECRET. Every failure is one stderr line
and exit 1, naming what failed and never a value.
"""
import argparse
import hashlib
import hmac
import importlib.util
import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

HELPER = os.environ.get("VP_VAULT_HELPER", "/opt/vantage-secrets/mcp_headers_vault.py")


def fail(msg):
    sys.stderr.write(f"vault-put-agent-secret: {msg}\n")
    sys.exit(1)


def load_helper():
    try:
        spec = importlib.util.spec_from_file_location("mcp_headers_vault", HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception as exc:
        fail(f"cannot load shared helper {HELPER} ({type(exc).__name__})")
    return module


def request(base, method, path, label, body=None, token=None, allow_404=False):
    headers = {"User-Agent": "curl/8", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        if allow_404 and exc.code == 404:
            return None
        fail(f"{label} failed (HTTP {exc.code})")
    except Exception as exc:
        fail(f"{label} failed ({type(exc).__name__})")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role", required=True)
    parser.add_argument("--secret-file", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--host", default=None)
    args = parser.parse_args()

    try:
        with open(args.secret_file, encoding="utf-8") as handle:
            value = handle.read().strip()
    except OSError as exc:
        fail(f"cannot read secret file ({type(exc).__name__})")
    if not value:
        fail("secret file is empty")

    vault = load_helper()
    host = args.host or socket.gethostname()
    base, project, environment, slug, env_file = vault.load_config(args.config, host)
    suffix = slug.upper().replace("-", "_")
    login = request(base, "POST", "/v1/auth/universal-auth/login", "login",
                    {"clientId": vault.read_env(env_file, f"INFISICAL_UNIVERSAL_AUTH_CLIENT_ID_{suffix}"),
                     "clientSecret": vault.read_env(env_file, f"INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET_{suffix}")})
    token = login.get("accessToken")
    if not token:
        fail("login returned no token")

    folder = f"/agent-secrets/{slug}"
    key = f"{args.role.upper()}_SECRET"
    where = f"{folder}/{key}"
    query = urllib.parse.urlencode({"workspaceId": project, "environment": environment, "secretPath": folder})
    path = f"/v3/secrets/raw/{key}"
    existing = request(base, "GET", f"{path}?{query}", f"read {where}", token=token, allow_404=True)
    body = {"workspaceId": project, "environment": environment, "secretPath": folder,
            "secretValue": value, "type": "shared"}
    request(base, "PATCH" if existing else "POST", path, f"write {where}", body, token)

    back = request(base, "GET", f"{path}?{query}", f"read back {where}", token=token)
    got = (back.get("secret") or {}).get("secretValue", "")
    if not hmac.compare_digest(hashlib.sha256(got.encode()).digest(), hashlib.sha256(value.encode()).digest()):
        fail(f"readback of {where} does not match what was written")
    sys.stdout.write(f"vault: {where} written and verified by hash\n")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as exc:
        fail(f"unexpected {type(exc).__name__}")
