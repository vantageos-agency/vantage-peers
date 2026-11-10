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

	it("removes bidi, zero-width, format and line-separator characters from the name", async () => {
		await install({
			respond: () =>
				json(
					validDocument({
						client_name: "Cl\u202Eau\u200Bd\u2066e\uFEFF\u2028\u2029!\u200F",
					}),
				),
		});
		const r = await cimd.resolveClientMetadata(DOC_URL);
		expect(r.ok && r.client.clientName).toBe("Claude! (app.example.com)");
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
		["https://localhost./c.json", "host-not-public"],
		["https://intranet./c.json", "host-not-public"],
		[`https://app.example.com/${"x".repeat(600)}`, "client-id-too-long"],
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
		"::ffff:8.8.8.8", // the whole IPv4-mapped range is refused
		"::ffff:0:7f00:1", // SIIT (RFC 7915)
		"::ffff:0:8.8.8.8",
		"::127.0.0.1",
		"fe80::1",
		"fd00:ec2::254",
		"fc00::1",
		"ff02::1",
		"64:ff9b::7f00:1",
		"3fff::1",
		"3fff:0fff:ffff::1",
		"2001:10::1",
		"2001:20::1",
		"2002:7f00:1::1",
		"not-an-ip",
	];
	for (const ip of blocked) {
		it(`isBlockedAddress(${ip}) is true`, async () => {
			cimd = await loadCimd();
			expect(cimd.isBlockedAddress(ip)).toBe(true);
		});
	}
	for (const ip of [
		"93.184.216.34",
		"8.8.8.8",
		"172.32.0.1",
		"2606:2800:220:1:248:1893:25c8:1946",
	]) {
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
			respond: () => ({
				status: 302,
				headers: { location: "http://169.254.169.254/" },
			}),
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
				headers: {
					"content-type": "application/json",
					"content-length": "999999",
				},
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
				headers: {
					"content-type": "application/client-metadata+json; charset=utf-8",
				},
				body: bodyOf(JSON.stringify(validDocument())),
			}),
		});
		expect((await cimd.resolveClientMetadata(DOC_URL)).ok).toBe(true);
	});

	it("each path has a pool of its own that no other path can take (authorize, token, refresh)", async () => {
		cimd = await loadCimd();
		const rec = scripted({
			timeoutMs: 300,
			perSourceLimit: 1000,
			respond: () => new Promise(() => undefined),
		});
		cimd._setClientMetadataDepsForTest(rec.deps);
		const { authorize, token, refresh } = cimd.CIMD_POOL;
		expect(authorize + token + refresh).toBe(cimd.CIMD_MAX_IN_FLIGHT);
		let n = 0;
		const fill = (purpose: "authorize" | "token" | "refresh", count: number) =>
			Array.from({ length: count + 1 }, () => {
				n++;
				return cimd.resolveClientMetadata(`https://h${n}.dom${n}.com/c.json`, {
					purpose,
					source: `10.0.${n}.1`,
				});
			});
		const a = fill("authorize", authorize);
		const tk = fill("token", token);
		const rf = fill("refresh", refresh);
		await new Promise((r) => setTimeout(r, 30));
		// exactly pool-many fetches per purpose started, the extra one of each was busy
		expect(rec.requests).toHaveLength(authorize + token + refresh);
		const settled = await Promise.all([...a, ...tk, ...rf]);
		expect(settled.filter((r) => !r.ok && r.reason === "busy")).toHaveLength(3);
	});
});

