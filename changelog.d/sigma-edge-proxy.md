---
section: Added
---
- **VantagePeers Cloud: rate-limit proxy `edge-proxy/` and a signed client-address header.** A separate Railway service limits `GET /authorize` and `POST /token` per 60 s (20 per IPv4 or IPv6 /64, 60 per IPv4 /24 or IPv6 /48, 200 per IPv6 /32) with a 429 and `Retry-After` before any upstream call; every other path passes through. It forwards the client address the Railway edge reports in one header, `x-vp-edge-client` (`ip|ts|HMAC-SHA256`); the MCP trusts it only with a valid signature under `EDGE_PROXY_HMAC_SECRET` fresh within 30 s (`mcp-server/src/edgeClientIp.ts`, used by `clientIpForRateLimit`), otherwise its derivation is unchanged. The MCP side is committed and not deployed in this phase; `mcp.vantagepeers.com` is not switched. Closes the residuals F1/F2 of the CIMD pool review. Task k170e3qtjfdnqbyaz4wwvgmk958hyh1q.

Operating notes for `edge-proxy/`:

- **Fixed window, 2x burst at the boundary (known, accepted).** Each counter is a fixed 60 s window, so a client can send up to twice its allowance across a window boundary (20 at the end of one window, 20 at the start of the next, 40 within seconds). Per-minute volume stays bounded; a sliding window is not implemented.
- **Precondition for switching `mcp.vantagepeers.com` to the proxy (not done in this phase).** The proxy reaches the MCP through its public domain, so the MCP's own Railway edge rewrites `x-real-ip` to the proxy's address: without the MCP-side check, every client would share one source on the MCP. The signed-header check (`mcp-server/src/edgeClientIp.ts`) and `EDGE_PROXY_HMAC_SECRET` on the MCP service MUST be deployed and verified live BEFORE the DNS switch.
- **Routes counted:** `GET|HEAD /authorize`, `POST /authorize/org`, `POST /token`. A path that resolves to one of them through dot segments, `;params` or a double-encoded segment is refused with 400; every other path passes through.
- **Limits:** counters are per process, in memory (one replica). Expired buckets are swept on a 5 s timer; a full pool evicts its oldest bucket in O(1).
