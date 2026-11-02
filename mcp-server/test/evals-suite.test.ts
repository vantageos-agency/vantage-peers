/**
 * evals/evals.json — the eval suite D8 / C-5 reads (mcp-doctor `d8.ts`: a
 * top-level `cases` array, each case naming its `tool`, >= 3 per registered
 * tool).
 *
 * Two layers, both against the REAL server:
 *
 *   1. SHAPE. The file parses, every case carries the fields this suite
 *      defines, ids are unique, every `source` names a line that exists, and
 *      the per-tool count is >= 3 for every tool the server registers. The
 *      registered set is not typed here: it is read from `registerTools` on a
 *      capturing stub, so a tool added tomorrow without cases fails this file.
 *   2. REPLAY. Every case marked `runner: "offline"` is decided before any
 *      Convex call (input validation, the exposure mask, a pre-backend
 *      refusal, or a backend-free tool such as `whoami`). Those cases are sent
 *      through the real `/mcp` route (`server-http.ts` `app.fetch`) as the
 *      master bearer, and their `expect` block is asserted on the real
 *      response. A `runner: "live"` case needs a Convex deployment or a
 *      non-master principal and is checked for shape only — it is never
 *      reported as replayed.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ConvexHttpClient } from "convex/browser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../server-http.js";
import { LOCAL_STDIO_TRUST_CTX, type OAuthContext } from "../src/auth.js";
import { registerTools } from "../src/tools.js";
import { fromGate } from "./lib/fromGate.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = "test-master-token"; // vitest.config.ts BEARER_SECRET_MASTER

type Expect = {
	isError?: boolean;
	textIncludes?: string[];
	protocolErrorIncludes?: string;
	advertised?: boolean;
	jsonKeys?: string[];
	reached?: boolean;
	harnessMode?: "strict" | "permissive";
};

type EvalCase = {
	id: string;
	tool: string;
	op: "callTool" | "listTools" | "harness";
	caller: string;
	runner: "offline" | "live";
	prompt: string;
	args?: Record<string, unknown>;
	expect: Expect;
	expectations: string[];
	source: string;
};

const suite = JSON.parse(
	readFileSync(resolve(ROOT, "evals/evals.json"), "utf8"),
) as { cases: EvalCase[] };

/** The tool names `registerTools` registers, and which of them it disables. */
function registeredSurface(): { names: Set<string>; disabled: Set<string> } {
	const names = new Set<string>();
	const disabled = new Set<string>();
	const server = {
		registerTool: (name: string) => {
			names.add(name);
			return {
				disable: () => disabled.add(name),
				enable: () => undefined,
				update: () => undefined,
				remove: () => undefined,
			};
		},
		registerResource: () => ({}),
		registerPrompt: () => ({}),
	} as unknown as McpServer;
	registerTools(server, {} as ConvexHttpClient, LOCAL_STDIO_TRUST_CTX);
	return { names, disabled };
}

// The one registration the server does not serve: the test harness probe of
// the `from` gate (test/lib/fromGate.ts). mcp-doctor enumerates it because it
// is a `defineTool(...)` call site in the tree.
const HARNESS_TOOLS = new Set(["from_gate_probe"]);