describe("per-source fetch limit", () => {
	const doc = (req: { hostname: string }) =>
		json(validDocument({}, `https://${req.hostname}/c.json`));

	it("refuses a source past its allowance with rate-limited, other sources unaffected", async () => {
		await install({ perSourceLimit: 3, respond: doc });
		for (let i = 0; i < 3; i++) {
			const r = await cimd.resolveClientMetadata(
				`https://h${i}.example.com/c.json`,
				{ source: "1.2.3.4" },
			);
			expect(r.ok).toBe(true);
		}
		const over = await cimd.resolveClientMetadata(
			"https://h9.example.com/c.json",
			{ source: "1.2.3.4" },
		);
		expect(over).toMatchObject({
			ok: false,
			reason: "rate-limited",
			retryable: true,
		});
		const other = await cimd.resolveClientMetadata(
			"https://h9.example.com/c.json",
			{ source: "5.6.7.8" },
		);
		expect(other.ok).toBe(true);
	});

	it("cache hits do not count against the allowance", async () => {
		const rec = await install({
			perSourceLimit: 1,
			respond: () => json(validDocument()),
		});
		for (let i = 0; i < 5; i++) {
			const r = await cimd.resolveClientMetadata(DOC_URL, {
				source: "1.2.3.4",
			});
			expect(r.ok).toBe(true);
		}
		expect(rec.requests).toHaveLength(1);
	});

	it("the /token allowance is separate from the /authorize one", async () => {
		await install({ perSourceLimit: 1, respond: doc });
		const first = await cimd.resolveClientMetadata(
			"https://a.example.com/c.json",
			{
				source: "ip",
				purpose: "authorize",
			},
		);
		expect(first.ok).toBe(true);
		const second = await cimd.resolveClientMetadata(
			"https://b.example.com/c.json",
			{
				source: "ip",
				purpose: "authorize",
			},
		);
		expect(second).toMatchObject({ reason: "rate-limited" });
		const token = await cimd.resolveClientMetadata(
			"https://b.example.com/c.json",
			{
				source: "ip",
				purpose: "token",
			},
		);
		expect(token.ok).toBe(true);
	});

	it("the window reopens", async () => {
		let now = 1_000_000;
		await install({ now: () => now, perSourceLimit: 1, respond: doc });
		await cimd.resolveClientMetadata("https://a.example.com/c.json", {
			source: "ip",
		});
		const blocked = await cimd.resolveClientMetadata(
			"https://b.example.com/c.json",
			{
				source: "ip",
			},
		);
		expect(blocked).toMatchObject({ reason: "rate-limited" });
		now += cimd.CIMD_PER_SOURCE_WINDOW_MS + 1;
		const again = await cimd.resolveClientMetadata(
			"https://b.example.com/c.json",
			{
				source: "ip",
			},
		);
		expect(again.ok).toBe(true);
	});
});

describe("the document (draft §4.1, MCP implementation requirements)", () => {
	const cases: [string, Record<string, unknown>, string][] = [
		[
			"client_id differs from the URL",
			{ client_id: "https://app.example.com/other.json" },
			"client-id-mismatch",
		],
		["client_id absent", { client_id: undefined }, "client-id-mismatch"],
		[
			"redirect_uris absent",
			{ redirect_uris: undefined },
			"redirect-uris-missing",
		],
		["redirect_uris empty", { redirect_uris: [] }, "redirect-uris-missing"],
		[
			"a wildcard redirect URI",
			{ redirect_uris: ["https://*.example.com/cb"] },
			"redirect-uri-invalid",
		],
		[
			"a javascript: redirect URI",
			{ redirect_uris: ["javascript:alert(1)"] },
			"redirect-uri-invalid",
		],
		[
			"a non-loopback http redirect URI",
			{ redirect_uris: ["http://evil.example/cb"] },
			"redirect-uri-invalid",
		],
		[
			"a redirect URI with a fragment",
			{ redirect_uris: ["https://a.example/cb#x"] },
			"redirect-uri-invalid",
		],
		[
			"token_endpoint_auth_method client_secret_basic",
			{ token_endpoint_auth_method: "client_secret_basic" },
			"token-endpoint-auth-method-must-be-none",
		],
		[
			"token_endpoint_auth_method private_key_jwt",
			{ token_endpoint_auth_method: "private_key_jwt" },
			"token-endpoint-auth-method-must-be-none",
		],
		[
			"token_endpoint_auth_method absent",
			{ token_endpoint_auth_method: undefined },
			"token-endpoint-auth-method-must-be-none",
		],
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
		const rec = await install({
			now: () => now,
			respond: () => json(validDocument()),
		});
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
				headers: {
					"content-type": "application/json",
					"cache-control": "max-age=31536000",
				},
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
				headers: {
					"content-type": "application/json",
					"cache-control": "no-store",
				},
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
				return n === 1
					? { status: 500 }
					: n === 2
						? json({ nope: 1 })
						: json(validDocument());
			},
		});
		expect((await cimd.resolveClientMetadata(DOC_URL)).ok).toBe(false);
		expect((await cimd.resolveClientMetadata(DOC_URL)).ok).toBe(false);
		expect((await cimd.resolveClientMetadata(DOC_URL)).ok).toBe(true);
		expect(rec.requests).toHaveLength(3);
	});

	it("the cache is a true LRU: a hit keeps an entry, the least recently used is evicted", async () => {
		cimd = await loadCimd();
		const rec = scripted({
			perSourceLimit: 100000,
			respond: (req) =>
				json(validDocument({}, `https://${req.hostname}/c.json`)),
		});
		cimd._setClientMetadataDepsForTest(rec.deps);
		const max = cimd.CIMD_CACHE_MAX_ENTRIES;
		const url = (i: number) => `https://h${i}.example.com/c.json`;
		for (let i = 0; i < max; i++) await cimd.resolveClientMetadata(url(i));
		await cimd.resolveClientMetadata(url(0)); // a hit: h0 is now the most recent
		await cimd.resolveClientMetadata(url(max)); // one more: evicts h1, not h0
		const before = rec.requests.length;
		await cimd.resolveClientMetadata(url(0));
		expect(rec.requests.length).toBe(before); // still cached
		await cimd.resolveClientMetadata(url(1));
		expect(rec.requests.length).toBe(before + 1); // evicted, fetched again
	});
});

