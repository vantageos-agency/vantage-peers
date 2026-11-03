# probe-person onboarding: screen labels (task k177e8dyrnykk3c56yf2b0pgfs8hhz06)

Status: BLOCKED at the first screen. Steps 2-5 not run.

## Screen 0: accounts.vantagepeers.com/sign-up (headless chromium, measured 2026-11-03 18:29 UTC)
Cloudflare managed challenge, HTTP 403, `cf-mitigated: challenge`, before any Clerk page renders.
Screenshot: 00-cloudflare-challenge.png
Labels, in order:
1. "accounts.vantagepeers.com" (title)
2. "Performing security verification"
3. "This website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot."
4. Checkbox "Verify you are human" (Cloudflare Turnstile widget; Privacy, Help)
5. "Ray ID: a54d722c5f451c6d"; "Performance and Security by Cloudflare"

Page title: "Just a moment...". The widget did not resolve after 15 s in headless chromium; it needs a human click.
Same 403 + challenge from curl on the clerk.vantagepeers.com ticket-accept URL (redirects to accounts.*).
Not worked around on purpose (no stealth flags, no challenge solving).
