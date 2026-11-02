---
section: Changed
---
- **VantagePeers Cloud ops: the prod guard admits a read of `oauth_refresh_tokens`.** `.claude/scripts/convex-prod.allow` gains `data oauth_refresh_tokens` (read-only), to name why a client token family stopped renewing; the reader masks hashes, never prints them. Task k174gya0rabxybw3xa2vw8va358hc2xa.
