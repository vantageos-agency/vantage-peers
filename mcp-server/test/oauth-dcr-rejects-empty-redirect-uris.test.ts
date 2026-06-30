/**
 * DCR redirect_uris validation — RFC 7591 §3.2.2 / §2.
 *
 * Bug: POST /register accepted empty / missing / malformed redirect_uris and
 * persisted zombie clients (e.g. prod 87abdf5c-616b-4767-8a96-5ca04db88d9f)
 * whose subsequent /authorize calls always fail 400 because registeredUris
 * is empty.
 *
 * Fix contract:
 *   - missing redirect_uris   → 400 invalid_redirect_uri
 *   - redirect_uris: []       → 400 invalid_redirect_uri
 *   - non-https malformed URI → 400 invalid_redirect_uri
 *   - valid https URI         → 201 (positive control)
 *
 * TDD strict (RULE #12 Day 116): this file was added BEFORE the fix so that
 * the first three cases are RED on the original code.
 *
 * Harness: same Hono app.request() + fake ConvexHttpClient pattern as
 * oauth-d6-d7.test.ts. No real network, no Convex process.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../server-http.js";
import { _setInternalClientForTest } from "../src/auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal fake Convex — only oauth:registerPublicClient is exercised here
// ─────────────────────────────────────────────────────────────────────────────

type ClientRow = {
	clientId: string;
	clientSecretHash: string;
	redirectUris: string[];
	name: string;
	scopeProfile: string;
};

const registeredClients = new Map<string, ClientRow>();

function makeFakeConvex() {
	return {
		query: async (name: string, _args: Record<string, unknown>) => {
			throw new Error(`unmocked query in DCR test: ${name}`);
		},
		mutation: async (name: string, args: Record<string, unknown>) => {
			if (name === "oauth:registerPublicClient") {
				const row: ClientRow = {
					clientId: args.clientId as string,
					clientSecretHash: args.clientSecretHash as string,
					redirectUris: args.redirectUris as string[],
					name: args.name as string,
					scopeProfile: args.scopeProfile as string,
				};
				registeredClients.set(row.clientId, row);
				return "fake-db-id";
			}
			throw new Error(`unmocked mutation in DCR test: ${name}`);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
	registeredClients.clear();
	// biome-ignore lint/suspicious/noExplicitAny: test fake
	_setInternalClientForTest(makeFakeConvex() as any);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

async function postRegister(body: unknown): Promise<{
	status: number;
	json: Record<string, unknown>;
}> {
	const res = await app.request("http://localhost/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: res.status, json };
}

// ─────────────────────────────────────────────────────────────────────────────
// DCR — redirect_uris validation (RFC 7591 §3.2.2)
// ─────────────────────────────────────────────────────────────────────────────

describe("DCR POST /register — redirect_uris validation (RFC 7591 §3.2.2)", () => {
	it("T1 — empty redirect_uris array → 400 invalid_redirect_uri", async () => {
		const r = await postRegister({
			client_name: "zombie-test",
			redirect_uris: [],
		});
		expect(r.status).toBe(400);
		expect(r.json.error).toBe("invalid_redirect_uri");
		// confirm no zombie client was persisted
		expect(registeredClients.size).toBe(0);
	});

	it("T2 — missing redirect_uris field → 400 invalid_redirect_uri", async () => {
		const r = await postRegister({ client_name: "no-uris-test" });
		expect(r.status).toBe(400);
		expect(r.json.error).toBe("invalid_redirect_uri");
		expect(registeredClients.size).toBe(0);
	});

	it("T3 — malformed (non-https) redirect_uri → 400 invalid_redirect_uri", async () => {
		const r = await postRegister({
			client_name: "bad-scheme-test",
			redirect_uris: ["not-a-url"],
		});
		expect(r.status).toBe(400);
		expect(r.json.error).toBe("invalid_redirect_uri");
		expect(registeredClients.size).toBe(0);
	});

	it("T4 — valid https redirect_uri → 201 (positive control)", async () => {
		const r = await postRegister({
			client_name: "claude-connector",
			redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
		});
		expect(r.status).toBe(201);
		expect(typeof r.json.client_id).toBe("string");
		expect(r.json.redirect_uris).toEqual([
			"https://claude.ai/api/mcp/auth_callback",
		]);
		// confirm client WAS persisted
		expect(registeredClients.size).toBe(1);
	});
});
