---
section: Security
---
- **MCP is strict for fleet callers: the master bearer can no longer act under a typed name.** A request on the HTTP master bearer (the fleet service account) that names an acting agent (`callerOrchestrator`, or a `from`-kind key such as `createdBy`) without the `x-vantage-agent-credential` header is refused with `AGENT_CREDENTIAL_REQUIRED` naming the header, whatever `VANTAGE_ACTOR_CREDENTIAL_MODE` says (the default lives in code, not in a Railway variable). With a valid header the call is served and the name must equal the resolved agent. Customer OAuth clients and the local stdio trust context are unchanged. `whoami` now returns `actor: { agentName, orgSlug } | null`, never the secret. Tests: `mcp-server/test/master-bearer-strict-actor.test.ts`.
