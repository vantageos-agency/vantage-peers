---
section: Security
---
- **The station MCP helper reads its credentials from the vault.** `.claude/scripts/mcp-headers.sh` used to read the bearer and the agent credential from `/home/elpi/.vantage-agent-secrets`, a plaintext directory that has since been purged on both hosts. It now relays to the shared Infisical helper (`/opt/vantage-secrets/mcp_headers_vault.py --role sigma`), which reads both at connect time and has no fallback to files. `scripts/prove-cgt-agents.mjs` no longer has a built-in credential directory: `--secrets-dir` is required and names the client organisation's own store, and `runbooks/onboard-client-org.md` passes it. Task k175hssw4dxw8yc030r1d6cym58gwmfw.
