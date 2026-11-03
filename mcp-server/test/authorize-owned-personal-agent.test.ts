/**
 * AUTHORIZE_OWNED_PERSONAL_AGENT (VantagePeers Cloud, task k170jd1dsdzy7pnnsjbjk0y5r98he2qe).
 *
 * Production, 2026-11-03: an org admin (Marie, Iris RH) whose roster-registered
 * agent "hélios" names her as BOTH owner and designated person saw no agent on
 * the consent screen, typed "Hélios" in the create field and Approve, and her
 * connection ended up acting as herself (token agentId empty).
 *
 * Poles:
 *   1 PRESENT  the picker lists hélios by id; choosing it mints a token acting as it
 *   2 DENY     a create whose name normalizes to hélios ("Hélios") is REFUSED with
 *              AGENT_NAME_TAKEN: no second row, no code, therefore no token
 *   3 DENY     an Approve that posts NO agent field at all, for a person who has a
 *              bound agent, is refused (never silently "connect as myself")
 *   4 PRESENT  an explicit "Connect as myself" (field posted empty) still works
 *
 * Harness: real Hono app against real Convex functions (test/lib/authorizeHarness.ts).
 */

import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { app } from "../server-http.js";
import {
	_setInternalClientForTest,
	sha256Base64Url,
	sha256Hex,
} from "../src/auth.js";
import {
	authorizeUrl,
	getAuthorize,
	type Harness,
	installAuthorizeHarness,
	membership,
	postOrg,
} from "./lib/authorizeHarness.js";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../convex/**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill") &&
			!path.includes("__tests__") &&
			!path.endsWith(".test.ts"),
	),
);

const SERVICE_ACCOUNT_ID = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const REDIRECT = "https://client.example/callback";
const CLIENT_ID = "client-claude";
const CLIENT_SECRET = "client-secret-raw";
const VERIFIER = "authorize-test-verifier-0123456789-0123456789-0123456789";
const ORG = "org_IrisRh";
const MARIE = "user_marie";

type T = ReturnType<typeof convexTest<typeof schema>>;

function bridge(t: T) {
	return {
		query: (name: string, args: Record<string, unknown>) =>
			t.query(makeFunctionReference<"query">(name) as never, args as never),
		mutation: (name: string, args: Record<string, unknown>) =>
			t.mutation(
				makeFunctionReference<"mutation">(name) as never,
				args as never,
			),
	};
}

let t: T;
let harness: Harness;
let challenge: string;
let helios: string;

beforeEach(async () => {
	harness = await installAuthorizeHarness();
	challenge = await sha256Base64Url(VERIFIER);
	t = convexTest(schema, modules);
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
	);
	const now = Date.now();
	helios = await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: "tenant-profile",
			description: "client's own profile",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("oauth_clients", {
			clientId: CLIENT_ID,
			clientSecretHash: await sha256Hex(CLIENT_SECRET),
			redirectUris: [REDIRECT],
			name: "Claude",
			scopeProfile: "tenant-profile",
			createdAt: now,
			tokenEndpointAuthMethod: "client_secret_basic",
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "iris-rh",
			clerkOrgId: ORG,
			allowedOrchestrators: [],
			scopes: ["vantage:read", "vantage:write"],
			displayName: "iris-rh",
			isActive: true,
			createdAt: now,
		});
		// Shaped like the production row: no kind, no authSubject, accented name.
		return await ctx.db.insert("agents", {
			orgSlug: "iris-rh",
			clerkOrgId: ORG,
			name: "hélios",
			normalizedName: "hélios",
			ownerPersonId: MARIE,
			personalAgentOf: MARIE,
			isActive: true,
			createdAt: now,
		});
	});
	harness.setMemberships(MARIE, [membership(ORG, "iris-rh", "org:admin")]);
});

afterEach(() => {
	harness.restore();
	_setInternalClientForTest(null);
});

async function approve(fields: Record<string, string>) {
	const session = await harness.session(MARIE);
	const shown = await getAuthorize(
		app,
		authorizeUrl({
			clientId: CLIENT_ID,
			redirectUri: REDIRECT,
			challenge,
			state: "xyz",
		}),
		session,
	);
	expect(shown.status).toBe(200);
	const picker = shown.picker as { state: string; consentToken: string };
	return {
		html: shown.html as string,
		result: await postOrg(
			app,
			{
				state: picker.state,
				orgId: ORG,
				approved: "true",
				consentToken: picker.consentToken,
				...fields,
			},
			session,
		),
	};
}

async function actingAs(code: string) {
	const res = await app.request("http://localhost:3000/token", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			code_verifier: VERIFIER,
			redirect_uri: REDIRECT,
			client_id: CLIENT_ID,
		}).toString(),
	});
	expect(res.status).toBe(200);
	const token = ((await res.json()) as { access_token: string }).access_token;
	const row = (await bridge(
		t.withIdentity({ subject: SERVICE_ACCOUNT_ID }),
	).query("oauth:getAccessTokenByHash", {
		tokenHash: await sha256Hex(token),
	})) as { personalAgent?: { agentId: string } | null } | null;
	return row?.personalAgent?.agentId ?? null;
}

const counts = () =>
	t.run(async (ctx) => ({
		codes: (await ctx.db.query("oauth_person_codes").collect()).length,
		agents: (await ctx.db.query("agents").collect()).filter(
			(a) => a.name !== "fleet-service-account",
		).length,
	}));

describe("1. the owned, designated agent is offered and chosen", () => {
	it("lists hélios by id and the token acts as it", async () => {
		const { html, result } = await approve({ [`agent_${ORG}`]: helios });
		expect(html).toContain(`value="${helios}"`);
		expect(result.status).toBe(302);
		expect(await actingAs(result.code as string)).toBe(helios);
	});
});

describe("2. a create whose name normalizes to the existing agent is refused", () => {
	it("'Hélios' -> AGENT_NAME_TAKEN, no second row, no code", async () => {
		const before = await counts();
		const { result } = await approve({
			[`agent_${ORG}`]: "",
			[`newAgent_${ORG}`]: "Hélios",
		});
		expect(result.status).toBe(403);
		expect(result.code).toBeUndefined();
		expect(JSON.stringify(result.json)).toContain("AGENT_NAME_TAKEN");
		expect(await counts()).toEqual(before);
	});
});

describe("3. never silently 'connect as myself' for a person who has a bound agent", () => {
	it("no agent field posted at all -> refused, no code", async () => {
		const before = await counts();
		const { result } = await approve({});
		expect(result.status).toBe(403);
		expect(result.code).toBeUndefined();
		expect(JSON.stringify(result.json)).toContain("AGENT_CHOICE_REFUSED");
		expect(await counts()).toEqual(before);
	});
});

const radios = (html: string) =>
	[
		...html.matchAll(
			/<input type="radio" name="agent_[^"]*" value="([^"]*)"( checked)?>/g,
		),
	].map((m) => ({ value: m[1], checked: m[2] !== undefined }));

describe("5. the bound agent is the default radio; 'myself' stays explicit", () => {
	it("(a) bound agent checked, 'myself' present and unchecked", async () => {
		const { html } = await approve({ [`agent_${ORG}`]: helios });
		const r = radios(html);
		expect(r.find((x) => x.value === helios)?.checked).toBe(true);
		expect(r.find((x) => x.value === "")?.checked).toBe(false);
		expect(r.filter((x) => x.checked)).toHaveLength(1);
	});
	it("(c) a person with no bound agent: 'myself' stays checked, approve with no field works", async () => {
		await t.run(async (ctx) => {
			await ctx.db.patch(helios as never, { isActive: false });
			await ctx.db.insert("agents", {
				orgSlug: "iris-rh",
				clerkOrgId: ORG,
				name: "shared",
				normalizedName: "shared",
				isActive: true,
				createdAt: Date.now(),
			});
		});
		const { html, result } = await approve({});
		const r = radios(html);
		expect(r.filter((x) => x.checked).map((x) => x.value)).toEqual([""]);
		expect(result.status).toBe(302);
		expect(await actingAs(result.code as string)).toBeNull();
	});
	it("(d) an unbound, another person's or another org's agent is never default-checked", async () => {
		await t.run(async (ctx) => {
			const base = { isActive: true, createdAt: Date.now() };
			await ctx.db.patch(helios as never, { isActive: false });
			await ctx.db.insert("agents", {
				orgSlug: "iris-rh",
				clerkOrgId: ORG,
				name: "shared",
				normalizedName: "shared",
				...base,
			});
			await ctx.db.insert("agents", {
				orgSlug: "iris-rh",
				clerkOrgId: ORG,
				name: "theirs",
				normalizedName: "theirs",
				personalAgentOf: "user_other",
				...base,
			});
			await ctx.db.insert("agents", {
				orgSlug: "other",
				clerkOrgId: "org_Other",
				name: "foreign",
				normalizedName: "foreign",
				personalAgentOf: MARIE,
				...base,
			});
		});
		const { html } = await approve({ [`agent_${ORG}`]: "" });
		expect(
			radios(html)
				.filter((x) => x.checked)
				.map((x) => x.value),
		).toEqual([""]);
		expect(html).not.toContain("theirs");
		expect(html).not.toContain("foreign");
	});
});

describe("4. an explicit 'Connect as myself' still works", () => {
	it("field posted empty -> a code, the token acts as nobody but the person", async () => {
		const { result } = await approve({ [`agent_${ORG}`]: "" });
		expect(result.status).toBe(302);
		expect(await actingAs(result.code as string)).toBeNull();
	});
});
