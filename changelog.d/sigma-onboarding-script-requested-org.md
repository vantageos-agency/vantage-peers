---
section: Fixed
---
- **Client-org onboarding registers agents in the org you named.** `scripts/provision-client-org-agents.mjs` now mints the org-admin token for `--clerk-org-id` (active org set through Clerk, `convex` JWT template) and refuses with exit 1, naming both org ids and registering nothing, unless the token's `org_id` equals it. Before, it used the admin's last-active org, which registered `probe-a` into `probe-tenant-b` on dev. The script also prints the `agents:setAgentOwner` operator command (an internal mutation, so it cannot be called from the script); `runbooks/onboard-client-org.md` step 4b documents it. Tests: `scripts/__tests__/provision-client-org-agents.test.mjs`.
