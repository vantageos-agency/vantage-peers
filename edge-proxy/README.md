# edge-proxy

Rate-limit proxy in front of the VantagePeers Cloud MCP. Node, `node:http`, no runtime dependency.

- Limits per 60 s on `GET|HEAD /authorize` and `POST /token` only: 20 per IPv4 /32 or IPv6 /64, 60 per IPv4 /24 or IPv6 /48, 200 per IPv6 /32. Over the limit: 429 + `Retry-After`, no upstream call. Every other path passes straight through.
- Client address: the header named by `CLIENT_IP_HEADER` (default `x-real-ip`), set by the Railway edge; a client-sent value of any other header is never used. Forwarded to the MCP in one header, `x-vp-edge-client` = `<ip>|<unix s>|<hex HMAC-SHA256 of "v1|ip|s">`, signed under `EDGE_PROXY_HMAC_SECRET`. A client-sent `x-vp-edge-client` is always dropped.
- `GET /health` = the upstream health plus `proxy.commit`. `GET /_edge/health` answers from the proxy alone (Railway healthcheck, with counters).
- Env: `UPSTREAM_URL` (required), `EDGE_PROXY_HMAC_SECRET`, `CLIENT_IP_HEADER`, `PROXY_COMMIT`, `PORT` (injected by Railway).
- Build/run: `npm run build && node dist/server.js`. `nixpacks.toml` drives what is installed and built, `railway.json` the start command, healthcheck and restart policy; both name the same start command.
- Rollback: `mcp.vantagepeers.com` is not pointed here in this phase; its CNAME stays `5rgjuf1h.up.railway.app`.
- Limit: counters are per process, in memory; run one replica.
