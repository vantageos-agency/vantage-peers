import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyEdgeClientHeader } from "../../mcp-server/src/edgeClientIp.js";
import {
	clientIpFrom,
	createProxy,
	isLimitedRoute,
	normalisedPath,
} from "../src/proxy.js";
import { EDGE_CLIENT_HEADER } from "../src/sign.js";

const SECRET = "test-edge-secret-0123456789abcdef";

interface Seen {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
}

let upstream: http.Server;
let seen: Seen[];
let proxy: ReturnType<typeof createProxy>;
let base: string;
let logs: Record<string, unknown>[];

async function listen(s: http.Server): Promise<number> {
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	return (s.address() as AddressInfo).port;
}

async function start(opts: { secret?: string; upstreamUrl?: string } = {}) {
	upstream = http.createServer((req, res) => {
		seen.push({
			method: req.method ?? "",
			url: req.url ?? "",
			headers: req.headers,
		});
		if (req.url?.startsWith("/health")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "ok", commit: "upstreamsha" }));
		} else if (req.url?.startsWith("/authorize")) {
			res.writeHead(302, { location: "https://claude.ai/cb?code=x" });
			res.end();
		} else {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("up");
		}
	});
	const upPort = await listen(upstream);
	logs = [];
	proxy = createProxy({
		upstream: opts.upstreamUrl ?? `http://127.0.0.1:${upPort}`,
		secret: opts.secret,
		clientIpHeader: "x-real-ip",
		commit: "proxysha",
		log: (l) => logs.push(l),
	});
	const port = await listen(proxy.server);
	base = `http://127.0.0.1:${port}`;
}

const get = (
	path: string,
	headers: Record<string, string> = {},
	method = "GET",
) => fetch(base + path, { method, headers, redirect: "manual" });

beforeEach(() => {
	seen = [];
});
afterEach(async () => {
	proxy?.server.closeAllConnections();
	upstream?.closeAllConnections();
	await Promise.all([
		new Promise((r) => proxy?.server.close(r)),
		new Promise((r) => upstream?.close(r)),
	]);
});

describe("route matching", () => {
	it("limits GET/HEAD /authorize and POST /token, nothing else", () => {
		expect(isLimitedRoute("GET", "/authorize?client_id=x")).toBe(true);
		expect(isLimitedRoute("HEAD", "/authorize")).toBe(true);
		expect(isLimitedRoute("POST", "/token")).toBe(true);
		expect(isLimitedRoute("POST", "/authorize")).toBe(false);
		expect(isLimitedRoute("GET", "/token")).toBe(false);
		for (const p of [
			"/mcp",
			"/register",
			"/.well-known/oauth-authorization-server",
			"/",
			"/authorized",
			"/tokens",
		])
			for (const m of ["GET", "POST"]) expect(isLimitedRoute(m, p)).toBe(false);
	});

	it("spellings the upstream router could fold onto the same route are limited too", () => {
		for (const p of [
			"/authorize/",
			"//authorize",
			"/%61uthorize",
			"/Authorize",
			"/authorize?x=1#f",
			"http://h/authorize?a=1",
		])
			expect(isLimitedRoute("GET", p), p).toBe(true);
		expect(isLimitedRoute("POST", "/token/")).toBe(true);
		expect(isLimitedRoute("POST", "/%74oken")).toBe(true);
	});

	it("an undecodable path is limited, never passed", () => {
		expect(normalisedPath("/%E0%A4%A")).toBeNull();
		expect(isLimitedRoute("GET", "/%E0%A4%A")).toBe(true);
	});

	it("the client address comes from the configured header only, and must be an address", () => {
		expect(clientIpFrom("203.0.113.1", "x-real-ip")).toBe("203.0.113.1");
		expect(clientIpFrom("6.6.6.6, 203.0.113.2", "x-forwarded-for")).toBe(
			"203.0.113.2",
		);
		expect(clientIpFrom("not-an-ip", "x-real-ip")).toBeNull();
		expect(clientIpFrom(undefined, "x-real-ip")).toBeNull();
	});
});

