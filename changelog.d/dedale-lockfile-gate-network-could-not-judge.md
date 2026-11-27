---
section: Fixed
---
- **VantagePeers Cloud and Self-host: the isolated-lockfile gate names a registry outage as could-not-judge, not a stale lockfile.** `scripts/__tests__/generated-and-lockfile-gates.test.mjs` now tells a stale `bun.lock`, an unreachable npm registry (refused, DNS, timeout) and an unrecognised bun failure apart; every non-zero outcome stays RED, but only a stale lockfile tells the reader to regenerate it (task k17d7q6ab53wz1x39z8tnjnz0s8jxm5r).
