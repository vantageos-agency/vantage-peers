/**
 * Server metadata, discoverability and MCP Apps view metadata.
 * VantagePeers Cloud MCP server (HTTP /mcp entry). Task
 * k1793xkjhzh1xm23gmmwjgwfyx8htbv0, PR A (Manufact quality findings).
 *
 * Every pole runs through the REAL Hono app (bearer middleware included),
 * in-process: the URL is never dialed and no Convex process runs.
 *
 *   1. initialize: serverInfo carries title, description, websiteUrl, and the
 *      result carries instructions (<= 2048 UTF-8 bytes).
 *   2. the MCP Server Card is served unauthenticated at every card path, valid
 *      against the vendored Server Card schema, on the served origin.
 *   3. GET /mcp from a browser is a 200 text/html setup page; every MCP request
 *      without a credential keeps today's 401 + WWW-Authenticate.
 *   4. every ui:// view declares `_meta.ui.domain` (the served HTTPS origin)
 *      and `openai/widgetDescription`.
 *   5. the six tools with a UI carry `openai/toolInvocation`.
 *   6. bulk_complete_tasks fits Claude Code's 2048-byte field.
 */

import { readFileSync } from "node:fs";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { app } from "../server-http.js";
import * as uiIndex from "../src/ui-resources/index.js";

const MASTER = "test-master-token"; // vitest.config.ts BEARER_SECRET_MASTER
const HOST = "mcp.example.test";
const ORIGIN = `https://${HOST}`;
const WWW_AUTH = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`;
const BUDGET = 2048;

const UI_TOOLS = [
	"list_memories",
	"list_messages",
	"list_tasks",
	"list_missions",
	"get_diary",
	"get_briefing_note",
];
const PRIMITIVES = [
	"tasks-table",
	"messages-feed",
	"mission-timeline",
	"memory-quote",
	"diary-entry",
	"briefing-note",
];
const VIEW_URIS = [
	...PRIMITIVES.map((p) => `ui://vp/apps/v1/${p}`),
	...PRIMITIVES.map((p) => `ui://vp/v1/${p}`),
];

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** A request on the public origin, as Railway forwards it. */
function req(path: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set("host", HOST);
	headers.set("x-forwarded-proto", "https");
	return new Request(`http://${HOST}${path}`, { ...init, headers });
}

