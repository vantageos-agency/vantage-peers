---
section: Changed
---
- **VantagePeers Cloud and Self-host: `get_issue` and `issue_stats` decide a master-only read before the read, not after it.** These two tools read fleet-master-only backend doors (`issues:getByRepoNumber`, `issues:getStats`). The caller's scope is now checked first: a caller who is not the fleet master gets the answer it got before and the door is never called; the fleet master is forwarded unchanged. Output for the fleet master is unchanged. Pinned by `mcp-server/test/s35-master-only-doors-pin.test.ts` (answers) and `mcp-server/test/s35-master-only-doors-no-door-call.test.ts` (no door call).
