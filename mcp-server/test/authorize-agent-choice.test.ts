/**
 * AUTHORIZE_AGENT_CHOICE (VantagePeers Cloud, task k176wqmafpq7asbh461g95tk7h8hbsmy).
 *
 * After the organisation choice, the consent screen lists the agents of THAT
 * organisation the signed-in person may take as their own (an agent that
 * designates this person, or designates nobody), and an organisation admin may
 * also create one. Approve binds the chosen agent to the person in the same
 * Convex transaction that issues the authorization code; the minted token then
 * acts as that agent (`oauth:getAccessTokenByHash` -> `personalAgent`).
 *
 * Poles (numbers follow the brief):
 *   1 PRESENT   a member picks an unbound agent: listed, bound, the token acts as it
 *   2 DENY      an agent bound to ANOTHER person is neither listed nor selectable by a forged id
 *   3 DENY      an agent of ANOTHER organisation submitted by id; a NAME is never a selector
 *   4 PRESENT   an admin creates an agent: minted, bound, the token acts as it; a taken name refuses
 *   5 DENY      a non-admin posting a create is refused, nothing is written
 *   6 DENY      an agent bound to someone else between the picker and Approve: refused, no code
 *   7 ABSENT    no agent chosen: the person is approved as a person, as before
 *
 * Harness: the REAL Hono app against the REAL Convex functions (convex-test),
 * Clerk the only stand-in (test/lib/authorizeHarness.ts). Lives under test/, not
 * src/__tests__/, because the harness is there.
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
	type DriveResult,
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
const ORG_A = "org_A";
const ORG_B = "org_B";
const ORG_C = "org_C";
const ADMIN = "user_admin";
const MEMBER = "user_member";
const OTHER_PERSON = "user_other";
const OUTSIDER = "user_outsider";
const EMPTY_ORG_MEMBER = "user_emptyorg";

type T = ReturnType<typeof convexTest<typeof schema>>;
type AgentId = string;

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
let ids: {
	alpha: AgentId;
	bravo: AgentId;
	seat: AgentId;
	retired: AgentId;
	service: AgentId;
	foreign: AgentId;
};

beforeEach(async () => {
	harness = await installAuthorizeHarness();
	challenge = await sha256Base64Url(VERIFIER);
	t = convexTest(schema, modules);
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
	);
	const now = Date.now();
	ids = await t.run(async (ctx) => {
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
		for (const [slug, clerkOrgId] of [
			["org-a", ORG_A],
			["org-b", ORG_B],
			["org-c", ORG_C],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId,
				allowedOrchestrators: [],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: now,
			});
		}
		const agent = (
			orgSlug: string,
			clerkOrgId: string,
			name: string,
			extra: Record<string, unknown> = {},
		) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId,
				name,
				normalizedName: name.toLowerCase(),
				isActive: true,
				createdAt: now,
				...extra,
			});
		return {
			alpha: await agent("org-a", ORG_A, "Alpha"),
			bravo: await agent("org-a", ORG_A, "Bravo", {
				personalAgentOf: OTHER_PERSON,
			}),
			seat: await agent("org-a", ORG_A, "Seat", { ownerPersonId: "user_seat" }),
			retired: await agent("org-a", ORG_A, "Retired", { isActive: false }),
			service: await agent("org-a", ORG_A, "Service", { kind: "service" }),
			foreign: await agent("org-b", ORG_B, "Foreign"),
		};
	});
	harness.setMemberships(ADMIN, [membership(ORG_A, "org-a", "org:admin")]);
	harness.setMemberships(MEMBER, [membership(ORG_A, "org-a", "org:member")]);
	harness.setMemberships(OUTSIDER, [membership(ORG_B, "org-b", "org:member")]);
	harness.setMemberships(EMPTY_ORG_MEMBER, [
		membership(ORG_C, "org-c", "org:member"),
	]);
});

afterEach(() => {
	harness.restore();
	_setInternalClientForTest(null);
});

async function showPicker(userId: string): Promise<{
	picker: { state: string; consentToken: string };
	html: string;
	session: string;
}> {
	const session = await harness.session(userId);
	const r = await getAuthorize(
		app,
		authorizeUrl({
			clientId: CLIENT_ID,
			redirectUri: REDIRECT,
			challenge,
			state: "xyz",
		}),
		session,
	);
	expect(r.status).toBe(200);
	return {
		picker: r.picker as { state: string; consentToken: string },
		html: r.html as string,
		session,
	};
}

/** Walks the picker like a browser, then posts Approve with the given extra fields. */
async function approve(
	userId: string,
	orgId: string,
	fields: Record<string, string>,
	between?: () => Promise<void>,
): Promise<DriveResult> {
	const { picker, session } = await showPicker(userId);
	if (between) await between();
	return postOrg(
		app,
		{
			state: picker.state,
			orgId,
			approved: "true",
			consentToken: picker.consentToken,
			...fields,
		},
		session,
	);
}

