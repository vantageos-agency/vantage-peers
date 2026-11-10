/**
 * Client ID Metadata Documents — the SSRF-safe resolver
 * (mcp-doctor S5 (g) / standard S-46, task k174expfdyh954kzynmt9tyv9d8hxa1s).
 *
 * Each SSRF control has its own refusal test, and the happy path proves the
 * control is not simply refusing everything. No test reaches the internet:
 * DNS and the HTTP exchange are scripted (test/lib/cimdFakes.ts).
 *
 * Spec: draft-ietf-oauth-client-id-metadata-document-00 §3, §4.1, §4.4, §6.5,
 * §6.6 and the MCP authorization spec 2025-11-25.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	bodyOf,
	type CimdModule,
	DOC_URL,
	loadCimd,
	PUBLIC_IP,
	scripted,
	stallingBody,
	validDocument,
} from "./lib/cimdFakes.js";

let cimd: CimdModule;

async function install(script: Parameters<typeof scripted>[0] = {}) {
	cimd = await loadCimd();
	const rec = scripted(script);
	cimd._setClientMetadataDepsForTest(rec.deps);
	return rec;
}

afterEach(async () => {
	(await loadCimd().catch(() => null))?._setClientMetadataDepsForTest?.(null);
});

const json = (obj: unknown) => ({ body: bodyOf(JSON.stringify(obj)) });

describe("a valid document", () => {
	it("is resolved to the client's name, id and exact redirect URIs", async () => {
		const rec = await install({ respond: () => json(validDocument()) });
		const r = await cimd.resolveClientMetadata(DOC_URL);
		expect(r).toMatchObject({
			ok: true,
			client: {
				clientId: DOC_URL,
				redirectUris: ["https://app.example.com/callback"],
			},
		});
		expect(rec.requests).toHaveLength(1);
	});

	it("shows the client_id host next to the self-declared name (draft §6.4)", async () => {
		await install({
			respond: () => json(validDocument({ client_name: "Claude <b>\u0007" })),
		});
		const r = await cimd.resolveClientMetadata(DOC_URL);
		expect(r.ok && r.client.clientName).toBe("Claude b (app.example.com)");
	});
});

describe("SSRF — the client_id URL (draft §3)", () => {
	const refused: [string, string][] = [
		["http://app.example.com/c.json", "scheme-not-https"],
		["https://app.example.com:8443/c.json", "port-forbidden"],
		["https://user:pw@app.example.com/c.json", "userinfo-forbidden"],
		["https://app.example.com/c.json#frag", "fragment-forbidden"],
		["https://app.example.com/a/../c.json", "dot-segments-forbidden"],
		["https://app.example.com/", "path-required"],
		["https://127.0.0.1/c.json", "ip-literal-host-forbidden"],
		["https://[::1]/c.json", "ip-literal-host-forbidden"],
		["https://169.254.169.254/latest/meta-data", "ip-literal-host-forbidden"],
		["https://localhost/c.json", "host-not-public"],
		["https://intranet/c.json", "host-not-public"],
	];
	for (const [url, reason] of refused) {
		it(`refuses ${url} (${reason}) without any DNS or HTTP`, async () => {
			const rec = await install();
			const r = await cimd.resolveClientMetadata(url);
			expect(r).toMatchObject({ ok: false, reason });
			expect(rec.dnsQueries).toHaveLength(0);
			expect(rec.requests).toHaveLength(0);
		});
	}
});

describe("SSRF — address policy", () => {
	const blocked = [
		"0.0.0.0",
		"10.1.2.3",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"198.18.0.1",
		"224.0.0.1",
		"239.255.255.250",
		"255.255.255.255",
		"::",
		"::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:169.254.169.254",
		"::127.0.0.1",
		"fe80::1",
		"fd00:ec2::254",
		"fc00::1",
		"ff02::1",
		"64:ff9b::7f00:1",
		"2002:7f00:1::1",
		"not-an-ip",
	];
	for (const ip of blocked) {
		it(`isBlockedAddress(${ip}) is true`, async () => {
			cimd = await loadCimd();
			expect(cimd.isBlockedAddress(ip)).toBe(true);
		});
	}
	for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8"]) {
		it(`isBlockedAddress(${ip}) is false`, async () => {
			cimd = await loadCimd();
			expect(cimd.isBlockedAddress(ip)).toBe(false);
		});
	}

	it("refuses a host that resolves to a private address, before any request", async () => {
		const rec = await install({
			dns: { "app.example.com": [{ address: "10.0.0.5", family: 4 }] },
		});
		const r = await cimd.resolveClientMetadata(DOC_URL);
		expect(r).toMatchObject({ ok: false, reason: "address-blocked" });
		expect(rec.requests).toHaveLength(0);
	});

	it("refuses when ANY answer is internal (one public + one private)", async () => {
		const rec = await install({
			dns: {
				"app.example.com": [
					{ address: PUBLIC_IP, family: 4 },
					{ address: "::1", family: 6 },
				],
			},
		});
		const r = await cimd.resolveClientMetadata(DOC_URL);
		expect(r).toMatchObject({ ok: false, reason: "address-blocked" });
		expect(rec.requests).toHaveLength(0);
	});

	it("connects to the address it validated, once, and resolves the name once (no rebinding window)", async () => {
		const rec = await install({ respond: () => json(validDocument()) });
		await cimd.resolveClientMetadata(DOC_URL);
		expect(rec.dnsQueries).toEqual(["app.example.com"]);
		expect(rec.requests).toHaveLength(1);
		expect(rec.requests[0]).toMatchObject({
			hostname: "app.example.com",
			ip: PUBLIC_IP,
			family: 4,
			path: "/oauth/client-metadata.json",
		});
	});

	it("an empty DNS answer is a refusal, not a connection to nothing", async () => {
		const rec = await install({ dns: { "app.example.com": [] } });
		const r = await cimd.resolveClientMetadata(DOC_URL);
		expect(r).toMatchObject({ ok: false, reason: "dns-failure" });
		expect(rec.requests).toHaveLength(0);
	});
});

describe("SSRF — the exchange", () => {
	it("does not follow a redirect", async () => {
		const rec = await install({
			respond: () => ({ status: 302, headers: { location: "http://169.254.169.254/" } }),
		});
		const r = await cimd.resolveClientMetadata(DOC_URL);
		expect(r).toMatchObject({ ok: false, reason: "redirect-refused" });
		expect(rec.requests).toHaveLength(1);
	});

	it("refuses a non-200 status", async () => {
		await install({ respond: () => ({ status: 404 }) });
		expect(await cimd.resolveClientMetadata(DOC_URL)).toMatchObject({
			ok: false,
			reason: "bad-status",
		});
	});

	it("refuses a body over the cap (streamed)", async () => {
		const rec = await install({
			maxBytes: 64,
			respond: () => ({ body: bodyOf("x".repeat(40), "x".repeat(40)) }),
		});
		const r = await cimd.resolveClientMetadata(DOC_URL);
		expect(r).toMatchObject({ ok: false, reason: "document-too-large" });
		expect(rec.destroyed).toBeGreaterThan(0);
	});

	it("refuses a declared Content-Length over the cap without reading the body", async () => {
		await install({
			respond: () => ({
				headers: { "content-type": "application/json", "content-length": "999999" },
				body: bodyOf("{}"),
			}),
		});
		expect(await cimd.resolveClientMetadata(DOC_URL)).toMatchObject({
			ok: false,
			reason: "document-too-large",
		});
	});

	it("the default cap is 5 KB (draft §6.6)", async () => {
		cimd = await loadCimd();
		expect(cimd.CIMD_MAX_BYTES).toBe(5 * 1024);
	});

	it("gives up on a body that stalls, inside the time budget, and closes it", async () => {
		const rec = await install({
			timeoutMs: 60,
			respond: () => ({ body: stallingBody('{"client_id":') }),
		});
		const started = Date.now();
		const r = await cimd.resolveClientMetadata(DOC_URL);
		expect(r).toMatchObject({ ok: false, reason: "fetch-timeout" });
		expect(Date.now() - started).toBeLessThan(1000);
		expect(rec.destroyed).toBeGreaterThan(0);
	});

	it("gives up on a connection that never answers", async () => {
		await install({
			timeoutMs: 60,
			respond: () => new Promise(() => undefined),
		});
		expect(await cimd.resolveClientMetadata(DOC_URL)).toMatchObject({
			ok: false,
			reason: "fetch-timeout",
		});
	});

	it("gives up on DNS that never answers", async () => {
		cimd = await loadCimd();
		cimd._setClientMetadataDepsForTest({
			timeoutMs: 60,
			resolveHost: () => new Promise(() => undefined),
		});
		expect(await cimd.resolveClientMetadata(DOC_URL)).toMatchObject({
			ok: false,
			reason: "fetch-timeout",
		});
	});

	it("refuses a Content-Type that is not JSON", async () => {
		await install({
			respond: () => ({
				headers: { "content-type": "text/html" },
				body: bodyOf(JSON.stringify(validDocument())),
			}),
		});
		expect(await cimd.resolveClientMetadata(DOC_URL)).toMatchObject({
			ok: false,
			reason: "bad-content-type",
		});
	});

	it("accepts application/<x>+json with a charset", async () => {
		await install({
			respond: () => ({
				headers: { "content-type": "application/client-metadata+json; charset=utf-8" },
				body: bodyOf(JSON.stringify(validDocument())),
			}),
		});
		expect((await cimd.resolveClientMetadata(DOC_URL)).ok).toBe(true);
	});

	it("bounds the fetches in flight", async () => {
		cimd = await loadCimd();
		const release: (() => void)[] = [];
		const rec = scripted({
			timeoutMs: 5000,
			respond: () =>
				new Promise((resolve) => {
					release.push(() => resolve({ body: bodyOf(JSON.stringify(validDocument())) }));
				}),
		});
		cimd._setClientMetadataDepsForTest(rec.deps);
		const pending = Array.from({ length: cimd.CIMD_MAX_IN_FLIGHT }, (_, i) =>
			cimd.resolveClientMetadata(`https://app${i}.example.com/c.json`),
		);
		await new Promise((r) => setTimeout(r, 20));
		const over = await cimd.resolveClientMetadata("https://over.example.com/c.json");
		expect(over).toMatchObject({ ok: false, reason: "busy", retryable: true });
		for (const r of release) r();
		await Promise.all(pending);
	});
});

describe("the document (draft §4.1, MCP implementation requirements)", () => {
	const cases: [string, Record<string, unknown>, string][] = [
		["client_id differs from the URL", { client_id: "https://app.example.com/other.json" }, "client-id-mismatch"],
		["client_id absent", { client_id: undefined }, "client-id-mismatch"],
		["redirect_uris absent", { redirect_uris: undefined }, "redirect-uris-missing"],
		["redirect_uris empty", { redirect_uris: [] }, "redirect-uris-missing"],
		["a wildcard redirect URI", { redirect_uris: ["https://*.example.com/cb"] }, "redirect-uri-invalid"],
		["a javascript: redirect URI", { redirect_uris: ["javascript:alert(1)"] }, "redirect-uri-invalid"],
		["a non-loopback http redirect URI", { redirect_uris: ["http://evil.example/cb"] }, "redirect-uri-invalid"],
		["a redirect URI with a fragment", { redirect_uris: ["https://a.example/cb#x"] }, "redirect-uri-invalid"],
		["token_endpoint_auth_method client_secret_basic", { token_endpoint_auth_method: "client_secret_basic" }, "token-endpoint-auth-method-must-be-none"],
		["token_endpoint_auth_method private_key_jwt", { token_endpoint_auth_method: "private_key_jwt" }, "token-endpoint-auth-method-must-be-none"],
		["token_endpoint_auth_method absent", { token_endpoint_auth_method: undefined }, "token-endpoint-auth-method-must-be-none"],
		["a client_secret", { client_secret: "s3cret" }, "client-secret-forbidden"],
	];
	for (const [label, over, reason] of cases) {
		it(`refuses ${label}`, async () => {
			await install({ respond: () => json(validDocument(over)) });
			expect(await cimd.resolveClientMetadata(DOC_URL)).toMatchObject({
				ok: false,
				reason,
			});
		});
	}

	it("refuses a body that is not JSON", async () => {
		await install({ respond: () => ({ body: bodyOf("<html>") }) });
		expect(await cimd.resolveClientMetadata(DOC_URL)).toMatchObject({
			ok: false,
			reason: "invalid-json",
		});
	});

	it("refuses a JSON array", async () => {
		await install({ respond: () => json([validDocument()]) });
		expect(await cimd.resolveClientMetadata(DOC_URL)).toMatchObject({
			ok: false,
			reason: "invalid-document",
		});
	});
});

describe("cache (draft §4.4)", () => {
	it("serves a second resolution from the cache, no second fetch", async () => {
		const rec = await install({ respond: () => json(validDocument()) });
		await cimd.resolveClientMetadata(DOC_URL);
		await cimd.resolveClientMetadata(DOC_URL);
		expect(rec.requests).toHaveLength(1);
	});

	it("expires: after the TTL the document is fetched again", async () => {
		let now = 1_000_000;
		const rec = await install({ now: () => now, respond: () => json(validDocument()) });
		await cimd.resolveClientMetadata(DOC_URL);
		now += cimd.CIMD_DEFAULT_TTL_MS + 1;
		await cimd.resolveClientMetadata(DOC_URL);
		expect(rec.requests).toHaveLength(2);
	});

	it("the TTL is bounded even when the server asks for a year", async () => {
		let now = 1_000_000;
		const rec = await install({
			now: () => now,
			respond: () => ({
				headers: { "content-type": "application/json", "cache-control": "max-age=31536000" },
				body: bodyOf(JSON.stringify(validDocument())),
			}),
		});
		await cimd.resolveClientMetadata(DOC_URL);
		now += cimd.CIMD_MAX_TTL_MS + 1;
		await cimd.resolveClientMetadata(DOC_URL);
		expect(rec.requests).toHaveLength(2);
	});

	it("honours no-store", async () => {
		const rec = await install({
			respond: () => ({
				headers: { "content-type": "application/json", "cache-control": "no-store" },
				body: bodyOf(JSON.stringify(validDocument())),
			}),
		});
		await cimd.resolveClientMetadata(DOC_URL);
		await cimd.resolveClientMetadata(DOC_URL);
		expect(rec.requests).toHaveLength(2);
	});

	it("never caches an error or an invalid document", async () => {
		let n = 0;
		const rec = await install({
			respond: () => {
				n++;
				return n === 1 ? { status: 500 } : n === 2 ? json({ nope: 1 }) : json(validDocument());
			},
		});
		expect((await cimd.resolveClientMetadata(DOC_URL)).ok).toBe(false);
		expect((await cimd.resolveClientMetadata(DOC_URL)).ok).toBe(false);
		expect((await cimd.resolveClientMetadata(DOC_URL)).ok).toBe(true);
		expect(rec.requests).toHaveLength(3);
	});

	it("the cache is bounded", async () => {
		cimd = await loadCimd();
		const rec = scripted({
			respond: (req) => json(validDocument({}, `https://${req.hostname}/c.json`)),
		});
		cimd._setClientMetadataDepsForTest(rec.deps);
		const n = cimd.CIMD_CACHE_MAX_ENTRIES + 5;
		for (let i = 0; i < n; i++) await cimd.resolveClientMetadata(`https://h${i}.example.com/c.json`);
		// the first entries were evicted: resolving the first again fetches again
		const before = rec.requests.length;
		await cimd.resolveClientMetadata("https://h0.example.com/c.json");
		expect(rec.requests.length).toBe(before + 1);
	});
});
