/**
 * The bearer middleware, the REAL Convex functions (convex-test): a person token
 * whose person has designated ONE active agent of the token's org arrives with
 * `actor` = that agent (by ID); a person with none, with two, or whose only
 * designating agent is in ANOTHER org arrives as the person. Task
 * k17ee3efn6xz4zpapcg68sgvnh8h43gt.
 */
import { makeFunctionReference } from "convex/server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import {
	_setInternalClientForTest,
	bearerAuthMiddleware,
	type OAuthContext,
	personActorOf,
	sha256Hex,
} from "../src/auth.js";
import { verifiedActorOf } from "../src/verifiedActor.js";
import { seedMintProfile } from "../../tests/lib/seedMintProfile";

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
const STEPHANE = "user_2stephane";

type T = ReturnType<typeof convexTest<typeof schema>>;
let t: T;

function bridge(c: T) {
	return {
		query: (name: string, args: Record<string, unknown>) =>
			c.query(makeFunctionReference<"query">(name) as never, args as never),
		mutation: (name: string, args: Record<string, unknown>) =>
			c.mutation(makeFunctionReference<"mutation">(name) as never, args as never),
	};
}

async function seedAgent(org: string, name: string, personalAgentOf?: string) {
	return await t.run((ctx) =>
		ctx.db.insert("agents", {
			orgSlug: org,
			clerkOrgId: testClerkOrgId(org),
			name,
			normalizedName: name,
			isActive: true,
			createdAt: Date.now(),
			...(personalAgentOf ? { personalAgentOf } : {}),
		}),
	);
}

async function mint(userId: string, org: string, raw: string): Promise<string> {
	await seedMintProfile(t, "team-member", org);
	await t.withIdentity({ subject: SERVICE_ACCOUNT_ID }).mutation(
		makeFunctionReference<"mutation">("oauth:createAccessToken") as never,
		{
			tokenHash: await sha256Hex(raw),
			clientId: "claude",
			userId,
			scopes: ["mcp:full"],
			scopeProfile: "team-member",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3_600_000,
			clerkOrgSlug: org,
			orgRole: "org:member",
			principal: "person",
		} as never,
	);
	return raw;
}

async function contextOf(token: string): Promise<OAuthContext> {
	const probe = new Hono();
	probe.use("*", bearerAuthMiddleware());
	probe.get("/ctx", (c) => c.json(c.get("oauthContext")));
	const res = await probe.request("http://localhost:3000/ctx", {
		headers: { authorization: `Bearer ${token}` },
	});
	expect(res.status).toBe(200);
	return (await res.json()) as OAuthContext;
}

beforeEach(async () => {
	t = convexTest(schema, modules);
	_setInternalClientForTest(
		// biome-ignore lint/suspicious/noExplicitAny: test bridge
		bridge(t.withIdentity({ subject: SERVICE_ACCOUNT_ID })) as any,
	);
	await t.run(async (ctx) => {
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
});

afterEach(() => {
	_setInternalClientForTest(null);
});

describe("a person token through the bearer middleware", () => {
	it("PRESENT: the designated agent of the token's org becomes the actor, by ID; the person no longer acts under its own name", async () => {
		const tele = await seedAgent("org-a", "telemaque", STEPHANE);
		await seedAgent("org-a", "other");
		const ctx = await contextOf(await mint(STEPHANE, "org-a", "raw-present"));
		expect(ctx.principal).toBe("person");
		expect(ctx.actor).toEqual({ orgSlug: "org-a", agentName: "telemaque", agentId: tele });
		expect(verifiedActorOf(ctx)).toEqual({ agentId: tele, orgSlug: "org-a" });
		expect(personActorOf(ctx)).toBeUndefined();
	});

	it("ABSENT: no designation -> the person, exactly as today", async () => {
		await seedAgent("org-a", "telemaque");
		const ctx = await contextOf(await mint(STEPHANE, "org-a", "raw-absent"));
		expect(ctx.actor).toBeUndefined();
		expect(personActorOf(ctx)).toBe(`user:${STEPHANE}`);
	});

	it("AMBIGUOUS: two designating agents (written directly) -> the person", async () => {
		await seedAgent("org-a", "telemaque", STEPHANE);
		await seedAgent("org-a", "mentor", STEPHANE);
		const ctx = await contextOf(await mint(STEPHANE, "org-a", "raw-ambiguous"));
		expect(ctx.actor).toBeUndefined();
		expect(personActorOf(ctx)).toBe(`user:${STEPHANE}`);
	});

	it("DENY: the only designating agent is in ANOTHER org -> the person, never that agent", async () => {
		await seedAgent("org-b", "telemaque", STEPHANE);
		const ctx = await contextOf(await mint(STEPHANE, "org-a", "raw-foreign"));
		expect(ctx.actor).toBeUndefined();
		expect(verifiedActorOf(ctx)).toBeUndefined();
		expect(personActorOf(ctx)).toBe(`user:${STEPHANE}`);
	});
});
