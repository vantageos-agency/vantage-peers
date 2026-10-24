#!/usr/bin/env bash
# headersHelper for this station's VantagePeers and VantageRegistry MCP servers.
# It carries no secret and reads no credential file: it relays to the shared vault helper, which
# reads this station's bearer and agent credential from Infisical at connect time and prints the
# headers as JSON. A failure exits non-zero with one line naming what could not be read; there is
# no fallback to a plaintext directory.
# Rollback: git history of this file; the host keeps the pre-vault copy under /opt/vantage-secrets/rollback/.
exec python3 /opt/vantage-secrets/mcp_headers_vault.py --role sigma --config /opt/vantage-secrets/infisical-hosts.json
