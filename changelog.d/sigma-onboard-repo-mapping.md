---
section: Added
---
- **Onboarding routes the station repo.** `scripts/onboard-orchestrator.sh` takes `--repo <owner/repo> --project <slug>` and, through the new `scripts/add-repo-mapping.mjs`, upserts the `githubRepoMapping` row as the service account, then reads it back. The MCP mapping tools are disabled in prod and the org-admin JWT is refused, so this is the working path. Runbook section 7.
