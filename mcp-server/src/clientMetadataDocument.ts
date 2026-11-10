/**
 * Client ID Metadata Documents (CIMD) — the client_id is an https URL and the
 * document at that URL is the client's registration.
 *
 * Spec: MCP authorization 2025-11-25 ("Client ID Metadata Documents") and
 * draft-ietf-oauth-client-id-metadata-document-00. Clauses implemented here:
 *
 *   draft §3   "Client identifier URLs MUST have an "https" scheme, MUST contain
 *              a path component, MUST NOT contain single-dot or double-dot path
 *              segments, MUST NOT contain a fragment component and MUST NOT
 *              contain a username or password."
 *   draft §4.1 "The client metadata document MUST contain a client_id property
 *              whose value MUST match the URL of the document using simple
 *              string comparison."
 *   draft §4.1 "the token_endpoint_auth_method property MUST NOT include
 *              client_secret_post, client_secret_basic, client_secret_jwt, or
 *              any other method based around a shared symmetric secret." and
 *              "the client_secret and client_secret_expires_at properties MUST
 *              NOT be used". Narrowed here to what the draft allows an AS to
 *              do: token_endpoint_auth_method MUST be "none" (public client).
 *   draft §4.3 "If fetching the metadata document fails, the authorization
 *              server SHOULD abort the authorization request."
 *   draft §4.4 "MUST NOT cache error responses ... MUST NOT cache documents
 *              which are invalid or malformed."
 *   draft §4.5 / RFC 9700: the redirect URI in a request is an exact match of a
 *              registered redirect URI.
 *   draft §6.5 "Authorization Servers SHOULD avoid fetching any URLs using
 *              private or loopback addresses".
 *   draft §6.6 "The recommended maximum response size for client metadata
 *              documents is 5 kilobytes."
 *   MCP        "MUST validate redirect URIs presented in an authorization
 *              request against those in the metadata document"; "MUST validate
 *              the document structure is valid JSON and contains required
 *              fields".
 *
 * AUTHORITY: the document is an anonymously registered object. It names a
 * client, its display name and the redirect URIs it may use; it grants
 * NOTHING. The rights of a token minted for a CIMD client come from the
 * authenticated person and the organisation mapping, exactly as for every
 * other client (.claude/rules/authority-attached-to-anonymous-object.md).
 *
 * SSRF: the URL comes from an unauthenticated caller and this server fetches
 * it. Controls, each pinned by test/cimd-resolver.test.ts: https only on the
 * default port; no userinfo, fragment, dot segments or IP-literal host; DNS is
 * resolved HERE, every returned address must be public, and the socket is
 * opened to that very address (the hostname is never resolved a second time,
 * so there is no rebinding window); the TLS certificate is checked against the
 * hostname; no redirect is followed; the body is capped; the whole exchange
 * has a time budget; the Content-Type must be JSON; the number of fetches in
 * flight is bounded.
 */

import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { getDomain } from "tldts";

/** Largest document accepted (draft §6.6 recommends 5 kilobytes). */
export const CIMD_MAX_BYTES = 5 * 1024;
/** Time budget for DNS + connect + TLS + the whole body. */
export const CIMD_TIMEOUT_MS = 3000;
/** Cache lifetime when the server gives no cache header, and the ceiling for any header. */
export const CIMD_DEFAULT_TTL_MS = 5 * 60 * 1000;
export const CIMD_MAX_TTL_MS = 60 * 60 * 1000;
/**
 * How long past its TTL a cached document may still be served to a REFRESH when
 * a fresh fetch is refused by load or fails in a way that may pass: a client the
 * server already knows is never refused by someone else's flood. Bounded; a
 * document that is now WRONG is never served stale.
 */
export const CIMD_STALE_MS = 60 * 60 * 1000;
/** Bound on cached documents and on fetches running at once. */
export const CIMD_CACHE_MAX_ENTRIES = 256;
/**
 * The fetch slots, split between the three paths that resolve a document. A
 * pool is its own: a path never borrows from another, so a flood of one cannot
 * starve the others. `refresh` (a person's existing connection) is the one the
 * others can never take; `token` is a code exchange for a NEW connection.
 */
