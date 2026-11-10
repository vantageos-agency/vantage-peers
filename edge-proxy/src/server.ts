import { createProxy } from "./proxy.js";

const upstream = process.env.UPSTREAM_URL;
if (!upstream) {
	console.error("UPSTREAM_URL is required (the MCP's own address).");
	process.exit(1);
}
const secret = process.env.EDGE_PROXY_HMAC_SECRET || undefined;
if (!secret)
	console.warn(
		"EDGE_PROXY_HMAC_SECRET is not set: rate limiting works, no signed client-IP header is sent.",
	);

const port = Number(process.env.PORT ?? 3000);
const { server } = createProxy({
	upstream,
	secret,
	clientIpHeader: (process.env.CLIENT_IP_HEADER ?? "x-real-ip").toLowerCase(),
	debugHeaders: process.env.EDGE_DEBUG_HEADERS === "1",
	commit:
		process.env.PROXY_COMMIT ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown",
});
// 0.0.0.0, never 127.0.0.1: Railway's prober and edge reach the container from outside.
server.listen(port, "0.0.0.0", () =>
	console.log(`edge-proxy listening on 0.0.0.0:${port} -> ${upstream}`),
);