async function tokenFor(code: string) {
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
	return ((await res.json()) as { access_token: string }).access_token;
}

async function resolvedAgent(accessToken: string) {
	const row = (await bridge(
		t.withIdentity({ subject: SERVICE_ACCOUNT_ID }),
	).query("oauth:getAccessTokenByHash", {
		tokenHash: await sha256Hex(accessToken),
	})) as {
		personalAgent?: { agentId: string; agentName: string } | null;
	} | null;
	return row?.personalAgent ?? null;
}

async function snapshot() {
	return await t.run(async (ctx) => ({
		codes: (await ctx.db.query("oauth_person_codes").collect()).length,
		// The fleet service account's own row is created lazily on its first call;
		// it is not part of what an Approve may change.
		agents: (await ctx.db.query("agents").collect())
			.filter((a) => a.name !== "fleet-service-account")
			.map((a) => ({
				id: a._id as string,
				name: a.name,
				personalAgentOf: a.personalAgentOf ?? null,
			})),
	}));
}

const boundTo = async (agentId: AgentId) =>
	(await snapshot()).agents.find((a) => a.id === agentId)?.personalAgentOf ??
	null;

describe("1. a member picks an unbound agent", () => {
	it("lists it by id with its name, binds it at Approve, and the token acts as it", async () => {
		const { html } = await showPicker(MEMBER);
		expect(html).toContain(`value="${ids.alpha}"`);
		expect(html).toContain("Alpha");
		// never listed: bound elsewhere, seat-owned, retired, service, another org's
		for (const hidden of [
			ids.bravo,
			ids.seat,
			ids.retired,
			ids.service,
			ids.foreign,
		]) {
			expect(html).not.toContain(hidden);
		}

		const r = await approve(MEMBER, ORG_A, {
			[`agent_${ORG_A}`]: ids.alpha,
		});
		expect(r.status).toBe(302);
		expect(r.code).toBeTruthy();
		expect(await boundTo(ids.alpha)).toBe(MEMBER);

		const acting = await resolvedAgent(await tokenFor(r.code as string));
		expect(acting?.agentId).toBe(ids.alpha);
		expect(acting?.agentName).toBe("Alpha");
	});

	it("escapes an agent name it renders", async () => {
		await t.run(async (ctx) =>
			ctx.db.patch(ids.alpha as never, { name: "<b>Al</b>&pha" }),
		);
		const { html } = await showPicker(MEMBER);
		expect(html).not.toContain("<b>Al</b>");
		expect(html).toContain("&lt;b&gt;Al&lt;/b&gt;&amp;pha");
	});
});

describe("2. an agent bound to another person", () => {
	it("is not listed, and a forged POST with its id is refused: no code, no write", async () => {
		const before = await snapshot();
		const r = await approve(MEMBER, ORG_A, { [`agent_${ORG_A}`]: ids.bravo });
		expect(r.status).toBe(403);
		expect(r.code).toBeUndefined();
		expect(JSON.stringify(r.json)).toContain("AGENT_CHOICE_REFUSED");
		expect(await snapshot()).toEqual(before);
		expect(await boundTo(ids.bravo)).toBe(OTHER_PERSON);
	});
});

