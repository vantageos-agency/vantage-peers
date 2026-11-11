---
section: Added
---
- **`onboard-person` returns the welcome email to send (Cloud; task k172sk173z6mw5cfc5refy1pz18hgaqa).** The result gains `welcomeEmail` (`subject`, `text`) in the person's `--lang` (fr or en): the single-use invitation link, then per agent the steps of its assistant (Claude plugin, ChatGPT and Grok labels from the connect page, and the Claude Free one-connector note from the runbook; any other assistant gets the MCP URL and the connect page, never an invented screen), the consent choice, the check sentence and the first-steps page. Names keep their accents (NFC). An invitation URL on the Clerk frontend-API host is refused. The script still sends no mail. Tests: `scripts/__tests__/welcome-email.test.ts` (8), `scripts/__tests__/onboard-person.test.ts` (+1).
