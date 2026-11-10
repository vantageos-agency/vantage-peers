---
section: Fixed
---
- **A person's invitation lands on the sign-up page, not a 404.** `scripts/onboard-person.mjs` derived its default redirect as `<CLERK_DOMAIN>/sign-up`, the Clerk frontend-API host, which answers 404 there (measured on `clerk.vantagepeers.com`, 2026-11-10). The default is now the account portal derived from it (`clerk.<domain>` -> `https://accounts.<domain>/sign-up`, the hosted page that consumes `__clerk_ticket`); a `CLERK_DOMAIN` that does not start with `clerk.` is refused rather than guessed, and a redirect on a `clerk.` host, passed or from `ONBOARD_REDIRECT_URL`, is refused. The runbook `onboard-client-org.md` says the same. Task k172sk173z6mw5cfc5refy1pz18hgaqa.
