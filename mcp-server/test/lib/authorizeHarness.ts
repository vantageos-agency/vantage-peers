/**
 * Test harness for the person-authorization flow: a Clerk session signer (a
 * real RSA key pair whose public half is injected as the JWKS), the Clerk
 * Backend API stand-ins, the environment the routes read, and a driver that
 * walks GET /authorize -> picker -> POST /authorize/org like a browser.
 *
 * Nothing here is a secret: the key pair is generated per run.
 */

import type { ClerkOrgMembership } from "@vantageos/cloud-identity";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { _setAuthorizeOverridesForTest } from "../../src/authorize.js";

export const HARNESS_ENV = {
	AUTHORIZE_STATE_SECRET: "test-state-secret-0123456789-0123456789-abcdef",
	CLERK_DOMAIN: "https://clerk.test.example",
	AUTHORIZE_SIGN_IN_URL: "https://dashboard.test.example/sign-in",
	AUTHORIZE_CALLBACK_URL: "http://localhost:3000/authorize/callback",
	PUBLIC_BASE_URL: "http://localhost:3000",
	CLERK_SECRET_KEY: "sk_test_harness_not_a_real_key",
} as const;

export const RESOURCE = "http://localhost:3000/mcp";

type AppLike = {
	request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

export type Harness = {
	/** A Clerk session token for `userId`, signed with the harness key. */
	session(userId: string, claims?: Record<string, unknown>): Promise<string>;
	/** The organisations Clerk reports for `userId`. */
	setMemberships(userId: string, memberships: ClerkOrgMembership[]): void;
	/** Environment restore + override reset. */
	restore(): void;
};

export async function installAuthorizeHarness(): Promise<Harness> {
	const { publicKey, privateKey } = await generateKeyPair("RS256", {
		extractable: true,
	});
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "harness-key",
		alg: "RS256",
	};
	const memberships = new Map<string, ClerkOrgMembership[]>();

	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(HARNESS_ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	_setAuthorizeOverridesForTest({
		jwks: { keys: [jwk] },
		listMemberships: async (userId) => memberships.get(userId) ?? [],
		getUser: async (userId) => ({
			id: userId,
			primaryEmailAddressId: "idn_1",
			emailAddresses: [
				{
					id: "idn_1",
					emailAddress: `${userId}@example.test`,
					verification: { status: "verified" },
				},
			],
		}),
	});

	return {
		async session(userId, claims = {}) {
			return await new SignJWT({
				sid: `sess_${userId}`,
				azp: "https://dashboard.test.example",
				...claims,
			})
				.setProtectedHeader({ alg: "RS256", kid: "harness-key" })
				.setIssuer(HARNESS_ENV.CLERK_DOMAIN)
				.setSubject(userId)
				.setIssuedAt()
				.setExpirationTime("10m")
				.sign(privateKey);
		},
		setMemberships(userId, list) {
			memberships.set(userId, list);
		},
		restore() {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			_setAuthorizeOverridesForTest(null);
		},
	};
}

export function membership(
	id: string,
	slug: string,
	role = "org:member",
): ClerkOrgMembership {
	return { role, organization: { id, slug, name: `Org ${slug}` } };
}

export type DriveResult = {
	status: number;
	/** `code` query parameter of the redirect to the client, when one was issued. */
	code?: string;
	location?: string;
	html?: string;
	json?: Record<string, unknown>;
	/** The picker's hidden fields, when the picker was shown. */
	picker?: { state: string; consentToken: string };
};

function hiddenField(html: string, name: string): string {
	const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
	return m ? m[1].replace(/&amp;/g, "&") : "";
}

async function read(res: Response): Promise<DriveResult> {
	const location = res.headers.get("location") ?? undefined;
	const type = res.headers.get("content-type") ?? "";
	const out: DriveResult = { status: res.status, location };
	if (location) {
		try {
			out.code = new URL(location).searchParams.get("code") ?? undefined;
		} catch {
			/* a relative or malformed location carries no code */
		}
	}
	if (type.includes("text/html")) {
		out.html = await res.text();
		out.picker = {
			state: hiddenField(out.html, "state"),
			consentToken: hiddenField(out.html, "consentToken"),
		};
	} else if (type.includes("json")) {
		out.json = (await res.json()) as Record<string, unknown>;
	}
	return out;
}

export function authorizeUrl(params: {
	clientId: string;
	redirectUri: string;
	challenge: string;
	resource?: string;
	state?: string;
	scope?: string;
}): string {
	const url = new URL("http://localhost:3000/authorize");
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", params.clientId);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("code_challenge", params.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("resource", params.resource ?? RESOURCE);
	if (params.state) url.searchParams.set("state", params.state);
	if (params.scope) url.searchParams.set("scope", params.scope);
	return url.toString();
}

export async function getAuthorize(
	app: AppLike,
	url: string,
	sessionToken?: string,
): Promise<DriveResult> {
	return read(
		await app.request(url, {
			method: "GET",
			redirect: "manual",
			headers: sessionToken ? { cookie: `__session=${sessionToken}` } : {},
		}),
	);
}

export async function postOrg(
	app: AppLike,
	form: Record<string, string | undefined>,
	sessionToken?: string,
): Promise<DriveResult> {
	const body = new URLSearchParams();
	for (const [k, v] of Object.entries(form))
		if (v !== undefined) body.set(k, v);
	return read(
		await app.request("http://localhost:3000/authorize/org", {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				...(sessionToken ? { cookie: `__session=${sessionToken}` } : {}),
			},
			body: body.toString(),
		}),
	);
}

/**
 * Walks the whole browser flow for a signed-in person: GET /authorize shows the
 * picker, the person picks `orgId` and approves (posting the picker's own
 * consentToken). Returns the final result (a 302 carrying the code on success).
 */
export async function authorizeAsPerson(
	app: AppLike,
	params: {
		clientId: string;
		redirectUri: string;
		challenge: string;
		sessionToken: string;
		orgId: string;
		state?: string;
		scope?: string;
	},
): Promise<DriveResult> {
	const first = await getAuthorize(
		app,
		authorizeUrl(params),
		params.sessionToken,
	);
	if (!first.picker) return first;
	return postOrg(
		app,
		{
			state: first.picker.state,
			orgId: params.orgId,
			approved: "true",
			consentToken: first.picker.consentToken,
		},
		params.sessionToken,
	);
}
