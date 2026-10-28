# Personal agent (VantagePeers Cloud)

Product: VantagePeers Cloud (multi-tenant). Not applicable to Self-host.

A person who connects through the claude.ai connector holds a PERSON token and acts as the person
(`user:<Clerk user id>`). An operator can designate one agent of the person's organisation as that
person's personal agent. The person then acts as that agent on every tool call.

## Rule

A person token in organisation O acts as the agent whose `agents.personalAgentOf` equals the person's
Clerk user ID when EXACTLY ONE active agent of O designates that person.

| Situation | The person acts as |
|---|---|
| exactly one active designating agent in O | that agent (by ID) |
| none | the person |
| only inactive designating agents | the person |
| two or more active designating agents | the person (ambiguous; nothing picks one) |
| a designating agent in another organisation | never selected, never counted |
| the organisation is inactive, or the agent cannot be read | refused (`RBAC_DENIED`), not the person |

The decision is `resolvePersonalAgent` in `@vantageos/cloud-identity` (README, "The agent a person acts as").
Convex only supplies the by-ID reads (`convex/lib/personalAgent.ts`) and applies it in
`oauth:getAccessTokenByHash`; the MCP bearer middleware folds the result into `actor`
(`personalActorOf`, `mcp-server/src/auth.ts`; it only maps, the organisation is judged by ID in Convex).

The person keeps the person's organisation role: the writer-role gate still applies. A request that
presents an explicit agent credential acts as that credential's agent instead.

## Operator door

`agents:setPersonalAgentOf` is an internal mutation (no client can call it; same class as
`agents:setAgentOwner`). Run it with the Convex CLI against the intended deployment:

```
npx convex run agents:setPersonalAgentOf '{"agentId":"<agents id>","personId":"user_...","reason":"<at least 10 characters>"}'
npx convex run agents:setPersonalAgentOf '{"agentId":"<agents id>","personId":null,"reason":"<at least 10 characters>"}'
```

`personId` is the person's Clerk user ID (`user_` followed by letters and digits), never a name. `null`
clears. Refusals, all before any write: `PERSONAL_AGENT_PERSON_ID_INVALID`, `PERSONAL_AGENT_REASON_REQUIRED`,
`AGENT_NOT_FOUND`, `AGENT_INACTIVE`, `PERSONAL_AGENT_SERVICE_ACCOUNT`, `PERSONAL_AGENT_CONFLICT`
(the agent designates another person; pass `replace: true`), `PERSONAL_AGENT_AMBIGUOUS` (another active
agent of the same org already designates the person; clear it first).

## Rollout

Convex first, the MCP last (`.claude/rules/railway-mcp-redeploy.md`). The schema change is additive.
The designation takes effect on the person's next request (the lookup is made on every request).
