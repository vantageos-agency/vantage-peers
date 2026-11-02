---
section: Security
---
- **VantagePeers Cloud: a one-agent seat token resolves its agent only by the agent ID its scope profile carries (identity-by-id M3).** `resolveSeatAgent` (`convex/lib/seatAgent.ts`) no longer looks an agent up by the profile's allowlisted label or by the `<agent>-<org>` profileId convention: a profile with no `agentId` resolves no agent and its tokens stay org-level until an operator binds the profile with `oauth:bindScopeProfileAgent`, and a same-named agent can never take the bound agent's place. The token's own label list no longer takes part in the decision. Pinned by `convex/__tests__/seatAgentById.test.ts` (REFUSED, PRESENT and ABSENT poles).
