---
section: Security
---
- **Convex accepts the MCP-verified actor as a second proof (step i of 3).** The 14 doors that take `agentCredentialSecret` also take `verifiedActor: { agentId, orgSlug }`, trusted ONLY from the fleet service account (`masterSource "service-account"`; internal and operator-admin are refused `verified-actor-not-trusted`). The asserted name must resolve to that same agents row id; one proof per call (`AGENT_PROOF_CONFLICT`). Omission is still tolerated until step iii. Evidence: `convex/__tests__/verifiedActorProof.test.ts` 132/132, red 102/131 before.