describe("3. another organisation's agent, and names", () => {
	it("an agent of another org submitted by id is refused", async () => {
		const before = await snapshot();
		const r = await approve(MEMBER, ORG_A, {
			[`agent_${ORG_A}`]: ids.foreign,
		});
		expect(r.status).toBe(403);
		expect(r.code).toBeUndefined();
		expect(await snapshot()).toEqual(before);
	});

	it("the picker of another org's member never offers this org's agents", async () => {
		const { html } = await showPicker(OUTSIDER);
		expect(html).toContain(ids.foreign);
		expect(html).not.toContain(ids.alpha);
	});

	it("a NAME is never a selector: the name of a listed agent in the id field is refused", async () => {
		const before = await snapshot();
		const r = await approve(MEMBER, ORG_A, { [`agent_${ORG_A}`]: "Alpha" });
		expect(r.status).toBe(403);
		expect(r.code).toBeUndefined();
		expect(await snapshot()).toEqual(before);
	});

	it("a choice keyed to an organisation other than the chosen one is ignored (no cross-org carry-over)", async () => {
		const r = await approve(MEMBER, ORG_A, {
			[`agent_${ORG_B}`]: ids.foreign,
		});
		expect(r.status).toBe(302);
		expect(await boundTo(ids.foreign)).toBeNull();
		expect(await resolvedAgent(await tokenFor(r.code as string))).toBeNull();
	});
});

describe("4. an admin creates an agent", () => {
	it("offers the create field to the admin only", async () => {
		expect((await showPicker(ADMIN)).html).toContain(`newAgent_${ORG_A}`);
		expect((await showPicker(MEMBER)).html).not.toContain("newAgent_");
	});

	it("mints it in the org, binds it to the person, and the token acts as it", async () => {
		const r = await approve(ADMIN, ORG_A, { [`newAgent_${ORG_A}`]: "Nova" });
		expect(r.status).toBe(302);
		const created = (await snapshot()).agents.find((a) => a.name === "Nova");
		expect(created?.personalAgentOf).toBe(ADMIN);
		const row = await t.run(async (ctx) => ctx.db.get(created?.id as never));
		expect(row).toMatchObject({
			orgSlug: "org-a",
			clerkOrgId: ORG_A,
			isActive: true,
		});
		const acting = await resolvedAgent(await tokenFor(r.code as string));
		expect(acting?.agentId).toBe(created?.id);
	});

	it("a taken name (any case) is refused AGENT_NAME_TAKEN: no code, nothing created", async () => {
		const before = await snapshot();
		const r = await approve(ADMIN, ORG_A, { [`newAgent_${ORG_A}`]: "alpha" });
		expect(r.status).toBe(403);
		expect(r.code).toBeUndefined();
		expect(JSON.stringify(r.json)).toContain("AGENT_NAME_TAKEN");
		expect(await snapshot()).toEqual(before);
	});
});

describe("5. a non-admin posting a create", () => {
	it("is refused: no agent minted, no code", async () => {
		const before = await snapshot();
		const r = await approve(MEMBER, ORG_A, {
			[`newAgent_${ORG_A}`]: "Mallory",
		});
		expect(r.status).toBe(403);
		expect(r.code).toBeUndefined();
		expect(await snapshot()).toEqual(before);
	});
});

describe("6. the agent is bound to someone else between the picker and Approve", () => {
	it("is refused, no code is issued, the other binding stands", async () => {
		const r = await approve(
			MEMBER,
			ORG_A,
			{ [`agent_${ORG_A}`]: ids.alpha },
			async () => {
				await t.run(async (ctx) =>
					ctx.db.patch(ids.alpha as never, { personalAgentOf: OTHER_PERSON }),
				);
			},
		);
		expect(r.status).toBe(403);
		expect(r.code).toBeUndefined();
		expect((await snapshot()).codes).toBe(0);
		expect(await boundTo(ids.alpha)).toBe(OTHER_PERSON);
	});
});

describe("7. no agent chosen", () => {
	it("approves as a person, as before: a code, no agent bound, the token acts as nobody", async () => {
		const before = await snapshot();
		const r = await approve(MEMBER, ORG_A, {});
		expect(r.status).toBe(302);
		expect(r.code).toBeTruthy();
		expect((await snapshot()).agents).toEqual(before.agents);
		expect(await resolvedAgent(await tokenFor(r.code as string))).toBeNull();
	});

	it("a member with nothing to choose sees a plain 'ask your admin' line and can still approve", async () => {
		const { html } = await showPicker(EMPTY_ORG_MEMBER);
		expect(html).toContain("ask your admin");
		expect(html).not.toContain("newAgent_");
		const r = await approve(EMPTY_ORG_MEMBER, ORG_C, {});
		expect(r.status).toBe(302);
		expect(r.code).toBeTruthy();
	});
});
