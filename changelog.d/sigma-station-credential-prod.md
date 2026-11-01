---
section: Fixed
---
- **VantagePeers Cloud station onboarding can mint a credential on prod.** `scripts/mint-station-agents.mjs` and `scripts/add-repo-mapping.mjs` authenticated with a Clerk native session token (no `aud`), which prod Convex rejects with `NoAuthProvider`; the org-admin token also named the shared admin user's last-active org instead of our own. Both now use `convex`-template tokens, the org-admin token is minted for our org by its Clerk id (`CLERK_ORG_ID`, verified with `assertTokenOrg`, `ORG_MISMATCH` otherwise), and both refuse to run without `CLERK_DOMAIN` (no dev-instance fallback). Station credentials are written to the Infisical vault at `/agent-secrets/<host-slug>/<ROLE>_SECRET` (Pi's vault onboarding, cherry-picked). Task k177034bdx6cqb82grpc862pw58hckgk.
