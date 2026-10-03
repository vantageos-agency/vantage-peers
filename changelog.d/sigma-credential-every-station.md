---
section: Added
---
- **Fleet onboarding chain, written down.** `scripts/mint-station-agents.mjs` registers every station listed in `scripts/station-agents.fleet.json` as an agent of its organisation and mints its credential (values written only to `<secrets-dir>/<role>.secret`, mode 600, never printed); `scripts/prove-station-agent-credential.mjs` proves one station both ways (accepted with its credential, refused `AGENT_CREDENTIAL_REQUIRED` without). The secrets dir is refused when its REAL path lies inside the work tree (symlinks resolved, first segment tested). The two-station grok scripts it generalises are removed. Used on prod 2026-10-02: 38 stations, sweep 38/0.
