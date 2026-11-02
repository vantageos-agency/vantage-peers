---
section: Fixed
---
- **VantagePeers Cloud: send_message refusals and missing-row errors carry their code.** The recipient bounce, the broadcast-reaches-nobody and the only-self refusals in `convex/messages.ts` were code-less ConvexErrors, and `deleteMessage` and `listBroadcastStatus` raised a bare `Error` (a bare "Server Error" to the client). They now raise `RBAC_DENIED` (recipient not addressable), `INVALID_RECIPIENTS` (no recipient / only self), and `MESSAGE_NOT_FOUND`; the text is unchanged and nobody is newly served or refused. The MCP `store_memory` and `send_message` failure logs now include the ConvexError `.data`. Task k1783jwzj5q67fycmtehzgjdw18hexvs.
