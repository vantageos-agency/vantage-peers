/// <reference types="vite/client" />
/**
 * Audit R3 reproductions (convex/http.ts routes), driven through convex-test t.fetch.
 * Provenance: static audit of VantagePeers main @16f0907, rows http:* in defects-R3.jsonl.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const MASTER = "audit-r3-master-bearer-0001";

beforeEach(() => {
	vi.stubEnv("BEARER_SECRET_MASTER", MASTER);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

// ── POST /api/eta/verify-publish-token ───────────────────────────────────────
async function seedReviewTask(t: ReturnType<typeof convexTest>, note: string, orgId?: string) {
	return await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "reviewerDefault",
			value: ["eta"],
			updatedAt: Date.now(),
		});
		const now = Date.now();
		return await ctx.db.insert("tasks", {
			title: "foreign tenant review",
			assignedTo: "eta",
			priority: "high",
			status: "done",
			completionNote: note,
			createdBy: "sigma",
			createdAt: now,
			updatedAt: now,
			completedAt: now,
			...(orgId ? { orgId } : {}),
		});
	});
}

async function postVerify(t: ReturnType<typeof convexTest>, body: Record<string, string>) {
	return t.fetch("/api/eta/verify-publish-token", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${MASTER}` },
		body: JSON.stringify(body),
	});
}

describe("http:POST /api/eta/verify-publish-token", () => {
	// Identity: the fleet master bearer (the only credential this route accepts).
	test("http:POST /api/eta/verify-publish-token — a REVISE note plus a one-character expectedSha is not a valid publish approval", async () => {
		const t = convexTest(schema, modules);
		const taskId = await seedReviewTask(t, "REVISE: needs work", "acme");
		const res = await postVerify(t, { taskId, expectedSha: "e" });
		const data = (await res.json()) as { valid: boolean };
		expect(data.valid, "valid for a REVISE note matched by 1 char").toBe(false);
	});

	test("http:POST /api/eta/verify-publish-token — a refusal does not echo a client org's completionNote text", async () => {
		const t = convexTest(schema, modules);
		const SECRET_NOTE = "acme-confidential-note-marker-7731";
		const taskId = await seedReviewTask(t, SECRET_NOTE, "acme");
		const res = await postVerify(t, { taskId, expectedSha: "zzzz" });
		const text = await res.text();
		expect(text.includes(SECRET_NOTE), "response body contains acme's note text").toBe(false);
	});

	test("http:POST /api/eta/verify-publish-token — a task owned by a client org is not resolved", async () => {
		const t = convexTest(schema, modules);
		const taskId = await seedReviewTask(t, "[ETA-APPROVED] 9e5b63e7f4a2bc1d9e5b63e7f4a2bc1d9e5b63e7", "acme");
		const res = await postVerify(t, {
			taskId,
			expectedSha: "9e5b63e7f4a2bc1d9e5b63e7f4a2bc1d9e5b63e7",
		});
		const data = (await res.json()) as { valid: boolean; reason?: string };
		expect(data.valid, `valid:true for a task of org acme (reason=${data.reason})`).toBe(false);
	});
});

// ── POST /issueBearerFromClerk ───────────────────────────────────────────────
const ISS = "https://clerk.audit-r3.example";
const AUD = "audit-r3-expected-audience";
const EXT = "audit-r3-allowed-ext";

const b64u = (b: ArrayBuffer | Uint8Array | string) =>
	Buffer.from(typeof b === "string" ? b : new Uint8Array(b))
		.toString("base64")
		.replace(/=+$/, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");

async function makeSigner() {
	const kp = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	);
	const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
	const sign = async (claims: Record<string, unknown>) => {
		const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
		const p = b64u(JSON.stringify(claims));
		const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
		return `${h}.${p}.${b64u(sig)}`;
	};
	return { sign, jwks: { keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] } };
}

function stubJwks(jwks: unknown) {
	const real = globalThis.fetch;
	vi.stubGlobal("fetch", (input: unknown, init?: unknown) => {
		const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
		if (url.endsWith("/.well-known/jwks.json")) {
			return Promise.resolve(new Response(JSON.stringify(jwks), { status: 200 }));
		}
		return real(input as never, init as never);
	});
}

describe("http:POST /issueBearerFromClerk", () => {
	// Identity: a verified Clerk user (JWT signed by a test key whose JWKS is stubbed).
	beforeEach(() => {
		vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", ISS);
		vi.stubEnv("VP_CLERK_EXPECTED_AUD", AUD);
		vi.stubEnv("VP_ALLOWED_EXT_IDS", EXT);
	});

	test("http:POST /issueBearerFromClerk — an unauthenticated failure does not echo the expected audience or issuer", async () => {
		const t = convexTest(schema, modules);
		const { sign } = await makeSigner();
		const jwt = await sign({
			sub: "user_x",
			iss: ISS,
			aud: "some-other-audience",
			exp: Math.floor(Date.now() / 1000) + 600,
		});
		const res = await t.fetch("/issueBearerFromClerk", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ clerkJwt: jwt, extId: EXT }),
		});
		expect(res.status).toBe(401); // positive control: the failure path was reached
		const text = await res.text();
		expect(text.includes(AUD), "401 body contains the expected audience").toBe(false);
	});

	test("http:POST /issueBearerFromClerk — minting a second bearer leaves at most one live bearer for the user", async () => {
		const t = convexTest(schema, modules);
		const { sign, jwks } = await makeSigner();
		stubJwks(jwks);
		const mint = async () => {
			const jwt = await sign({
				sub: "user_mint",
				iss: ISS,
				aud: AUD,
				exp: Math.floor(Date.now() / 1000) + 600,
				email: "u@example.com",
			});
			return t.fetch("/issueBearerFromClerk", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ clerkJwt: jwt, extId: EXT }),
			});
		};
		const r1 = await mint();
		expect(r1.status).toBe(200); // positive control: minting works on the happy path
		const r2 = await mint();
		expect(r2.status).toBe(200);
		const live = await t.run(async (ctx) => {
			const rows = await ctx.db.query("userBearerTokens").collect();
			return rows.filter((r) => !r.revoked && r.expiresAt > Date.now()).length;
		});
		expect(live, "live bearers after two mints").toBeLessThanOrEqual(1);
	});
});
