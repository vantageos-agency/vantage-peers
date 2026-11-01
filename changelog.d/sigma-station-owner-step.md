---
section: Fixed
---
- **VantagePeers Cloud: a freshly onboarded station is no longer left unusable.** `scripts/mint-station-agents.mjs` and `scripts/onboard-orchestrator.sh` registered and credentialed the agent but never set `agents.ownerPersonId`, so every call answered `AGENT_CREDENTIAL_INVALID` (`whoami` 401 "agent with no live member owner"). They now end with `OWNER_STEP_REQUIRED` and the exact `agents:setAgentOwner` operator command (the mutation is internal), the wrapper exits 3 until the step is done, and an agent that already has an owner skips it. `runbooks/onboard-orchestrator.md` section 1b. Task k177034bdx6cqb82grpc862pw58hckgk.
