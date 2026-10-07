---
section: Security
---
- **A connector's agent refusal is pinned at the layer that raises it, and a forwarded seat org now binds a `verifiedActor`.** `messages:sendMessage` passes the seat org it was given as the call's declared org, so a `verifiedActor` of another organisation is refused `ORG_MISMATCH` (it was accepted when the call named no `tenantId`). Pole tests: `mcp-server/test/connector-agent-identity.test.ts` (which OAuth tokens may name an agent: single-name seat yes; person, org-wide, empty allowlist no) and `convex/lib/auth.test.ts` "connector agent credential".