export const CIMD_POOL = { authorize: 3, token: 3, refresh: 2 } as const;
export const CIMD_MAX_IN_FLIGHT =
	CIMD_POOL.authorize + CIMD_POOL.token + CIMD_POOL.refresh;
/** Fetches one source may have in flight at once, per path. */
export const CIMD_PER_SOURCE_IN_FLIGHT = 2;
/**
 * Fetches in flight at once toward one registrable domain (approximated by the
 * last two labels of the host), whoever asks: many sources pointed at one
 * hanging domain cannot hold the pools.
 */
export const CIMD_PER_DOMAIN_IN_FLIGHT = 2;
/** Network fetches one source address may start per window (cache hits are free). */
export const CIMD_PER_SOURCE_LIMIT = 10;
export const CIMD_PER_SOURCE_WINDOW_MS = 60 * 1000;
const CIMD_SOURCE_BUCKETS_MAX = 4096;
/** A client_id longer than this is refused before any parsing. */
export const CIMD_MAX_CLIENT_ID_LENGTH = 512;
const MAX_REDIRECT_URIS = 20;
const MAX_NAME_LENGTH = 100;

export type ClientMetadata = {
	clientId: string;
	/** Display name, sanitised and suffixed with the client_id host (draft §6.4). */
	clientName: string;
	redirectUris: string[];
};

export type ResolveResult =
	| { ok: true; client: ClientMetadata }
	| { ok: false; reason: string; retryable: boolean };

export type PinnedRequest = {
	hostname: string;
	/** The address validated as public; the socket is opened to this and nothing else. */
	ip: string;
	family: 4 | 6;
	path: string;
	signal: AbortSignal;
};

export type PinnedResponse = {
	status: number;
	headers: Record<string, string | undefined>;
	body: AsyncIterable<Uint8Array>;
	destroy(): void;
};

export type FetchDeps = {
	resolveHost(hostname: string): Promise<{ address: string; family: number }[]>;
	get(req: PinnedRequest): Promise<PinnedResponse>;
	now(): number;
	timeoutMs: number;
	maxBytes: number;
	perSourceLimit: number;
};

export type ResolveOptions = {
	/** Who asked (the caller's address); the per-source fetch limit is keyed on it. */
	source?: string;
	/**
	 * A refresh only: the connection (refresh-token digest). One connection has at
	 * most one fetch in flight.
	 */
	connection?: string;
	/**
	 * A refresh only: the person (the userId of the refresh-token record). One
	 * person has at most one refresh fetch in flight, over all their connections.
	 */
	person?: string;
	/** Which pool the fetch draws from; `authorize` is the default. */
	purpose?: "authorize" | "token" | "refresh";
};

// ─────────────────────────────────────────────────────────────────────────────
// Address policy
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_V4: [string, number][] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10], // CGNAT
	["127.0.0.0", 8],
	["169.254.0.0", 16], // link-local, cloud metadata 169.254.169.254
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved + broadcast
];

const BLOCKED_V6: [string, number][] = [
	["::", 128],
	["::1", 128],
	// IPv4-mapped ::ffff:0:0/96 is refused in isBlockedAddress itself, NOT here:
	// node's BlockList checks an IPv4 address against IPv6 rules as its mapped
	// form ::ffff:a.b.c.d, so a ::ffff:0:0/96 rule in this list would match
	// EVERY IPv4 address. The SIIT range below (::ffff:0:0:0/96) is a different
	// range and is safe to list.
	["::ffff:0:0:0", 96], // SIIT (RFC 7915)
	["64:ff9b::", 96], // NAT64
	["64:ff9b:1::", 48],
	["100::", 64], // discard
	["2001::", 32], // Teredo
	["2001:10::", 28], // ORCHID (deprecated)
	["2001:20::", 28], // ORCHIDv2
	["3fff::", 20], // documentation (RFC 9637)
	["2001:db8::", 32],
	["2002::", 16], // 6to4
	["fc00::", 7], // unique local (includes AWS fd00:ec2::254)
	["fe80::", 10], // link-local
	["fec0::", 10], // site-local
	["ff00::", 8], // multicast
];

