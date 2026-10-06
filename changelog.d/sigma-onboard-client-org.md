---
section: Added
---
- **Client organisations onboard by runbook.** `runbooks/onboard-client-org.md` with `scripts/provision-client-org-agents.mjs` (seat bearer and agent credential per agent, registered by ID in the client org), `scripts/client-agent-set-profile.mjs` (profile row so the agent can receive messages) and `scripts/prove-cgt-agents.mjs` (whoami in org, memory round-trip, sibling message, cross-org write and read refused). First use: CGT Alsachimie (neo, hal, mimir), 15/15 on prod.
