---
section: Fixed
---
- **`invite-client-people` invitations land on the sign-up page (Cloud; task k172sk173z6mw5cfc5refy1pz18hgaqa).** The Clerk invitation body now always carries `redirect_url`: the account-portal sign-up page derived from `CLERK_DOMAIN` (`clerk.<domain>` -> `https://accounts.<domain>/sign-up`, shared with `onboard-person` through `accountPortalSignUp`) or `--redirect-url`; the frontend-API host is refused and the dry run prints the landing page before anything is sent. Before, no redirect was set. Tests: `scripts/__tests__/invite-client-people.test.ts` (3).