const blockList = new net.BlockList();
for (const [net4, prefix] of BLOCKED_V4)
	blockList.addSubnet(net4, prefix, "ipv4");
for (const [net6, prefix] of BLOCKED_V6)
	blockList.addSubnet(net6, prefix, "ipv6");

/** The 8 groups of an IPv6 address, or null when it does not parse. */
function ipv6Groups(ip: string): number[] | null {
	const bare = ip.split("%")[0].toLowerCase();
	let text = bare;
	const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
	if (dotted) {
		if (!net.isIPv4(dotted[2])) return null;
		const [a, b, c, d] = dotted[2].split(".").map(Number);
		text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const all = [
		...head,
		...Array(halves.length === 2 ? missing : 0).fill("0"),
		...tail,
	];
	if (all.length !== 8) return null;
	const out = all.map((g) =>
		/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN,
	);
	return out.some(Number.isNaN) ? null : out;
}

/**
 * True when `ip` must never be fetched: private, loopback, link-local, CGNAT,
 * multicast, reserved, cloud-metadata, or an IPv6 form that embeds such an
 * IPv4 address (mapped, compatible). Anything that does not parse is blocked.
 */
export function isBlockedAddress(ip: string): boolean {
	if (net.isIPv4(ip)) return blockList.check(ip, "ipv4");
	if (!net.isIPv6(ip)) return true;
	const g = ipv6Groups(ip);
	if (!g) return true;
	// IPv4-mapped (::ffff:a.b.c.d): a resolver never answers with one for a
	// public host, so the whole range is refused.
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return true;
	const embedsV4 = g.slice(0, 6).every((x) => x === 0);
	if (embedsV4) {
		const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
		return blockList.check(v4, "ipv4");
	}
	return blockList.check(g.map((x) => x.toString(16)).join(":"), "ipv6");
}

// ─────────────────────────────────────────────────────────────────────────────
// URL shape (draft §3)
// ─────────────────────────────────────────────────────────────────────────────

/** True when a client_id is URL-shaped, i.e. an http(s) URL rather than an opaque registered id. */
export function isClientMetadataUrl(clientId: string): boolean {
	return /^https?:\/\//i.test(clientId);
}

export function parseClientMetadataUrl(
	clientId: string,
): { ok: true; url: URL } | { ok: false; reason: string } {
	const refuse = (reason: string) => ({ ok: false as const, reason });
	if (clientId.length > CIMD_MAX_CLIENT_ID_LENGTH)
		return refuse("client-id-too-long");
	if (!/^https:\/\//.test(clientId)) return refuse("scheme-not-https");
	// The checks on the raw string come first: the URL parser would silently
	// rewrite a default port, a dot segment or an empty fragment away.
	if (clientId.includes("#")) return refuse("fragment-forbidden");
	const rest = clientId.slice("https://".length);
	const authority = rest.split(/[/?]/)[0];
	if (authority.includes("@")) return refuse("userinfo-forbidden");
	if (/:\d*$/.test(authority) && !authority.endsWith("]"))
		return refuse("port-forbidden");
	const rawPath = rest.slice(authority.length).split("?")[0];
	if (rawPath.split("/").some((s) => s === "." || s === ".."))
		return refuse("dot-segments-forbidden");
	let url: URL;
	try {
		url = new URL(clientId);
	} catch {
		return refuse("invalid-client-id-url");
	}
	if (url.href !== clientId) return refuse("client-id-not-canonical");
	if (url.pathname === "/" || url.pathname === "")
		return refuse("path-required");
	// "localhost." and "intranet." are the same names with a root dot.
	const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
	if (net.isIP(host)) return refuse("ip-literal-host-forbidden");
	if (
		!host.includes(".") ||
		host === "localhost" ||
		host.endsWith(".localhost")
	)
		return refuse("host-not-public");
	// A real hostname: every label is LDH (letters, digits, hyphens, none at an
	// end; punycode `xn--` labels are LDH), none is empty. One root dot is
	// allowed at the end. An empty label is how `x1..a.example` and
	// `x2..a.example` would be two keys for one site.
	const labels = url.hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.split(".");
	if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)))
		return refuse("host-label-invalid");
	// The host must have a registrable domain: the per-domain bound keys on it.
	if (domainKeyOf(host) === null) return refuse("domain-unresolvable");
	return { ok: true, url };
}