/** An in-process master connection on the public origin. */
async function connectMaster(): Promise<Client> {
	const client = new Client({ name: "metadata-test", version: "0.0.0" });
	const fetchShim = async (
		url: string | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${MASTER}`);
		const u = new URL(url);
		return app.fetch(req(`${u.pathname}${u.search}`, { ...init, headers }));
	};
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
			fetch: fetchShim,
		}),
	);
	return client;
}

describe("1. initialize: server metadata", () => {
	it("serverInfo carries title, description and websiteUrl; instructions fit 2048 bytes", async () => {
		const client = await connectMaster();
		try {
			const info = client.getServerVersion() as Record<string, unknown>;
			expect(info.name).toBe("vantage-peers");
			expect(info.title).toBe("VantagePeers");
			expect(typeof info.description).toBe("string");
			expect((info.description as string).length).toBeGreaterThan(20);
			expect(info.websiteUrl).toBe("https://www.vantagepeers.com");
			const instructions = client.getInstructions();
			expect(typeof instructions).toBe("string");
			expect(instructions as string).toContain("whoami");
			expect(instructions as string).toContain("agentId");
			expect(instructions as string).toContain("project");
			expect(bytes(instructions as string)).toBeLessThanOrEqual(BUDGET);
		} finally {
			await client.close();
		}
	});
});

describe("2. MCP Server Card, public", () => {
	const PATHS = [
		"/mcp/server-card",
		"/.well-known/mcp/server-card.json",
		"/.well-known/mcp-server-card",
		"/mcp.json",
		"/.well-known/mcp.json",
	];
	const schema = JSON.parse(
		readFileSync(
			new URL("./fixtures/server-card.schema.json", import.meta.url),
			"utf-8",
		),
	) as Record<string, unknown>;
	const ajv = new Ajv2020({ strict: false, validateFormats: false });
	ajv.addSchema({ ...schema, $id: "server-card.schema.json" });
	const validate = ajv.compile({
		$ref: "server-card.schema.json#/$defs/ServerCard",
	});

	for (const path of PATHS) {
		it(`GET ${path} with no credential -> 200, a valid card on the served origin`, async () => {
			const res = await app.fetch(req(path));
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type") ?? "").toMatch(/json/);
			const card = (await res.json()) as Record<string, unknown>;
			const ok = validate(card);
			expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual(
				[],
			);
			expect(ok).toBe(true);
			expect(card.name).toBe("com.vantagepeers/vantage-peers");
			expect(card.title).toBe("VantagePeers");
			expect(card.websiteUrl).toBe("https://www.vantagepeers.com");
			expect(card.remotes).toEqual([
				{ type: "streamable-http", url: `${ORIGIN}/mcp` },
			]);
			const icons = card.icons as Array<{ src: string }>;
			expect(icons.length).toBeGreaterThan(0);
			for (const icon of icons) expect(icon.src.startsWith(ORIGIN)).toBe(true);
			const auth = (card._meta as Record<string, Record<string, unknown>>)[
				"com.vantagepeers/auth"
			];
			expect(auth.type).toBe("oauth2");
			expect(auth.protectedResourceMetadata).toBe(
				`${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
			);
		});
	}

	it("the card says what initialize says (one source of strings)", async () => {
		const card = (await (await app.fetch(req("/mcp.json"))).json()) as Record<
			string,
			unknown
		>;
		const client = await connectMaster();
		try {
			const info = client.getServerVersion() as Record<string, unknown>;
			expect(card.version).toBe(info.version);
			expect(card.description).toBe(info.description);
			expect(card.title).toBe(info.title);
			expect(card.websiteUrl).toBe(info.websiteUrl);
		} finally {
			await client.close();
		}
	});

	it("negotiates the card media type and honours If-None-Match", async () => {
		const res = await app.fetch(
			req("/mcp/server-card", {
				headers: { accept: "application/mcp-server-card+json" },
			}),
		);
		expect(res.headers.get("content-type")).toBe(
			"application/mcp-server-card+json",
		);
		const etag = res.headers.get("etag");
		expect(etag).toBeTruthy();
		const again = await app.fetch(
			req("/mcp/server-card", { headers: { "if-none-match": etag ?? "" } }),
		);
		expect(again.status).toBe(304);
	});
});