// Harness callers, the same fixture src/__tests__/absence-refuses-authorization.test.ts
// uses: a single-station seat that is neither master nor the service account.
const HARNESS_CALLERS: Record<string, OAuthContext | undefined> = {
	none: undefined,
	"scoped-seat": {
		clientId: "prometheus",
		userId: "prometheus",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "team-member",
		fromAllowList: ["prometheus"],
		actor: {
			orgSlug: "acme",
			agentName: "prometheus",
			agentId: "agent-prometheus",
		},
		namespaceReadPrefixes: ["team/acme"],
		namespaceWritePrefixes: ["team/acme"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
	},
};

describe("evals/evals.json — shape", () => {
	const surface = registeredSurface();

	it("is the shape mcp-doctor D8 reads: a top-level `cases` array", () => {
		expect(Array.isArray(suite.cases)).toBe(true);
		expect(suite.cases.length).toBeGreaterThan(0);
	});

	it("every case carries the suite fields, with a unique id", () => {
		const ids = new Set<string>();
		for (const c of suite.cases) {
			expect(typeof c.id, JSON.stringify(c)).toBe("string");
			expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false);
			ids.add(c.id);
			expect(typeof c.tool, c.id).toBe("string");
			expect(["callTool", "listTools", "harness"], c.id).toContain(c.op);
			expect(["offline", "live"], c.id).toContain(c.runner);
			expect(c.caller.length, c.id).toBeGreaterThan(0);
			expect(c.prompt.length, c.id).toBeGreaterThan(0);
			expect(c.expectations.length, c.id).toBeGreaterThan(0);
			expect(Object.keys(c.expect).length, c.id).toBeGreaterThan(0);
		}
	});

	it("every `source` names a line that exists", () => {
		for (const c of suite.cases) {
			const m = /^(.+):(\d+)$/.exec(c.source);
			expect(m, `${c.id}: source ${c.source}`).not.toBeNull();
			const [, file, line] = m as RegExpExecArray;
			const lines = readFileSync(resolve(ROOT, file), "utf8").split("\n");
			expect(Number(line), `${c.id}: ${c.source}`).toBeLessThanOrEqual(
				lines.length,
			);
		}
	});

	it("names only tools the server registers (or the harness probe)", () => {
		for (const c of suite.cases) {
			expect(
				surface.names.has(c.tool) || HARNESS_TOOLS.has(c.tool),
				`${c.id}: ${c.tool}`,
			).toBe(true);
		}
	});

	it("has >= 3 cases for every registered tool, one of them degraded", () => {
		for (const name of [...surface.names, ...HARNESS_TOOLS]) {
			const cases = suite.cases.filter((c) => c.tool === name);
			expect(cases.length, name).toBeGreaterThanOrEqual(3);
			const degraded = cases.some(
				(c) =>
					c.expect.isError === true ||
					c.expect.protocolErrorIncludes !== undefined ||
					c.expect.reached === false,
			);
			expect(degraded, `${name}: no degraded case`).toBe(true);
		}
	});

	it("a masked tool's call cases expect the mask, an advertised tool's never do", () => {
		for (const c of suite.cases) {
			if (c.op !== "callTool") continue;
			const masked = surface.disabled.has(c.tool);
			const expectsMask =
				c.expect.protocolErrorIncludes === `Tool ${c.tool} disabled`;
			expect(expectsMask, `${c.id}`).toBe(masked);
		}
	});
});

describe("evals/evals.json — offline replay through /mcp as master", () => {
	let client: Client;
	let advertised: Set<string>;

	beforeAll(async () => {
		const fetchAsMaster = async (
			url: string | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const headers = new Headers(init?.headers);
			headers.set("Authorization", `Bearer ${MASTER}`);
			return app.fetch(new Request(url, { ...init, headers }));
		};
		client = new Client({ name: "evals-replay", version: "0.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
				fetch: fetchAsMaster,
			}),
		);
		const { tools } = await client.listTools();
		advertised = new Set(tools.map((t) => t.name));
	});

	afterAll(async () => {
		await client?.close();
	});

	const offline = suite.cases.filter((c) => c.runner === "offline");

	it("has offline cases to replay", () => {
		expect(offline.length).toBeGreaterThan(0);
	});

	for (const c of offline) {
		it(`${c.id} (${c.tool})`, async () => {
			if (c.op === "listTools") {
				expect(advertised.has(c.tool)).toBe(c.expect.advertised);
				return;
			}
			if (c.op === "harness") {
				expect(Object.keys(HARNESS_CALLERS), c.id).toContain(c.caller);
				const refusal = await fromGate(
					HARNESS_CALLERS[c.caller],
					c.args?.from as string | undefined,
					c.expect.harnessMode ?? "strict",
				);
				expect(refusal === null, String(refusal)).toBe(c.expect.reached);
				return;
			}
			expect(c.caller, "a callTool replay runs as the master bearer").toBe(
				"master",
			);
			let result: Awaited<ReturnType<Client["callTool"]>> | undefined;
			let thrown: unknown;
			try {
				result = await client.callTool({
					name: c.tool,
					arguments: c.args ?? {},
				});
			} catch (err) {
				thrown = err;
			}
			if (c.expect.protocolErrorIncludes !== undefined) {
				expect(thrown, "expected a protocol error").toBeDefined();
				expect(String((thrown as Error).message)).toContain(
					c.expect.protocolErrorIncludes,
				);
				return;
			}
			expect(thrown, String(thrown)).toBeUndefined();
			const content = (result?.content ?? []) as Array<{ text?: string }>;
			const text = content.map((p) => p.text ?? "").join("\n");
			if (c.expect.isError !== undefined) {
				expect(result?.isError === true, text).toBe(c.expect.isError);
			}
			for (const needle of c.expect.textIncludes ?? []) {
				expect(text).toContain(needle);
			}
			if (c.expect.jsonKeys !== undefined) {
				const parsed = JSON.parse(content[0]?.text ?? "") as Record<
					string,
					unknown
				>;
				for (const key of c.expect.jsonKeys) {
					expect(parsed, key).toHaveProperty(key);
				}
			}
		});
	}
});