// ─────────────────────────────────────────────────────────────────────────────
// Document validation (draft §4.1, MCP "Implementation Requirements")
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_REDIRECT_SCHEMES = new Set([
	"javascript:",
	"data:",
	"file:",
	"vbscript:",
	"blob:",
	"about:",
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validRedirectUri(uri: unknown): uri is string {
	if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048)
		return false;
	if (uri.includes("*") || uri.includes("#")) return false;
	let u: URL;
	try {
		u = new URL(uri);
	} catch {
		return false;
	}
	if (FORBIDDEN_REDIRECT_SCHEMES.has(u.protocol)) return false;
	if (u.username || u.password) return false;
	if (u.protocol === "http:") return LOOPBACK_HOSTS.has(u.hostname);
	return true;
}

function sanitiseName(raw: unknown): string {
	if (typeof raw !== "string") return "";
	// Compatibility forms are folded (NFKC) so a full-width or ligature
	// look-alike is shown as the plain text it imitates; no-break and
	// typographic spaces become one ASCII space. Then format characters
	// (\p{Cf}: bidi overrides U+202A-202E, isolates U+2066-2069, zero-width
	// U+200B-200F, BOM U+FEFF) and the line/paragraph separators U+2028-2029 are
	// REMOVED: they reorder or hide text on the consent screen. Control and
	// markup characters become spaces.
	const folded = raw
		.normalize("NFKC")
		.replace(/[\u00A0\u2000-\u200A]/g, " ")
		.replace(/[\p{Cf}\u2028\u2029]/gu, "");
	let out = "";
	for (const ch of folded) {
		const code = ch.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f || "<>\"'`&".includes(ch) ? " " : ch;
	}
	return out.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
}

function validateDocument(
	clientId: string,
	hostname: string,
	json: unknown,
): ResolveResult {
	const refuse = (reason: string): ResolveResult => ({
		ok: false,
		reason,
		retryable: false,
	});
	if (typeof json !== "object" || json === null || Array.isArray(json))
		return refuse("invalid-document");
	const doc = json as Record<string, unknown>;
	if (doc.client_id !== clientId) return refuse("client-id-mismatch");
	if ("client_secret" in doc || "client_secret_expires_at" in doc)
		return refuse("client-secret-forbidden");
	if (doc.token_endpoint_auth_method !== "none")
		return refuse("token-endpoint-auth-method-must-be-none");
	const uris = doc.redirect_uris;
	if (!Array.isArray(uris) || uris.length === 0)
		return refuse("redirect-uris-missing");
	if (uris.length > MAX_REDIRECT_URIS) return refuse("redirect-uris-too-many");
	if (!uris.every(validRedirectUri)) return refuse("redirect-uri-invalid");
	const name = sanitiseName(doc.client_name);
	return {
		ok: true,
		client: {
			clientId,
			clientName: name ? `${name} (${hostname})` : hostname,
			redirectUris: [...(uris as string[])],
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport — the only network code in this file
// ─────────────────────────────────────────────────────────────────────────────

/** GET over TLS to a pre-validated address; the certificate is checked against the hostname. */
function pinnedGet(req: PinnedRequest): Promise<PinnedResponse> {
	return new Promise((resolve, reject) => {
		const r = https.request(
			{
				host: req.ip,
				family: req.family,
				port: 443,
				servername: req.hostname,
				path: req.path,
				method: "GET",
				agent: false,
				signal: req.signal,
				headers: {
					Host: req.hostname,
					Accept: "application/json",
					"Accept-Encoding": "identity",
					"User-Agent": "VantagePeers-CIMD/1",
				},
			},
			(res) => {
				const headers: Record<string, string | undefined> = {};
				for (const [k, v] of Object.entries(res.headers))
					headers[k] = Array.isArray(v) ? v.join(", ") : v;
				resolve({
					status: res.statusCode ?? 0,
					headers,
					body: res,
					destroy: () => res.destroy(),
				});
			},
		);
		r.on("error", reject);
		r.end();
	});
}

const realDeps: FetchDeps = {
	resolveHost: (hostname) =>
		dns.promises.lookup(hostname, { all: true, verbatim: true }),
	get: pinnedGet,
	now: () => Date.now(),
	timeoutMs: CIMD_TIMEOUT_MS,
	maxBytes: CIMD_MAX_BYTES,
	perSourceLimit: CIMD_PER_SOURCE_LIMIT,
};

let deps: FetchDeps = realDeps;
const cache = new Map<string, { client: ClientMetadata; expiresAt: number }>();
const sourceBuckets = new Map<string, { count: number; resetAt: number }>();

/** Test seam: replaces the network pieces (and empties the cache); `null` restores the real ones. */
export function _setClientMetadataDepsForTest(
	d: Partial<FetchDeps> | null,
): void {
	deps = d ? { ...realDeps, ...d } : realDeps;
	cache.clear();
	sourceBuckets.clear();
	inFlightByPool.authorize = 0;
	inFlightByPool.token = 0;
	inFlightByPool.refresh = 0;
	inFlightBySource.clear();
	inFlightByDomain.clear();
	inFlightByConnection.clear();
	inFlightByPerson.clear();
	sharedFetch.clear();
}

/**
 * The key the per-source limits use. IPv4: the full address. IPv6: the /64
 * prefix, because one subscriber holds a whole /64 and can rotate the rest of
 * the address on every request. A mapped IPv4 (::ffff:a.b.c.d) is that IPv4.
 */
export function sourceKeyOf(address: string): string {
	const bare = address.split("%")[0].trim();
	if (net.isIPv4(bare)) return bare;
	if (net.isIPv6(bare)) {
		const g = ipv6Groups(bare);
		if (!g) return bare;
		if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
			return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
		return `${g
			.slice(0, 4)
			.map((x) => x.toString(16))
			.join(":")}::/64`;
	}
	return bare;
}

/**
 * The key of the per-domain bound: the registrable domain (eTLD+1) from the
 * Public Suffix List, private suffixes included, so `evil.vercel.app` and
 * `victim.vercel.app` are different keys while `a.one.com` and `b.one.com` are
 * one. A trailing dot is stripped first (`a.one.com.` is `a.one.com`). A host
 * with no registrable domain (a public suffix, or one that does not parse) has
 * NO key: `null`, never the whole host, which a caller could forge by varying
 * the host. parseClientMetadataUrl refuses such a host, so a fetch never sees it.
 */
export function domainKeyOf(hostname: string): string | null {
	const host = hostname.toLowerCase().replace(/\.+$/, "");
	return getDomain(host, { allowPrivateDomains: true });
}

/** Counts one fetch against `key`; false when the source has used its window's allowance. */
function takeSourceAllowance(key: string): boolean {
	const now = deps.now();
	const bucket = sourceBuckets.get(key);
	if (!bucket || bucket.resetAt <= now) {
		if (sourceBuckets.size >= CIMD_SOURCE_BUCKETS_MAX) {
			for (const [k, v] of sourceBuckets)
				if (v.resetAt <= now) sourceBuckets.delete(k);
			if (sourceBuckets.size >= CIMD_SOURCE_BUCKETS_MAX) {
				const oldest = sourceBuckets.keys().next().value;
				if (oldest !== undefined) sourceBuckets.delete(oldest);
			}
		}
		sourceBuckets.set(key, {
			count: 1,
			resetAt: now + CIMD_PER_SOURCE_WINDOW_MS,
		});
		return deps.perSourceLimit >= 1;
	}
	if (bucket.count >= deps.perSourceLimit) return false;
	bucket.count++;
	return true;
}

function ttlFromHeaders(cacheControl: string | undefined): number {
	if (!cacheControl) return CIMD_DEFAULT_TTL_MS;
	const lower = cacheControl.toLowerCase();
	if (/\b(no-store|no-cache|private)\b/.test(lower)) return 0;
	const m = lower.match(/max-age\s*=\s*(\d+)/);
	if (!m) return CIMD_DEFAULT_TTL_MS;
	return Math.min(Number(m[1]) * 1000, CIMD_MAX_TTL_MS);
}

/**
 * The cache reflects the latest SUCCESSFUL fetch. With a TTL the entry is
 * replaced; with none (`no-store`, `max-age=0`) it is DELETED, so an older copy
 * (say one that still listed a redirect URI the document dropped) can never be
 * served stale after a newer fetch superseded it.
 */
function remember(url: string, client: ClientMetadata, ttlMs: number): void {
	cache.delete(url);
	if (ttlMs <= 0) return;
	if (cache.size >= CIMD_CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(url, { client, expiresAt: deps.now() + ttlMs });
}

class Refused extends Error {
	constructor(
		readonly reason: string,
		readonly retryable = false,
	) {
		super(reason);
	}
}

async function readCapped(
	res: PinnedResponse,
	maxBytes: number,
	aborted: Promise<never>,
): Promise<string> {
	const declared = Number(res.headers["content-length"]);
	if (Number.isFinite(declared) && declared > maxBytes)
		throw new Refused("document-too-large");
	const chunks: Uint8Array[] = [];
	let total = 0;
	const it = res.body[Symbol.asyncIterator]();
	for (;;) {
		const step = await Promise.race([it.next(), aborted]);
		if (step.done) break;
		total += step.value.byteLength;
		if (total > maxBytes) throw new Refused("document-too-large");
		chunks.push(step.value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function fetchDocument(
	url: URL,
	clientId: string,
): Promise<ResolveResult> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const aborted = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Refused("fetch-timeout", true));
		}, deps.timeoutMs);
	});
	aborted.catch(() => undefined); // never an unhandled rejection when nobody is racing
	let res: PinnedResponse | undefined;
	try {
		const hostname = url.hostname;
		let answers: { address: string; family: number }[];
		try {
			answers = await Promise.race([deps.resolveHost(hostname), aborted]);
		} catch (err) {
			if (err instanceof Refused) throw err;
			throw new Refused("dns-failure", true);
		}
		if (answers.length === 0) throw new Refused("dns-failure", true);
		// EVERY answer must be public: a host that also resolves to an internal
		// address is refused, whichever one the connection would have picked.
		if (answers.some((a) => isBlockedAddress(a.address)))
			throw new Refused("address-blocked");
		const first = answers[0];
		try {
			res = await Promise.race([
				deps.get({
					hostname,
					ip: first.address,
					family: net.isIPv6(first.address) ? 6 : 4,
					path: `${url.pathname}${url.search}`,
					signal: controller.signal,
				}),
				aborted,
			]);
		} catch (err) {
			if (err instanceof Refused) throw err;
			throw new Refused("fetch-failed", true);
		}
		if (res.status >= 300 && res.status < 400)
			throw new Refused("redirect-refused");
		if (res.status !== 200) throw new Refused("bad-status", res.status >= 500);
		const type = (res.headers["content-type"] ?? "")
			.split(";")[0]
			.trim()
			.toLowerCase();
		if (
			type !== "application/json" &&
			!(type.startsWith("application/") && type.endsWith("+json"))
		)
			throw new Refused("bad-content-type");
		let text: string;
		try {
			text = await readCapped(res, deps.maxBytes, aborted);
		} catch (err) {
			if (err instanceof Refused) throw err;
			throw new Refused("fetch-failed", true);
		}
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Refused("invalid-json");
		}
		const verdict = validateDocument(clientId, hostname, json);
		if (verdict.ok)
			remember(
				clientId,
				verdict.client,
				ttlFromHeaders(res.headers["cache-control"]),
			);
		return verdict;
	} catch (err) {
		if (err instanceof Refused)
			return { ok: false, reason: err.reason, retryable: err.retryable };
		return { ok: false, reason: "fetch-failed", retryable: true };
	} finally {
		if (timer) clearTimeout(timer);
		controller.abort();
		res?.destroy();
	}
}

/**
 * Resolves a URL-shaped client_id to its validated metadata. Never throws.
 * A refusal carries a stable reason code; invalid or failed fetches are not
 * cached (draft §4.4).
 */
const inFlightByPool: Record<"authorize" | "token" | "refresh", number> = {
	authorize: 0,
	token: 0,
	refresh: 0,
};
const inFlightBySource = new Map<string, number>();
const inFlightByDomain = new Map<string, number>();
const inFlightByConnection = new Map<string, number>();
const inFlightByPerson = new Map<string, number>();
const sharedFetch = new Map<string, Promise<ResolveResult>>();

function bump(map: Map<string, number>, key: string, by: 1 | -1): void {
	const next = (map.get(key) ?? 0) + by;
	if (next <= 0) map.delete(key);
	else map.set(key, next);
}

export async function resolveClientMetadata(
	clientId: string,
	options: ResolveOptions = {},
): Promise<ResolveResult> {
	const parsed = parseClientMetadataUrl(clientId);
	if (!parsed.ok) return { ok: false, reason: parsed.reason, retryable: false };
	let stale: ClientMetadata | undefined;
	const hit = cache.get(clientId);
	if (hit) {
		const now = deps.now();
		cache.delete(clientId);
		if (hit.expiresAt > now) {
			cache.set(clientId, hit); // a hit refreshes recency (true LRU)
			return { ok: true, client: hit.client };
		}
		if (hit.expiresAt + CIMD_STALE_MS > now) {
			stale = hit.client;
			cache.set(clientId, hit); // kept for a refresh, inside the stale window
		}
	}
	const result = await resolveUncached(clientId, parsed.url, options);
	if (!result.ok) {
		// A refresh of a known client is not refused by load or by a blip.
		if (stale && options.purpose === "refresh" && result.retryable)
			return { ok: true, client: stale };
		// A document that is now wrong is never served stale again.
		if (!result.retryable) cache.delete(clientId);
	}
	return result;
}

async function resolveUncached(
	clientId: string,
	url: URL,
	options: ResolveOptions,
): Promise<ResolveResult> {
	// A fetch of this very document is already running: wait for it. It costs
	// no slot and no allowance, and a crowd asking for one document is one fetch.
	const running = sharedFetch.get(clientId);
	if (running) return await running;

	const purpose = options.purpose ?? "authorize";
	const source = sourceKeyOf(options.source ?? "unknown");
	const sourceKey = `${purpose}:${source}`;
	const connection =
		purpose === "refresh" && options.connection
			? options.connection
			: undefined;
	const person =
		purpose === "refresh" && options.person ? options.person : undefined;
	const domain = domainKeyOf(url.hostname);
	if (domain === null)
		return { ok: false, reason: "domain-unresolvable", retryable: false };
	const busy: ResolveResult = { ok: false, reason: "busy", retryable: true };
	if (inFlightByPool[purpose] >= CIMD_POOL[purpose]) return busy;
	if ((inFlightBySource.get(sourceKey) ?? 0) >= CIMD_PER_SOURCE_IN_FLIGHT)
		return busy;
	if (
		connection !== undefined &&
		(inFlightByConnection.get(connection) ?? 0) >= 1
	)
		return busy;
	if (person !== undefined && (inFlightByPerson.get(person) ?? 0) >= 1)
		return busy;
	// A refresh has no domain bucket: it keeps its own reserved pool, the
	// per-source limits and one fetch per connection.
	const boundByDomain = purpose !== "refresh";
	if (
		boundByDomain &&
		(inFlightByDomain.get(domain) ?? 0) >= CIMD_PER_DOMAIN_IN_FLIGHT
	)
		return busy;
	if (!takeSourceAllowance(sourceKey))
		return { ok: false, reason: "rate-limited", retryable: true };
	inFlightByPool[purpose]++;
	bump(inFlightBySource, sourceKey, 1);
	if (connection !== undefined) bump(inFlightByConnection, connection, 1);
	if (person !== undefined) bump(inFlightByPerson, person, 1);
	if (boundByDomain) bump(inFlightByDomain, domain, 1);
	const work = fetchDocument(url, clientId).finally(() => {
		inFlightByPool[purpose]--;
		bump(inFlightBySource, sourceKey, -1);
		if (connection !== undefined) bump(inFlightByConnection, connection, -1);
		if (person !== undefined) bump(inFlightByPerson, person, -1);
		if (boundByDomain) bump(inFlightByDomain, domain, -1);
		sharedFetch.delete(clientId);
	});
	sharedFetch.set(clientId, work);
	return await work;
}
