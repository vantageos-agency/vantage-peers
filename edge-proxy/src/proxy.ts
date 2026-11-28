import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { canonicalIp, poolKeysOf } from "./ip.js";
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
	/** Log, per request, which address headers arrived (measurement aid; off by default). */
	debugHeaders?: boolean;
	now?: () => number;
	log?: (line: Record<string, unknown>) => void;
	/** Milliseconds to wait for the upstream /health. */
	healthTimeoutMs?: number;
	/**
	 * Milliseconds to wait for the upstream to START answering (connect plus
	 * response headers). Once headers arrive there is no idle timeout, so a
	 * stream (SSE on /mcp) stays open as long as the client and upstream keep it.
	 */
	responseStartTimeoutMs?: number;
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

export type RouteClass = "limited" | "pass" | "reject";

interface Resolved {
	/** The path the upstream router could end up serving. */
	path: string;
	/** The raw form used a trick: dot segments, `;params`, a double-encoded segment. */
	suspicious: boolean;
}

/**
 * Resolves a request target to the path an upstream router could end up
 * serving, and says whether the spelling was a trick. Percent-decoded until
 * stable (at most 3 rounds), `;params` and surrounding whitespace/control
 * characters removed per segment, `.` and `..` segments applied, repeated and
 * trailing slashes dropped, lower-cased: everything that could fold onto a
 * route is folded. Null when the path cannot be decoded.
 */
export function resolvePath(target: string): Resolved | null {
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
	const firstSegments = decoded.split("/");
	const suspicious =
		decoded.includes(";") ||
		decoded.includes("%") ||
		firstSegments.some((s) => s === "." || s === "..");
	for (let i = 0; i < 2 && decoded.includes("%"); i++) {
		try {
			decoded = decodeURIComponent(decoded);
		} catch {
			break;
		}
	}
	const out: string[] = [];
	for (const seg of decoded.split("/")) {
		const clean = (seg.split(";")[0] ?? "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: trimming control characters is the point
			.replace(/^[\u0000-\u0020\u007f]+|[\u0000-\u0020\u007f]+$/g, "")
			.toLowerCase();
		if (clean === "" || clean === ".") continue;
		if (clean === "..") out.pop();
		else out.push(clean);
	}
	return { path: `/${out.join("/")}`, suspicious };
}

/** The resolved path of a target, or null when it cannot be decoded. */
export function normalisedPath(target: string): string | null {
	return resolvePath(target)?.path ?? null;
}

const LIMITED_ROUTES: { methods: string[]; path: string }[] = [
	// GET /authorize (HEAD is its alias in the upstream router): resolves a client-metadata document.
	{ methods: ["GET", "HEAD"], path: "/authorize" },
	// POST /authorize/org: the same resolver, on the organisation step.
	{ methods: ["POST"], path: "/authorize/org" },
	// POST /token: resolves the document (and the refresh path) for a URL client_id.
	{ methods: ["POST"], path: "/token" },
];

/**
 * Classifies by what the request RESOLVES to, not by how it is spelled.
 * "limited": a route that can trigger a client-metadata fetch, counted.
 * "reject": such a route reached through a trick (dot segments, `;params`, a
 * double-encoded segment): refused with 400, never passed. "pass": the rest.
 * A path that cannot be decoded is limited, never passed.
 */
export function classifyRoute(method: string, target: string): RouteClass {
	const m = method.toUpperCase();
	const r = resolvePath(target);
	if (r === null)
		return m === "GET" || m === "HEAD" || m === "POST" ? "limited" : "pass";
	const hit = LIMITED_ROUTES.some(
		(x) => x.path === r.path && x.methods.includes(m),
	);
	if (!hit) return "pass";
	return r.suspicious ? "reject" : "limited";
}

/** True for every request the proxy does not pass straight through. */
export function isLimitedRoute(method: string, target: string): boolean {
	return classifyRoute(method, target) !== "pass";
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
			if (
				HOP_BY_HOP.has(k) ||
				k === "host" ||
				k === EDGE_CLIENT_HEADER ||
				// Client-controlled, and the Railway edge does not set them (measured):
				// dropped, never forwarded.
				k === "x-forwarded-host" ||
				k === "x-forwarded-server"
			)
				continue;
			out[k] = v;
		}
		out.host = upstream.host;
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
			},
			(upRes) => {
				clearTimeout(startTimer);
				const headers: http.OutgoingHttpHeaders = {};
				for (const [k, v] of Object.entries(upRes.headers))
					if (!HOP_BY_HOP.has(k)) headers[k] = v;
				res.writeHead(upRes.statusCode ?? 502, headers);
				upRes.pipe(res);
				upRes.on("error", () => res.destroy());
			},
		);
		// Bound on connect plus time-to-first-headers only. It is cleared the moment
		// headers arrive: there is no idle timeout on a response in progress, so an
		// event stream is never cut. It restarts once the request body is sent.
		let timedOut = false;
		const startTimeoutMs = config.responseStartTimeoutMs ?? 15_000;
		const onStartTimeout = () => {
			timedOut = true;
			up.destroy(new Error("upstream response timeout"));
		};
		let startTimer = setTimeout(onStartTimeout, startTimeoutMs);
		up.on("finish", () => {
			clearTimeout(startTimer);
			startTimer = setTimeout(onStartTimeout, startTimeoutMs);
		});
		up.on("error", (err) => {
			clearTimeout(startTimer);
			log({
				evt: "upstream_error",
				message: String(err.message),
				timed_out: timedOut,
			});
			if (!res.headersSent) {
				res.writeHead(timedOut ? 504 : 502, {
					"content-type": "application/json",
				});
				res.end(
					JSON.stringify({
						error: timedOut ? "gateway_timeout" : "bad_gateway",
					}),
				);
			} else res.destroy();
		});
		res.on("close", () => {
			clearTimeout(startTimer);
			up.destroy();
		});
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
		const rawIp = edgeIp ?? req.socket.remoteAddress ?? null;
		// One spelling is keyed and signed: a mapped IPv4 is its IPv4.
		const clientIp = rawIp ? canonicalIp(rawIp) : null;
		if (config.debugHeaders && path !== "/health") {
			const h = req.headers;
			log({
				evt: "edge_headers_debug",
				path,
				"x-real-ip": h["x-real-ip"],
				"x-forwarded-for": h["x-forwarded-for"],
				forwarded: h.forwarded,
				"cf-connecting-ip": h["cf-connecting-ip"],
				"x-forwarded-proto": h["x-forwarded-proto"],
				socket: req.socket.remoteAddress,
			});
		}

		const routeClass = classifyRoute(method, target);
		if (routeClass === "reject") {
			log({ evt: "rejected_path", method, upstream_call: false });
			req.resume();
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "invalid_request" }));
			return;
		}
		if (routeClass === "limited") {
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
		pass(req, res, clientIp);
	});
	server.keepAliveTimeout = 65_000;

	return { server, limiter, counters };
}