describe("rate limiting through the proxy", () => {
	it("21 GET /authorize from one address: 20 reach the upstream, the 21st is a 429 with no upstream call", async () => {
		await start();
		const ip = { "x-real-ip": "203.0.113.9" };
		const statuses: number[] = [];
		for (let i = 0; i < 20; i++)
			statuses.push((await get("/authorize?client_id=x", ip)).status);
		expect(statuses.every((s) => s === 302)).toBe(true);
		expect(seen.length).toBe(20);
		const r = await get("/authorize?client_id=x", ip);
		expect(r.status).toBe(429);
		expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(seen.length).toBe(20);
		expect(proxy.counters).toMatchObject({ allowed: 20, denied: 1 });
		expect(logs.at(-1)).toMatchObject({
			evt: "rate_limited",
			upstream_call: false,
			pool: "v4/32",
		});
	});

	it("rotating a client-sent X-Forwarded-For does not escape the limit", async () => {
		await start();
		let denied = 0;
		for (let i = 0; i < 25; i++) {
			const r = await get("/authorize", {
				"x-real-ip": "203.0.113.9",
				"x-forwarded-for": `198.51.100.${i}`,
			});
			if (r.status === 429) denied++;
		}
		expect(denied).toBe(5);
	});

	it("POST /token is limited the same way", async () => {
		await start();
		const ip = { "x-real-ip": "203.0.113.9" };
		for (let i = 0; i < 20; i++)
			expect((await get("/token", ip, "POST")).status).toBe(200);
		expect((await get("/token", ip, "POST")).status).toBe(429);
	});

	it("every other path passes straight through, however many requests", async () => {
		await start();
		const ip = { "x-real-ip": "203.0.113.9" };
		for (const path of [
			"/mcp",
			"/register",
			"/.well-known/oauth-protected-resource",
		])
			for (let i = 0; i < 40; i++)
				expect((await get(path, ip)).status).toBe(200);
		expect(seen.length).toBe(120);
		expect(proxy.counters.denied).toBe(0);
	});

	it("probe in spirit (Q1b-like): 61 addresses of one IPv4 /24, 1 request each: the 61st is refused", async () => {
		await start();
		let last = 0;
		for (let i = 1; i <= 61; i++)
			last = (await get("/authorize", { "x-real-ip": `203.0.113.${i}` }))
				.status;
		expect(last).toBe(429);
		expect(seen.length).toBe(60);
	});

	it("probe in spirit (Q2c-like): 61 /64s of one IPv6 /48, 1 request each: the 61st is refused", async () => {
		await start();
		let last = 0;
		for (let i = 0; i < 61; i++)
			last = (
				await get("/authorize", {
					"x-real-ip": `2001:db8:1:${i.toString(16)}::1`,
				})
			).status;
		expect(last).toBe(429);
		expect(seen.length).toBe(60);
	});

	it("probe in spirit: 201 /48s of one IPv6 /32: the 201st is refused", async () => {
		await start();
		let last = 0;
		for (let i = 0; i < 201; i++)
			last = (
				await get("/authorize", {
					"x-real-ip": `2001:db8:${i.toString(16)}::1`,
				})
			).status;
		expect(last).toBe(429);
		expect(seen.length).toBe(200);
	});

	it("without the edge header the socket address is the key (never a bypass)", async () => {
		await start();
		for (let i = 0; i < 20; i++) await get("/authorize");
		expect((await get("/authorize")).status).toBe(429);
	});

	it("a 302 from the upstream is returned as is, not followed", async () => {
		await start();
		const r = await get(
			"/authorize?client_id=https://claude.ai/oauth/mcp-oauth-client-metadata",
			{ "x-real-ip": "203.0.113.9" },
		);
		expect(r.status).toBe(302);
		expect(r.headers.get("location")).toBe("https://claude.ai/cb?code=x");
		expect(seen[0].url).toBe(
			"/authorize?client_id=https://claude.ai/oauth/mcp-oauth-client-metadata",
		);
	});
});

describe("the signed header to the MCP", () => {
	it("carries the edge address, signed, and the MCP verifier accepts it", async () => {
		await start({ secret: SECRET });
		await get("/mcp", { "x-real-ip": "203.0.113.9" });
		const h = seen[0].headers[EDGE_CLIENT_HEADER] as string;
		expect(verifyEdgeClientHeader(h, SECRET)).toBe("203.0.113.9");
		expect(verifyEdgeClientHeader(h, "another-secret")).toBeNull();
	});

	it("a client-sent header of that name never reaches the MCP; the proxy's own replaces it", async () => {
		await start({ secret: SECRET });
		const forged = `198.51.100.7|${Math.floor(Date.now() / 1000)}|${createHmac("sha256", "x").update("y").digest("hex")}`;
		await get("/mcp", {
			"x-real-ip": "203.0.113.9",
			[EDGE_CLIENT_HEADER]: forged,
		});
		const got = seen[0].headers[EDGE_CLIENT_HEADER] as string;
		expect(got).not.toBe(forged);
		expect(verifyEdgeClientHeader(got, SECRET)).toBe("203.0.113.9");
	});

	it("with no secret nothing is sent, and a client-sent one is still stripped", async () => {
		await start();
		await get("/mcp", {
			"x-real-ip": "203.0.113.9",
			[EDGE_CLIENT_HEADER]: "198.51.100.7|1|ab",
		});
		expect(seen[0].headers[EDGE_CLIENT_HEADER]).toBeUndefined();
	});

	it("the upstream sees its own Host and the original in x-forwarded-host", async () => {
		await start({ secret: SECRET });
		await get("/mcp", { "x-real-ip": "203.0.113.9" });
		expect(seen[0].headers.host).toMatch(/^127\.0\.0\.1:\d+$/);
		expect(seen[0].headers["x-forwarded-host"]).toBe(
			base.replace("http://", ""),
		);
	});
});

describe("health", () => {
	it("/health returns the upstream health plus the proxy commit", async () => {
		await start();
		const r = await get("/health");
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({
			status: "ok",
			commit: "upstreamsha",
			proxy: { service: "vantage-peers-edge-proxy", commit: "proxysha" },
		});
	});

	it("/health says so when the upstream is unreachable", async () => {
		await start({ upstreamUrl: "http://127.0.0.1:1" });
		const r = await get("/health");
		expect(r.status).toBe(502);
		expect(await r.json()).toMatchObject({
			status: "upstream_unreachable",
			proxy: { commit: "proxysha" },
		});
	});

	it("/_edge/health answers from the proxy alone", async () => {
		await start({ upstreamUrl: "http://127.0.0.1:1" });
		const r = await get("/_edge/health");
		expect(r.status).toBe(200);
		expect(await r.json()).toMatchObject({
			status: "ok",
			commit: "proxysha",
			signing: "disabled",
		});
	});

	it("an unreachable upstream on a proxied path is a 502, not a hang", async () => {
		await start({ upstreamUrl: "http://127.0.0.1:1" });
		expect((await get("/mcp", { "x-real-ip": "203.0.113.9" })).status).toBe(
			502,
		);
	});
});