describe("H1 round 2 — the sentinel's probes", () => {
	const hang = {
		timeoutMs: 400,
		perSourceLimit: 1000,
	};
	const live = (req: { hostname: string }) =>
		req.hostname === "app.example.com"
			? json(validDocument())
			: new Promise<never>(() => undefined);

	it("probe A: eight distinct sources on /token do not stop the refresh from resolving", async () => {
		const rec = await install({ ...hang, respond: live });
		const flood = Array.from({ length: 8 }, (_, i) =>
			cimd.resolveClientMetadata(`https://h${i}.dom${i}.com/c.json`, {
				purpose: "token",
				source: `10.0.${i}.1`,
			}),
		);
		await new Promise((r) => setTimeout(r, 30));
		const refreshed = await cimd.resolveClientMetadata(DOC_URL, {
			purpose: "refresh",
			source: "9.9.9.9",
		});
		expect(refreshed.ok).toBe(true);
		const answers = await Promise.all(flood);
		expect(answers.filter((r) => !r.ok && r.reason === "busy")).toHaveLength(
			8 - cimd.CIMD_POOL.token,
		);
		expect(rec.requests.length).toBe(cimd.CIMD_POOL.token + 1);
	});

	it("probe B: one source bursting eight stays at its concurrency limit, and the refresh still resolves", async () => {
		const rec = await install({ ...hang, respond: live });
		const burst = Array.from({ length: 8 }, (_, i) =>
			cimd.resolveClientMetadata(`https://h${i}.dom${i}.com/c.json`, {
				purpose: "token",
				source: "6.6.6.6",
			}),
		);
		await new Promise((r) => setTimeout(r, 30));
		expect(rec.requests).toHaveLength(cimd.CIMD_PER_SOURCE_IN_FLIGHT);
		const refreshed = await cimd.resolveClientMetadata(DOC_URL, {
			purpose: "refresh",
			source: "6.6.6.6",
		});
		expect(refreshed.ok).toBe(true);
		const answers = await Promise.all(burst);
		expect(answers.filter((r) => !r.ok && r.reason === "busy")).toHaveLength(
			8 - cimd.CIMD_PER_SOURCE_IN_FLIGHT,
		);
	});

	it("many sources pointed at one hanging registrable domain hold at most its concurrency bound", async () => {
		const rec = await install({ ...hang, respond: live });
		const many = Array.from({ length: 6 }, (_, i) =>
			cimd.resolveClientMetadata(`https://sub${i}.shared.com/c.json`, {
				purpose: "token",
				source: `10.1.${i}.1`,
			}),
		);
		await new Promise((r) => setTimeout(r, 30));
		expect(rec.requests).toHaveLength(cimd.CIMD_PER_DOMAIN_IN_FLIGHT);
		const answers = await Promise.all(many);
		expect(answers.filter((r) => !r.ok && r.reason === "busy")).toHaveLength(
			6 - cimd.CIMD_PER_DOMAIN_IN_FLIGHT,
		);
	});

	it("concurrent resolutions of one client_id share one fetch", async () => {
		const rec = await install({
			respond: () => json(validDocument()),
		});
		const three = await Promise.all(
			[1, 2, 3].map((i) =>
				cimd.resolveClientMetadata(DOC_URL, { source: `10.2.${i}.1` }),
			),
		);
		expect(three.every((r) => r.ok)).toBe(true);
		expect(rec.requests).toHaveLength(1);
	});
});

