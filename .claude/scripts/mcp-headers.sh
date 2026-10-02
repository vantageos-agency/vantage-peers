#!/usr/bin/env python3
"""headersHelper for this station's VantagePeers and VantageRegistry MCP servers.

Committed with the station's configuration so a rebuilt server recovers the wiring from git.
It carries NO secret: at connect time it reads the bearer and this station's agent credential
from 0600 files outside the repository (re-mintable), and prints the headers as JSON.
A missing file fails the connection loudly; there is no fallback to a shared identity.
"""
import json
import os
import sys

ROLE = "sigma"
SECRETS = os.environ.get("VP_AGENT_SECRETS_DIR", "/home/elpi/.vantage-agent-secrets")
BEARERS = {"vantage-peers": "vp-bearer", "vantage-registry": "vr-bearer"}


def read(name):
    path = os.path.join(SECRETS, name)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = handle.read().strip()
    except OSError as exc:
        sys.exit(f"mcp-headers: cannot read {path} ({type(exc).__name__})")
    if not value:
        sys.exit(f"mcp-headers: {path} is empty")
    return value


server = os.environ.get("CLAUDE_CODE_MCP_SERVER_NAME", "")
if server not in BEARERS:
    sys.exit(f"mcp-headers: unknown server {server!r}; expected one of {sorted(BEARERS)}")
bearer = read(BEARERS[server])
headers = {"Authorization": bearer if bearer.lower().startswith("bearer ") else "Bearer " + bearer}
if server == "vantage-peers":
    headers["x-vantage-agent-credential"] = read(f"{ROLE}.secret")
sys.stdout.write(json.dumps(headers))
