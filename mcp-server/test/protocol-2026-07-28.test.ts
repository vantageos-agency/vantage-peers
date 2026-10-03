/**
 * MCP protocol revision 2026-07-28 on the HTTP /mcp endpoint. VantagePeers Cloud.
 *
 * Task k177ptn1qrn09ewed80xhy9qtn8fjcq0. ChatGPT MCP Events and the OpenAI
 * forms speak 2026-07-28: the client opens with a `server/discover` probe
 * (DiscoverRequestSchema, @modelcontextprotocol/core 2.3.0) instead of the
 * `initialize` handshake. A 2025-era client (Claude.ai, Claude Code, Codex
 * today) still opens with `initialize` and must keep getting its own version.
 *
 * Every request goes through the REAL Hono app (bearer middleware included) on
 * the master bearer, driven in-process by the official v2 client through a
 * fetch shim — the URL is never dialed.
 *
 * Poles:
 *   1. a modern client lands on the modern era: `server/discover` answered with
 *      supportedVersions + capabilities (RED on 8cfa2bf: the v1 server has no
 *      handler, so the probe is not answered and the client falls back legacy).
 *   2. a 2025-11-25 client still negotiates 2025-11-25 through `initialize`.
 *   3. tools/list is the same tool surface in both eras (names, inputSchema,
 *      outputSchema, annotations, description).
 *   4. a modern tools/list carries the cacheable-result fields the revision
 *      requires (ttlMs, cacheScope); a legacy one never does.
 *   5. the stdio entry (server.ts, `npx vantage-peers-mcp`) serves both eras
 *      from one process image, with the same tool count.
 */

import { fileURLToPath } from "node:url";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { app } from "../server-http.js";

const MASTER = "test-master-token"; // vitest.config.ts BEARER_SECRET_MASTER
const URL_MCP = new URL("http://localhost/mcp");

type Exchange = { method?: string; body?: Record<string, unknown> };

/** In-process fetch into the Hono app, recording each JSON-RPC exchange. */
function shim(log: Exchange[]) {
	return async (url: string | URL, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${MASTER}`);
		const req = new Request(url, { ...init, headers });
		let method: string | undefined;
		if (typeof init?.body === "string") {
			try {
				method = (JSON.parse(init.body) as { method?: string }).method;
			} catch {
				method = undefined;
			}
		}
		const res = await app.fetch(req);
		const entry: Exchange = { method };
		if (res.headers.get("content-type")?.includes("application/json")) {
			try {
				entry.body = (await res.clone().json()) as Record<string, unknown>;
			} catch {
				entry.body = undefined;
			}
		}
		log.push(entry);
		return res;
	};
}

async function connect(mode: "auto" | "legacy") {
	const log: Exchange[] = [];
	const client = new Client(
		{ name: "protocol-test", version: "0.0.0" },
		mode === "auto" ? { versionNegotiation: { mode: "auto" } } : {},
	);
	await client.connect(
		new StreamableHTTPClientTransport(URL_MCP, { fetch: shim(log) }),
	);
	return { client, log };
}

/** The contract surface of one tool, as a client reads it. */
function surface(tools: Array<Record<string, unknown>>) {
	return tools
		.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
			outputSchema: t.outputSchema,
			annotations: t.annotations,
		}))
		.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

describe("MCP protocol 2026-07-28 on /mcp", () => {
	it("a modern client is answered on server/discover and lands on 2026-07-28", async () => {
		const { client, log } = await connect("auto");
		expect(log[0]?.method).toBe("server/discover");
		expect(client.getProtocolEra()).toBe("modern");
		expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
		const discover = client.getDiscoverResult();
		expect(discover?.supportedVersions).toContain("2026-07-28");
		expect(discover?.capabilities.tools).toBeDefined();
		expect(discover?.capabilities.resources).toBeDefined();
		// The modern handshake never runs initialize.
		expect(log.some((e) => e.method === "initialize")).toBe(false);
		await client.close();
	});

	it("a 2025-11-25 client still negotiates its own version through initialize", async () => {
		const { client, log } = await connect("legacy");
		expect(log[0]?.method).toBe("initialize");
		expect(client.getProtocolEra()).toBe("legacy");
		expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
		expect(client.getServerVersion()?.name).toBe("vantage-peers");
		await client.close();
	});

	it("tools/list is the same tool surface in both eras", async () => {
		const modern = await connect("auto");
		const legacy = await connect("legacy");
		const m = (await modern.client.listTools()).tools;
		const l = (await legacy.client.listTools()).tools;
		expect(m.length).toBeGreaterThan(0);
		expect(surface(m as never)).toEqual(surface(l as never));
		await modern.client.close();
		await legacy.client.close();
	});

	it("a modern tools/list carries ttlMs + cacheScope; a legacy one does not", async () => {
		const modern = await connect("auto");
		await modern.client.listTools();
		const mResult = modern.log.find((e) => e.method === "tools/list")?.body
			?.result as Record<string, unknown> | undefined;
		expect(mResult).toBeDefined();
		expect(typeof mResult?.ttlMs).toBe("number");
		expect(["private", "public"]).toContain(mResult?.cacheScope);
		await modern.client.close();

		const legacy = await connect("legacy");
		await legacy.client.listTools();
		const lResult = legacy.log.find((e) => e.method === "tools/list")?.body
			?.result as Record<string, unknown> | undefined;
		if (lResult) {
			expect("ttlMs" in lResult).toBe(false);
			expect("cacheScope" in lResult).toBe(false);
		}
		await legacy.client.close();
	});

	it("the ui:// resource template is listed in the modern era", async () => {
		const { client } = await connect("auto");
		const res = await client.listResources();
		expect(res.resources.some((r) => r.uri.startsWith("ui://vp/v1/"))).toBe(
			true,
		);
		await client.close();
	});
});

describe("MCP protocol 2026-07-28 on stdio (server.ts)", () => {
	const cwd = fileURLToPath(new URL("..", import.meta.url));

	async function stdio(mode: "auto" | "legacy") {
		const client = new Client(
			{ name: "protocol-test", version: "0.0.0" },
			mode === "auto" ? { versionNegotiation: { mode: "auto" } } : {},
		);
		await client.connect(
			new StdioClientTransport({
				command: "bun",
				args: ["run", "server.ts"],
				cwd,
				env: {
					...(process.env as Record<string, string>),
					// tools/list never reaches Convex; the URL only has to parse.
					CONVEX_URL: "https://example.convex.cloud",
				},
				stderr: "ignore",
			}),
		);
		return client;
	}

	it("a modern client lands on 2026-07-28, a 2025 client on 2025-11-25, same tools", async () => {
		const modern = await stdio("auto");
		expect(modern.getProtocolEra()).toBe("modern");
		expect(modern.getNegotiatedProtocolVersion()).toBe("2026-07-28");
		const m = (await modern.listTools()).tools;
		await modern.close();

		const legacy = await stdio("legacy");
		expect(legacy.getProtocolEra()).toBe("legacy");
		expect(legacy.getNegotiatedProtocolVersion()).toBe("2025-11-25");
		const l = (await legacy.listTools()).tools;
		await legacy.close();

		expect(m.length).toBeGreaterThan(0);
		expect(surface(m as never)).toEqual(surface(l as never));
	}, 60_000);
});