describe("source key (the per-source limits key on it)", () => {
	it("IPv6 keys on its /64; IPv4 on the full address; a mapped IPv4 is that IPv4", async () => {
		cimd = await loadCimd();
		const k = cimd.sourceKeyOf;
		expect(k("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(k("2001:db8:1:2::1"));
		expect(k("2001:db8:1:2::1")).not.toBe(k("2001:db8:1:3::1"));
		expect(k("203.0.113.5")).toBe("203.0.113.5");
		expect(k("203.0.113.5")).not.toBe(k("203.0.113.6"));
		expect(k("::ffff:203.0.113.5")).toBe("203.0.113.5");
		expect(k("unknown")).toBe("unknown");
	});

	it("an IPv6 /64 rotated on every request shares ONE fetch allowance", async () => {
		await install({
			perSourceLimit: 2,
			respond: (req) =>
				json(validDocument({}, `https://${req.hostname}/c.json`)),
		});
		const from = (i: number) => `2001:db8:1:2:${i.toString(16)}::${i + 1}`;
		const results = [];
		for (let i = 0; i < 3; i++)
			results.push(
				await cimd.resolveClientMetadata(`https://a${i}.example.com/c.json`, {
					source: from(i + 1),
				}),
			);
		expect(results.map((r) => r.ok)).toEqual([true, true, false]);
		expect(results[2]).toMatchObject({ reason: "rate-limited" });
		const elsewhere = await cimd.resolveClientMetadata(
			"https://a9.example.com/c.json",
			{ source: "2001:db8:1:3::1" },
		);
		expect(elsewhere.ok).toBe(true);
	});
});

describe("client_name (round 2)", () => {
	it("folds compatibility forms (NFKC) and turns no-break and typographic spaces into one ASCII space", async () => {
		await install({
			respond: () =>
				json(
					validDocument({
						client_name: "\uFF21cme\u00A0\u2003\u2009Corp\u2000",
					}),
				),
		});
		const r = await cimd.resolveClientMetadata(DOC_URL);
		expect(r.ok && r.client.clientName).toBe("Acme Corp (app.example.com)");
	});
});

describe("round 3 — the domain bucket is the registrable domain, and never bounds a refresh", () => {
	const hang = { timeoutMs: 400, perSourceLimit: 1000 };
	const hangExcept =
		(...live: string[]) =>
		(req: { hostname: string }) =>
			live.includes(req.hostname)
				? json(validDocument({}, `https://${req.hostname}/c.json`))
				: new Promise<never>(() => undefined);
	const at = (
		host: string,
		purpose: "authorize" | "token" | "refresh",
		source: string,
	) =>
		cimd.resolveClientMetadata(`https://${host}/c.json`, { purpose, source });

	it("domainKeyOf: the registrable domain from the Public Suffix List, trailing dot stripped", async () => {
		cimd = await loadCimd();
		const k = cimd.domainKeyOf;
		expect(k("evil.vercel.app")).toBe("evil.vercel.app"); // vercel.app is a private suffix
		expect(k("victim.vercel.app")).toBe("victim.vercel.app");
		expect(k("a.b.example.co.uk")).toBe("example.co.uk");
		expect(k("a.one.com.")).toBe("one.com");
		expect(k("a.one.com")).toBe(k("b.one.com"));
		expect(k("a.one.com")).not.toBe(k("a.two.com"));
		expect(k("vercel.app")).toBeNull(); // a bare suffix has no registrable domain: never a key
	});

	it("probe E: two hanging fetches on evil.vercel.app do not refuse victim.vercel.app (refresh or token)", async () => {
		const rec = await install({
			...hang,
			respond: hangExcept("victim.vercel.app", "victim2.vercel.app"),
		});
		const evil = [
			at("evil.vercel.app", "token", "10.0.0.1"),
			at("evil2.vercel.app", "token", "10.0.0.2"),
		];
		await new Promise((r) => setTimeout(r, 30));
		const refresh = await at("victim.vercel.app", "refresh", "9.9.9.9");
		expect(refresh.ok).toBe(true);
		const token = await at("victim2.vercel.app", "token", "9.9.9.8");
		expect(token.ok).toBe(true);
		expect(rec.requests.length).toBeGreaterThanOrEqual(4);
		await Promise.all(evil);
	});

	it("probe F: trailing-dot hosts on different registrable domains do not share a `com.` bucket", async () => {
		const rec = await install({ ...hang, respond: hangExcept() });
		const three = [
			at("a.one.com.", "token", "10.0.0.1"),
			at("b.two.com.", "token", "10.0.0.2"),
			at("c.three.com.", "token", "10.0.0.3"),
		];
		await new Promise((r) => setTimeout(r, 30));
		expect(rec.requests).toHaveLength(3);
		const answers = await Promise.all(three);
		expect(answers.some((r) => !r.ok && r.reason === "busy")).toBe(false);
	});

	it("two subdomains of ONE registrable domain still share a bucket (also under a private suffix)", async () => {
		const rec = await install({ ...hang, respond: hangExcept() });
		const many = [
			at("a.evil.vercel.app", "token", "10.0.0.1"),
			at("b.evil.vercel.app", "token", "10.0.0.2"),
			at("c.evil.vercel.app", "token", "10.0.0.3"),
		];
		await new Promise((r) => setTimeout(r, 30));
		expect(rec.requests).toHaveLength(cimd.CIMD_PER_DOMAIN_IN_FLIGHT);
		const answers = await Promise.all(many);
		expect(answers.filter((r) => !r.ok && r.reason === "busy")).toHaveLength(1);
	});

	it("the refresh path has no domain bucket: a refresh is admitted while its domain is held by hanging fetches", async () => {
		const rec = await install({
			...hang,
			respond: hangExcept("legit.shared.com"),
		});
		const held = [
			at("x.shared.com", "token", "10.0.0.1"),
			at("y.shared.com", "token", "10.0.0.2"),
		];
		await new Promise((r) => setTimeout(r, 30));
		const refresh = await at("legit.shared.com", "refresh", "9.9.9.9");
		expect(refresh.ok).toBe(true);
		expect(rec.requests.length).toBe(3);
		await Promise.all(held);
	});
});

describe("round 4 — a host is a real hostname, and its domain key cannot be forged", () => {
	it("N1: empty labels are refused, so x1..attacker.example and x2..attacker.example cannot make distinct keys", async () => {
		await install();
		for (const id of [
			"https://x1..attacker.example/c.json",
			"https://x2..attacker.example/c.json",
		]) {
			expect(await cimd.resolveClientMetadata(id)).toMatchObject({
				ok: false,
				reason: "host-label-invalid",
			});
		}
	});

	it("N1: labels that are not LDH (leading or trailing hyphen, underscore, empty first label) are refused", async () => {
		const rec = await install();
		for (const id of [
			"https://-a.example.com/c.json",
			"https://a-.example.com/c.json",
			"https://un_der.example.com/c.json",
			"https://.example.com/c.json",
			"https://a.exa$mple.com/c.json",
		]) {
			const r = await cimd.resolveClientMetadata(id);
			expect(r.ok, id).toBe(false);
		}
		expect(rec.dnsQueries).toHaveLength(0);
	});

	it("N1: a host with no registrable domain (a public suffix) is refused, never keyed on the whole host", async () => {
		const rec = await install();
		expect(await cimd.resolveClientMetadata("https://co.uk/c.json")).toMatchObject({
			ok: false,
			reason: "domain-unresolvable",
		});
		expect(rec.dnsQueries).toHaveLength(0);
	});

	it("N1: a valid punycode host is still accepted", async () => {
		await install({
			respond: (req) => json(validDocument({}, `https://${req.hostname}/c.json`)),
		});
		const r = await cimd.resolveClientMetadata("https://xn--bcher-kva.example.com/c.json");
		expect(r.ok).toBe(true);
	});
});

describe("round 4 — the refresh pool is not held by two members, and a known client is not refused by load", () => {
	const VICTIM = "https://victim.example.org/c.json";
	const rig = (now: () => number) =>
		install({
			now,
			timeoutMs: 400,
			perSourceLimit: 1000,
			respond: (req) =>
				req.hostname === "victim.example.org"
					? json(validDocument({}, VICTIM))
					: new Promise<never>(() => undefined),
		});
	const refreshOf = (url: string, source: string, connection: string) =>
		cimd.resolveClientMetadata(url, { purpose: "refresh", source, connection });

	it("R3: two member URLs hanging hold both refresh slots; the victim's refresh still resolves from its stale document", async () => {
		let now = 1_000_000;
		await rig(() => now);
		const known = await cimd.resolveClientMetadata(VICTIM, { purpose: "authorize", source: "v" });
		expect(known.ok).toBe(true);
		now += cimd.CIMD_DEFAULT_TTL_MS + 1000; // expired, inside the stale window
		const held = [
			refreshOf("https://m1.dom1.com/c.json", "10.0.0.1", "t1"),
			refreshOf("https://m2.dom2.com/c.json", "10.0.0.2", "t2"),
		];
		await new Promise((r) => setTimeout(r, 30));
		const victim = await refreshOf(VICTIM, "9.9.9.9", "tv");
		expect(victim.ok).toBe(true);
		expect(victim.ok && known.ok && victim.client).toEqual(known.ok && known.client);
		await Promise.all(held);
	});

	it("the stale window is bounded: past it the document is not served", async () => {
		let now = 1_000_000;
		await rig(() => now);
		await cimd.resolveClientMetadata(VICTIM, { purpose: "authorize", source: "v" });
		now += cimd.CIMD_DEFAULT_TTL_MS + cimd.CIMD_STALE_MS + 1000;
		const held = [
			refreshOf("https://m1.dom1.com/c.json", "10.0.0.1", "t1"),
			refreshOf("https://m2.dom2.com/c.json", "10.0.0.2", "t2"),
		];
		await new Promise((r) => setTimeout(r, 30));
		expect(await refreshOf(VICTIM, "9.9.9.9", "tv")).toMatchObject({
			ok: false,
			reason: "busy",
		});
		await Promise.all(held);
	});

	it("a refresh whose fetch FAILS (5xx) is served stale; an authorize is not", async () => {
		let now = 1_000_000;
		let down = false;
		await install({
			now: () => now,
			perSourceLimit: 1000,
			respond: () => (down ? { status: 503 } : json(validDocument({}, VICTIM))),
		});
		await cimd.resolveClientMetadata(VICTIM, { purpose: "authorize", source: "v" });
		now += cimd.CIMD_DEFAULT_TTL_MS + 1000;
		down = true;
		expect((await refreshOf(VICTIM, "9.9.9.9", "tv")).ok).toBe(true);
		now += 0;
		const authorize = await cimd.resolveClientMetadata(VICTIM, {
			purpose: "authorize",
			source: "v2",
		});
		expect(authorize.ok).toBe(false);
	});

	it("a document that is now WRONG is not served stale: the refresh is refused", async () => {
		let now = 1_000_000;
		let wrong = false;
		await install({
			now: () => now,
			perSourceLimit: 1000,
			respond: () =>
				json(
					wrong
						? validDocument({ token_endpoint_auth_method: "client_secret_basic" }, VICTIM)
						: validDocument({}, VICTIM),
				),
		});
		await cimd.resolveClientMetadata(VICTIM, { purpose: "authorize", source: "v" });
		now += cimd.CIMD_DEFAULT_TTL_MS + 1000;
		wrong = true;
		expect(await refreshOf(VICTIM, "9.9.9.9", "tv")).toMatchObject({
			ok: false,
			reason: "token-endpoint-auth-method-must-be-none",
		});
	});

	it("one connection (refresh token) has at most one fetch in flight", async () => {
		const rec = await install({
			timeoutMs: 400,
			perSourceLimit: 1000,
			respond: () => new Promise<never>(() => undefined),
		});
		const two = [
			refreshOf("https://m1.dom1.com/c.json", "10.0.0.1", "same"),
			refreshOf("https://m2.dom2.com/c.json", "10.0.0.2", "same"),
		];
		await new Promise((r) => setTimeout(r, 30));
		expect(rec.requests).toHaveLength(1);
		const answers = await Promise.all(two);
		expect(answers.filter((a) => !a.ok && a.reason === "busy")).toHaveLength(1);
	});
});
