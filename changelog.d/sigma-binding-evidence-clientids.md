---
section: Changed
---
- **`migrations/seat_binding_inventory:bindingEvidence` also lists, per profile, the clients that hold a live seat token.** `liveClientIds: [{ clientId, liveTokens }]` gives the distinct, non-secret `clientId`s of the profile's live (not revoked, not expired) seat tokens with a count each, so a client that `listClients` cannot attribute to the profile can be revoked with the existing `oauth:revokeAccessTokensOnly`, one client at a time. Person tokens stay excluded, a revoked or expired token's client is not listed, and no token value or hash is returned. Internal query, no public argument changed, backend contract stays 16. Task k177pske4qj37sfw7nw2787msd8fzp0e.
