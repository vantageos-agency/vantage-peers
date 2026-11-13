# edge-proxy

Rate-limit proxy in front of the VantagePeers Cloud MCP. Node, `node:http`, no runtime dependency.

- Limits per 60 s on `GET|HEAD /authorize`, `POST /authorize/org` and `POST /token` only (paths resolving to them through dot segments, `;params` or a double-encoded segment get 400, no upstream call): 20 per IPv4 /32 or IPv6 /64, 60 per IPv4 /24 or IPv6 /48, 200 per IPv6 /32. Over the limit: 429 + `Retry-After`, no upstream call. Every other path passes straight through.
- Client address: the header named by `CLIENT_IP_HEADER` (default `x-real-ip`), set by the Railway edge; a client-sent value of any other header is never used. Forwarded to the MCP in one header, `x-vp-edge-client` = `<ip>|<unix s>|<hex HMAC-SHA256 of "v1|ip|s">`, signed under `EDGE_PROXY_HMAC_SECRET`. A client-sent `x-vp-edge-client` is always dropped.
- `GET /health` = the upstream health plus `proxy.commit`. `GET /_edge/health` answers from the proxy alone (Railway healthcheck, with counters).
- Env: `UPSTREAM_URL` (required), `EDGE_PROXY_HMAC_SECRET`, `CLIENT_IP_HEADER`, `PROXY_COMMIT`, `PORT` (injected by Railway).
- Build/run: `npm run build && node dist/server.js`. `nixpacks.toml` drives what is installed and built, `railway.json` the start command, healthcheck and restart policy; both name the same start command.
- Rollback: `mcp.vantagepeers.com` is not pointed here in this phase; its CNAME stays `5rgjuf1h.up.railway.app`.
- Limit: counters are per process, in memory; run one replica.

## Deploy procedure (not performed by a station; the operator or the rollout-token holder runs it)

The live service has no repository trigger: it was created from an upload. `railway.json` and `nixpacks.toml` are read from the uploaded directory root, so the upload root is `edge-proxy/` itself (not the repo root; no `cd edge-proxy` inside any command).

1. Local check from `edge-proxy/`: `npm ci && npm run typecheck && npm run build`, then `PORT=3099 UPSTREAM_URL=<mcp health host> EDGE_PROXY_HMAC_SECRET=<test value> node dist/server.js` and `curl -s -o /dev/null -w "%{http_code}" http://localhost:3099/_edge/health` must print 200.
2. Upload that directory to the proxy service only (`railway up` run inside `edge-proxy/`, linked to the `vantage-peers-edge-proxy` service). Nixpacks installs `nodejs_22`, runs `npm ci` against the committed `package-lock.json` and `npm run build`; Railway starts `node dist/server.js` and probes `/_edge/health` (30 s).
3. Set `PROXY_COMMIT=<git sha of the uploaded tree>` on the service so `/health` reports `proxy.commit`; read it back: `curl https://vantage-peers-edge-proxy-production.up.railway.app/health` must show that sha.
4. Variables (`UPSTREAM_URL`, `EDGE_PROXY_HMAC_SECRET`, `CLIENT_IP_HEADER`) live in the service's Railway Variables; `PORT` is injected, never set. The same `EDGE_PROXY_HMAC_SECRET` must exist on the MCP service before any DNS switch (see `changelog.d/sigma-edge-proxy.md`).
5. This is a Railway upload, not the MCP rollout: the MCP itself still ships last under its rollout token (`.claude/rules/railway-mcp-redeploy.md`).