describe("3. GET /mcp landing page vs MCP requests", () => {
	it("browser GET (Accept text/html, no credential) -> 200 text/html setup page", async () => {
		const res = await app.fetch(
			req("/mcp", {
				headers: {
					accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				},
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type") ?? "").toMatch(/^text\/html/);
		expect(res.headers.get("www-authenticate")).toBeNull();
		const html = await res.text();
		expect(html).toContain(`${ORIGIN}/mcp`);
		expect(html).toContain("https://www.vantagepeers.com/docs/cloud/connect");
		expect(html).toContain("OAuth");
	});

	it("GET Accept */* (no credential) -> 200 text/html", async () => {
		const res = await app.fetch(req("/mcp", { headers: { accept: "*/*" } }));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type") ?? "").toMatch(/^text\/html/);
	});

	it("POST /mcp without a credential -> 401 + WWW-Authenticate, unchanged", async () => {
		const res = await app.fetch(
			req("/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: { name: "x", version: "0" },
					},
				}),
			}),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(WWW_AUTH);
	});

	it("GET /mcp Accept text/event-stream without a credential -> 401 + WWW-Authenticate, unchanged", async () => {
		const res = await app.fetch(
			req("/mcp", { headers: { accept: "text/event-stream" } }),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(WWW_AUTH);
	});

	it("GET /mcp Accept text/html AND text/event-stream -> the MCP path (401)", async () => {
		const res = await app.fetch(
			req("/mcp", { headers: { accept: "text/html, text/event-stream" } }),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(WWW_AUTH);
	});

	it("GET /mcp with an Authorization header is never the landing page", async () => {
		const res = await app.fetch(
			req("/mcp", {
				headers: { accept: "text/html", authorization: "Bearer not-a-token" },
			}),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("content-type") ?? "").not.toMatch(/^text\/html/);
	});

	it("GET /mcp with no Accept header -> the MCP path (401)", async () => {
		const res = await app.fetch(req("/mcp"));
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(WWW_AUTH);
	});
});

describe("4. ui:// views declare a domain and a widget description", () => {
	it("resources/list: all 12 views carry _meta.ui.domain = the served origin and openai/widgetDescription", async () => {
		const client = await connectMaster();
		try {
			const { resources } = await client.listResources();
			const byUri = new Map(resources.map((r) => [r.uri, r]));
			for (const uri of VIEW_URIS) {
				const r = byUri.get(uri);
				expect(r, uri).toBeDefined();
				const meta = (r?._meta ?? {}) as Record<string, unknown>;
				expect((meta.ui as Record<string, unknown>)?.domain, uri).toBe(ORIGIN);
				expect(typeof meta["openai/widgetDescription"], uri).toBe("string");
				expect(
					(meta["openai/widgetDescription"] as string).length,
				).toBeGreaterThan(10);
			}
		} finally {
			await client.close();
		}
	});

	it("resources/read of each apps view: the HTML content carries the same _meta", async () => {
		const client = await connectMaster();
		try {
			for (const p of PRIMITIVES) {
				const uri = `ui://vp/apps/v1/${p}`;
				const { contents } = await client.readResource({ uri });
				const meta = (contents[0]._meta ?? {}) as Record<string, unknown>;
				expect(contents[0].mimeType).toBe("text/html;profile=mcp-app");
				expect((meta.ui as Record<string, unknown>)?.domain, uri).toBe(ORIGIN);
				expect(typeof meta["openai/widgetDescription"], uri).toBe("string");
			}
		} finally {
			await client.close();
		}
	});

	it("readUiResource (ui://vp/v1/*): the HTML content carries domain + widgetDescription", async () => {
		const read = uiIndex.readUiResource as unknown as (
			uri: string,
			fetchConvex: () => Promise<unknown>,
			identity: undefined,
			publicBaseUrl: string | null,
		) => Promise<{ contents: Array<{ mimeType: string; _meta?: unknown }> }>;
		for (const p of PRIMITIVES) {
			const uri = `ui://vp/v1/${p}`;
			const { contents } = await read(uri, async () => [], undefined, ORIGIN);
			const html = contents.find(
				(c) => c.mimeType === "text/html;profile=mcp-app",
			);
			const meta = (html?._meta ?? {}) as Record<string, unknown>;
			expect((meta.ui as Record<string, unknown>)?.domain, uri).toBe(ORIGIN);
			expect(typeof meta["openai/widgetDescription"], uri).toBe("string");
		}
	});

	it("no HTTPS origin (stdio, local http) declares no domain", () => {
		const domainOf = (uiIndex as Record<string, unknown>).viewDomainOf as
			| ((u: string | null) => string | undefined)
			| undefined;
		expect(typeof domainOf).toBe("function");
		expect(domainOf?.(null)).toBeUndefined();
		expect(domainOf?.("http://localhost:3000")).toBeUndefined();
		expect(domainOf?.(`${ORIGIN}`)).toBe(ORIGIN);
	});
});

describe("5. tools with a UI carry openai/toolInvocation", () => {
	it("each of the six carries invoking + invoked strings", async () => {
		const client = await connectMaster();
		try {
			const { tools } = await client.listTools();
			const byName = new Map(tools.map((t) => [t.name, t]));
			for (const name of UI_TOOLS) {
				const meta = (byName.get(name)?._meta ?? {}) as Record<string, unknown>;
				const inv = meta["openai/toolInvocation"] as
					| { invoking?: unknown; invoked?: unknown }
					| undefined;
				expect(inv, name).toBeDefined();
				expect(typeof inv?.invoking, name).toBe("string");
				expect(typeof inv?.invoked, name).toBe("string");
				expect((inv?.invoking as string).length).toBeGreaterThan(0);
				expect((inv?.invoked as string).length).toBeGreaterThan(0);
			}
		} finally {
			await client.close();
		}
	});
});

describe("6. Claude Code 2 KB metadata field", () => {
	it("bulk_complete_tasks description fits 2048 UTF-8 bytes", async () => {
		const client = await connectMaster();
		try {
			const { tools } = await client.listTools();
			const tool = tools.find((t) => t.name === "bulk_complete_tasks");
			expect(tool).toBeDefined();
			expect(bytes(tool?.description ?? "")).toBeLessThanOrEqual(BUDGET);
			// The critical guidance still leads the description.
			expect(tool?.description ?? "").toMatch(/dryRun defaults to true/);
			expect(tool?.description ?? "").toMatch(/BULK_FILTER_TOO_BROAD/);
			expect(tool?.description ?? "").toMatch(/BULK_CALLER_REQUIRED/);
		} finally {
			await client.close();
		}
	});
});
