/**
 * Build identity in initialize's serverInfo (mcp-doctor rule C25).
 * VantagePeers Cloud MCP server. Task k17egf0eyp4rsvtepn5zps6qks8hx8gw.
 *
 * /health already serves `commit` (RAILWAY_GIT_COMMIT_SHA, or the honest
 * string "unknown" when no build stamped one). initialize's serverInfo must
 * carry the SAME value under `commitSha`, so a reader can tell which build
 * answered a connection without a second request. The two must never diverge:
 * every pole compares serverInfo with /health read in the same environment.
 *
 *   1. HTTP entry, commit known: serverInfo.commitSha === /health commit.
 *   2. HTTP entry, no commit (local dev): both are "unknown", never omitted,
 *      never a SHA-shaped placeholder.
 *   3. stdio shares the builder (server.ts calls mcpImplementation(version,
 *      null)): the builder carries the same value with no public origin.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../server-http.js";
import { mcpImplementation } from "../src/brand.js";

const MASTER = "test-master-token"; // vitest.config.ts BEARER_SECRET_MASTER
const HOST = "mcp.example.test";
const ENV = "RAILWAY_GIT_COMMIT_SHA";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function req(path: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set("host", HOST);
	headers.set("x-forwarded-proto", "https");
	return new Request(`http://${HOST}${path}`, { ...init, headers });
}

/**
 * serverInfo exactly as it travels on the wire. Read raw, NOT through the SDK
 * Client: the client parses serverInfo with its ImplementationSchema (a plain
 * z.object in @modelcontextprotocol/core), which strips unknown keys, so
 * getServerVersion() can never show an extra field. The doctor reads the wire.
 */
async function serverInfo(): Promise<Record<string, unknown>> {
	const res = await app.fetch(
		req("/mcp", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${MASTER}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "build-identity-test", version: "0.0.0" },
				},
			}),
		}),
	);
	expect(res.status).toBe(200);
	const text = await res.text();
	const json = (res.headers.get("content-type") ?? "").includes(
		"text/event-stream",
	)
		? text
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trim())
				.join("")
		: text;
	const body = JSON.parse(json) as {
		result?: { serverInfo?: Record<string, unknown> };
	};
	expect(body.result?.serverInfo, text).toBeDefined();
	return body.result?.serverInfo as Record<string, unknown>;
}

async function healthCommit(): Promise<unknown> {
	const res = await app.fetch(req("/health"));
	const body = (await res.json()) as Record<string, unknown>;
	return body.commit;
}

let saved: string | undefined;
beforeEach(() => {
	saved = process.env[ENV];
});
afterEach(() => {
	if (saved === undefined) delete process.env[ENV];
	else process.env[ENV] = saved;
});

describe("C25: serverInfo carries the build identity /health reports", () => {
	it("1. HTTP, commit known: serverInfo.commitSha equals /health commit", async () => {
		process.env[ENV] = SHA;
		const info = await serverInfo();
		expect(await healthCommit()).toBe(SHA);
		expect(info.commitSha).toBe(SHA);
	});

	it('2. HTTP, no commit: both say "unknown", the field is not omitted', async () => {
		delete process.env[ENV];
		const info = await serverInfo();
		expect(await healthCommit()).toBe("unknown");
		expect(info).toHaveProperty("commitSha", "unknown");
	});

	it("3. stdio builder (no public origin) carries the same value", async () => {
		process.env[ENV] = SHA;
		const impl = mcpImplementation("0.0.0", null) as unknown as Record<
			string,
			unknown
		>;
		expect(impl.commitSha).toBe(SHA);
		expect(impl.commitSha).toBe(await healthCommit());
	});
});
