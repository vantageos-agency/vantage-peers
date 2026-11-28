/**
 * Pass-5 review of the edge proxy (task k170e3qtjfdnqbyaz4wwvgmk958hyh1q):
 * F2 streams, F3/F4 route classification, F5 forwarded host.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { classifyRoute, createProxy } from "../src/proxy.js";

describe("F3 / F4 classifyRoute", () => {
	const limited: [string, string][] = [
		["GET", "/authorize"],
		["HEAD", "/authorize"],
		["POST", "/authorize/org"],
		["POST", "/authorize/org/"],
		["POST", "/token"],
		["POST", "/TOKEN"],
		["POST", "//token"],
		["POST", "/%74oken"],
		["GET", "/%61uthorize"],
		["GET", "/authorize%20"],
		["POST", "/token%09"],
		["POST", "/authorize%2Forg"],
	];
	for (const [m, p] of limited)
		it(`${m} ${p} is limited`, () =>
			expect(classifyRoute(m, p)).toBe("limited"));

	const rejected: [string, string][] = [
		["POST", "/token;x"],
		["GET", "/authorize;x"],
		["GET", "/./authorize"],
		["GET", "/authorize/."],
		["GET", "/authorize/../authorize"],
		["POST", "/x/../token"],
		["GET", "/%252e/authorize"],
		["POST", "/%252e%252e/token"],
		["GET", "/%2e/authorize"],
		["POST", "/authorize/org;a=b"],
	];
	for (const [m, p] of rejected)
		it(`${m} ${p} is refused with 400`, () =>
			expect(classifyRoute(m, p)).toBe("reject"));

	const passed: [string, string][] = [
		["POST", "/oauth/token"],
		["GET", "/token"],
		["POST", "/authorize"],
		["GET", "/authorize/callback"],
		["GET", "/authorize/org"],
		["GET", "/mcp"],
		["POST", "/register"],
		["GET", "/foo;x"],
		["GET", "/a/./b"],
		["PUT", "/token"],
	];
	for (const [m, p] of passed)
		it(`${m} ${p} passes straight through`, () =>
			expect(classifyRoute(m, p)).toBe("pass"));
});

interface World {
	seen: { url: string; headers: http.IncomingHttpHeaders }[];
	port: number;
	close: () => Promise<void>;
}
let world: World | undefined;

async function start(
	handler: http.RequestListener,
	extra: { responseStartTimeoutMs?: number } = {},
): Promise<World> {
	const seen: World["seen"] = [];
	const upstream = http.createServer((req, res) => {
		seen.push({ url: req.url ?? "", headers: req.headers });
		handler(req, res);
	});
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
	const proxy = createProxy({
		upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
		clientIpHeader: "x-real-ip",
		commit: "t",
		log: () => undefined,
		...extra,
	});
	await new Promise<void>((r) => proxy.server.listen(0, "127.0.0.1", r));
	world = {
		seen,
		port: (proxy.server.address() as AddressInfo).port,
		close: async () => {
			proxy.server.closeAllConnections();
			upstream.closeAllConnections();
			await Promise.all([
				new Promise((r) => proxy.server.close(r)),
				new Promise((r) => upstream.close(r)),
			]);
		},
	};
	return world;
}
afterEach(async () => {
	await world?.close();
	world = undefined;
});

const request = (
	port: number,
	method: string,
	path: string,
	headers: Record<string, string> = {},
) =>
	new Promise<number>((resolve, reject) => {
		const r = http.request(
			{ host: "127.0.0.1", port, method, path, headers },
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			},
		);
		r.on("error", reject);
		r.end();
	});

describe("F3 / F4 through the proxy", () => {
	it("POST /authorize/org is limited: 20 reach the upstream, the 21st is a 429 with none", async () => {
		const w = await start((_q, res) => res.end("{}"));
		const codes: number[] = [];
		for (let i = 0; i < 21; i++)
			codes.push(
				await request(w.port, "POST", "/authorize/org", {
					"x-real-ip": "203.0.113.50",
				}),
			);
		expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
		expect(codes[20]).toBe(429);
		expect(w.seen.length).toBe(20);
	});

	it("a path with dot segments, params or a double-encoded segment on a limited route gets 400 and no upstream call", async () => {
		const w = await start((_q, res) => res.end("{}"));
		for (const [m, p] of [
			["POST", "/token;x"],
			["GET", "/./authorize"],
			["GET", "/authorize/."],
			["GET", "/authorize;x"],
			["GET", "/%252e/authorize"],
		])
			expect(await request(w.port, m, p, { "x-real-ip": "203.0.113.51" })).toBe(
				400,
			);
		expect(w.seen.length).toBe(0);
	});

	it("/oauth/token and other paths pass, however many", async () => {
		const w = await start((_q, res) => res.end("{}"));
		for (let i = 0; i < 30; i++)
			expect(
				await request(w.port, "POST", "/oauth/token", {
					"x-real-ip": "203.0.113.52",
				}),
			).toBe(200);
		expect(w.seen.length).toBe(30);
	});
});

describe("F2 streams", () => {
	it("a stream idle for longer than the response-start timeout stays open", async () => {
		const w = await start(
			(_q, res) => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write("data: 1\n\n");
				setTimeout(() => {
					res.write("data: 2\n\n");
					res.end();
				}, 1200);
			},
			{ responseStartTimeoutMs: 300 },
		);
		const body = await new Promise<string>((resolve, reject) => {
			http
				.get({ host: "127.0.0.1", port: w.port, path: "/mcp" }, (res) => {
					let b = "";
					res.on("data", (d) => {
						b += d;
					});
					res.on("end", () => resolve(b));
					res.on("error", reject);
				})
				.on("error", reject);
		});
		expect(body).toBe("data: 1\n\ndata: 2\n\n");
	});

	it("an upstream that never answers is cut at the response-start timeout with a 504", async () => {
		const w = await start(() => undefined, { responseStartTimeoutMs: 300 });
		const t = Date.now();
		expect(await request(w.port, "GET", "/mcp")).toBe(504);
		expect(Date.now() - t).toBeLessThan(2000);
	});
});

describe("F5 forwarded host", () => {
	it("a client-sent x-forwarded-host (and x-forwarded-server) never reaches the upstream", async () => {
		const w = await start((_q, res) => res.end("{}"));
		await request(w.port, "GET", "/mcp", {
			"x-forwarded-host": "evil.example",
			"x-forwarded-server": "evil.example",
			host: "evil.example",
		});
		const h = w.seen[0].headers;
		expect(h["x-forwarded-host"]).toBeUndefined();
		expect(h["x-forwarded-server"]).toBeUndefined();
		expect(h.host).toMatch(/^127\.0\.0\.1:\d+$/);
	});
});
