---
section: Added
---
- **One-command orchestrator onboarding.** `scripts/onboard-orchestrator.sh <role> <workspace>` registers a new station as an agent of our org and mints its credential (0600 file, never on a command line). It installs the header helper, wires `vantage-peers` and `vantage-registry` into `.mcp.json`, marks the workspace trusted, pre-approves its servers in a gitignored `.claude/settings.local.json`, and clears the per-user needs-auth cache. It then creates the profile, so the station can receive messages, and proves the result (whoami as the role, a forged credential gets 401, `claude mcp list` shows Connected). Runbook: `runbooks/onboard-orchestrator.md`, with one section per trap met on 2026-10-05.
