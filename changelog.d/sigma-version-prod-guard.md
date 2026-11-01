---
section: Changed
---
- **VantagePeers Cloud ops: the prod guard is versioned.** `.claude/scripts/convex-prod.sh`, `.claude/scripts/convex-prod-deploy.sh` and `.claude/scripts/convex-prod.allow` were station files outside git (root-owned on sigma-vps); they are committed with their current bytes, so the guard can be reviewed and reproduced. A separate commit admits two routine onboarding writes the backend owner runs for every client: `run oauth:upsertScopeProfile` (runbook onboard-client-org step 3) and `run agents:setAgentOwner` (step 4b). Task k17cz887yft38cv3cgttv9s1ys8hcy8x.
