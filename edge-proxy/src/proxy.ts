import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { poolKeysOf } from "./ip.js";
import { RateLimiter } from "./limiter.js";
import { EDGE_CLIENT_HEADER, signEdgeClient } from "./sign.js";

export interface ProxyConfig {
	/** The MCP's own address, e.g. https://vantage-peers-production.up.railway.app */
	upstream: string;
	/** Shared HMAC secret. Absent: nothing is signed, rate limiting still works. */
	secret?: string;
	/** The header the platform edge sets to the client address. */
	clientIpHeader: string;
	commit: string;
	now?: () => number;
	log?: (line: Record<string, unknown>) => void;
	/** Milliseconds to wait for the upstream /health. */
	healthTimeoutMs?: number;
}

export interface Counters {
	requests: number;
	limitedRouteRequests: number;
	allowed: number;
	denied: number;
	upstreamCalls: number;
}

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

/**
 * The path of a request target, normalised the way the upstream router would
 * see it, only stricter: percent-decoded once, repeated slashes collapsed,
 * trailing slash dropped, lower-cased. An undecodable path returns null.
 */
export function normalisedPath(target: string): string | null {
	let raw = target;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		try {
			raw = new URL(raw).pathname;
		} catch {
			return null;
		}
	}
	const cut = raw.search(/[?#]/);
	if (cut >= 0) raw = raw.slice(0, cut);
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	const squashed = decoded.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
	return (squashed === "" ? "/" : squashed).toLowerCase();
}

/**
 * Only the two requests that can make the MCP fetch a client-metadata document
 * are limited: GET /authorize (HEAD is its alias in the upstream router) and
 * POST /token. A path that cannot be decoded is limited rather than passed.
 */
export function isLimitedRoute(method: string, target: string): boolean {
	const path = normalisedPath(target);
	const m = method.toUpperCase();
	if (path === null) return m === "GET" || m === "HEAD" || m === "POST";
	if (path === "/authorize") return m === "GET" || m === "HEAD";
	if (path === "/token") return m === "POST";
	return false;
}

/** The client address the edge reported, or null when absent or not an address. */
export function clientIpFrom(
	headerValue: string | string[] | undefined,
	headerName: string,
): string | null {
	const raw = Array.isArray(headerValue) ? headerValue.at(-1) : headerValue;
	if (!raw) return null;
	// x-forwarded-for style: the entry the trusted edge appended is the last one.
	const value =
		headerName === "x-forwarded-for"
			? (raw.split(",").at(-1) ?? "").trim()
			: raw.trim();
	return isIP(value.split("%")[0]) ? value : null;
}

export function createProxy(config: ProxyConfig) {
	const now = config.now ?? Date.now;
	const log = config.log ?? ((line) => console.log(JSON.stringify(line)));
	const limiter = new RateLimiter(now);
	const upstream = new URL(config.upstream);
	const transport = upstream.protocol === "https:" ? https : http;
	const agent = new transport.Agent({ keepAlive: true });
	const counters: Counters = {
		requests: 0,
		limitedRouteRequests: 0,
		allowed: 0,
		denied: 0,
		upstreamCalls: 0,
	};

	function forwardHeaders(
		req: http.IncomingMessage,
		clientIp: string | null,
	): http.OutgoingHttpHeaders {
		const out: http.OutgoingHttpHeaders = {};
		for (const [k, v] of Object.entries(req.headers)) {
			if (HOP_BY_HOP.has(k) || k === "host" || k === EDGE_CLIENT_HEADER)
				continue;
			out[k] = v;
		}
		out.host = upstream.host;
		if (req.headers.host) out["x-forwarded-host"] = req.headers.host;
		if (config.secret && clientIp)
			out[EDGE_CLIENT_HEADER] = signEdgeClient(config.secret, clientIp, now());
		return out;
	}

	function pass(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		clientIp: string | null,
	): void {
		counters.upstreamCalls += 1;
		const up = transport.request(
			{
				protocol: upstream.protocol,
				hostname: upstream.hostname,
				port: upstream.port || undefined,
				method: req.method,
				path: req.url,
				headers: forwardHeaders(req, clientIp),
				agent,
				timeout: 15_000,
			},
			(upRes) => {
				const headers: http.OutgoingHttpHeaders = {};
				for (const [k, v] of Object.entries(upRes.headers))
					if (!HOP_BY_HOP.has(k)) headers[k] = v;
				res.writeHead(upRes.statusCode ?? 502, headers);
				upRes.pipe(res);
				upRes.on("error", () => res.destroy());
			},
		);
		// `timeout` is the connect/first-byte idle bound; a long stream keeps
		// producing bytes, so it is not cut.
		up.on("timeout", () => up.destroy(new Error("upstream timeout")));
		up.on("error", (err) => {
			log({ evt: "upstream_error", message: String(err.message) });
			if (!res.headersSent) {
				res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "bad_gateway" }));
			} else res.destroy();
		});
		res.on("close", () => up.destroy());
		req.pipe(up);
	}

	async function health(res: http.ServerResponse): Promise<void> {
		counters.upstreamCalls += 1;
		const proxy = {
			service: "vantage-peers-edge-proxy",
			commit: config.commit,
		};
		try {
			const r = await fetch(new URL("/health", upstream), {
				signal: AbortSignal.timeout(config.healthTimeoutMs ?? 5000),
				headers: { accept: "application/json" },
			});
			const text = await r.text();
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				body = undefined;
			}
			const merged =
				body && typeof body === "object" && !Array.isArray(body)
					? { ...(body as Record<string, unknown>), proxy }
					: {
							upstream_status: r.status,
							upstream_body: text.slice(0, 200),
							proxy,
						};
			res.writeHead(r.status, { "content-type": "application/json" });
			res.end(JSON.stringify(merged));
		} catch (err) {
			res.writeHead(502, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					status: "upstream_unreachable",
					message: String((err as Error).message),
					proxy,
				}),
			);
		}
	}

	const server = http.createServer((req, res) => {
		counters.requests += 1;
		const method = req.method ?? "GET";
		const target = req.url ?? "/";
		const path = normalisedPath(target);

		if (path === "/_edge/health" && method === "GET") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					status: "ok",
					service: "vantage-peers-edge-proxy",
					commit: config.commit,
					signing: config.secret ? "enabled" : "disabled",
					counters,
				}),
			);
			return;
		}
		if (path === "/health" && method === "GET") {
			void health(res);
			return;
		}

		const edgeIp = clientIpFrom(
			req.headers[config.clientIpHeader],
			config.clientIpHeader,
		);
		const clientIp = edgeIp ?? req.socket.remoteAddress ?? null;

		if (isLimitedRoute(method, target)) {
			counters.limitedRouteRequests += 1;
			const keys = clientIp ? poolKeysOf(clientIp) : null;
			// An address that cannot be keyed shares one bucket: the limit holds,
			// at the price of a shared allowance, never a bypass.
			const decision = limiter.take(
				keys ?? [{ pool: "unkeyed", key: "unknown", limit: 20 }],
			);
			if (!decision.allowed) {
				counters.denied += 1;
				log({
					evt: "rate_limited",
					method,
					path,
					pool: decision.pool,
					retry_after: decision.retryAfterSeconds,
					ip_source: edgeIp ? config.clientIpHeader : "socket",
					upstream_call: false,
					denied_total: counters.denied,
					upstream_calls_total: counters.upstreamCalls,
				});
				req.resume();
				res.writeHead(429, {
					"content-type": "application/json",
					"retry-after": String(decision.retryAfterSeconds),
					"cache-control": "no-store",
				});
				res.end(
					JSON.stringify({
						error: "rate_limited",
						error_description: `Too many requests; retry in ${decision.retryAfterSeconds} s.`,
					}),
				);
				return;
			}
			counters.allowed += 1;
		}
		pass(req, res, clientIp && isIP(clientIp.split("%")[0]) ? clientIp : null);
	});
	server.keepAliveTimeout = 65_000;

	return { server, limiter, counters };
}
