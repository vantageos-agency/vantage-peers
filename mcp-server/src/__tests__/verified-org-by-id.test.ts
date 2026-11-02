/**
 * VantagePeers Cloud MCP, module M18 (task k170dkz2nye4es0fpszqcjvhe18g3jw5):
 * the `verifiedOrg` claim carries the organisation's permanent Clerk ID beside
 * its slug, and `fixPatterns:get` carries the verified agent's ID.
 *
 * Poles: the ID rides when the verified token carries it for the SAME org the
 * slug names; it is absent (slug-only, still accepted by Convex) when the token
 * has none, when an agent credential names a different org than the token, and
 * for the master / a Clerk session (which forward no org claim at all).
 */
import { describe, expect, it } from "vitest";
import type { OAuthContext } from "../auth.js";
import {
	resolveDoorScope,
	verifiedOrgIdOf,
	verifiedOrgSlugOf,
} from "../doorScope.js";
import { VERIFIED_ACTOR_DOORS, withVerifiedActor } from "../verifiedActor.js";

const base = {
	userId: "u",
	scopes: ["mcp:full"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
};

const tokenCtx = (over: Partial<OAuthContext>): OAuthContext =>
	({
		...base,
		clientId: "c",
		scopeProfile: "team-member",
		fromAllowList: [],
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		...over,
	}) as unknown as OAuthContext;

describe("verifiedOrgIdOf", () => {
	it("returns the token's org ID when the verified slug is the token's slug", () => {
		const ctx = tokenCtx({ clerkOrgSlug: "acme", orgClerkId: "org_AAA" });
		expect(verifiedOrgSlugOf(ctx)).toBe("acme");
		expect(verifiedOrgIdOf(ctx)).toBe("org_AAA");
	});

	it("is undefined when the token carries no ID (the Convex predates it, or the org has none)", () => {
		expect(verifiedOrgIdOf(tokenCtx({ clerkOrgSlug: "acme" }))).toBeUndefined();
		expect(
			verifiedOrgIdOf(tokenCtx({ clerkOrgSlug: "acme", orgClerkId: "" })),
		).toBeUndefined();
	});

	it("rides beside an agent credential too: the boundary binds the actor to the token's org", () => {
		const ctx = tokenCtx({
			clerkOrgSlug: "acme",
			orgClerkId: "org_AAA",
			actor: { orgSlug: "acme", agentName: "eta", agentId: "a1" },
		});
		expect(verifiedOrgIdOf(ctx)).toBe("org_AAA");
	});

	it("no door forwards an org claim to the master or a Clerk session, so no ID rides either", () => {
		const master = tokenCtx({
			isMaster: true,
			clerkOrgSlug: "acme",
			orgClerkId: "org_A",
		});
		expect(verifiedOrgSlugOf(master)).toBeUndefined();
		expect(verifiedOrgIdOf(undefined)).toBeUndefined();
	});
});

describe("resolveDoorScope forwards the org ID beside the slug", () => {
	const facts = {
		hasVerifiedActor: false,
		seat: { kind: "none" as const },
	};

	it("sends { orgSlug, orgId } when the facts carry both", () => {
		const r = resolveDoorScope("businessUnits:list", undefined, {
			...facts,
			verifiedOrgSlug: "acme",
			verifiedOrgId: "org_AAA",
		});
		expect(r).toEqual({
			args: { verifiedOrg: { orgSlug: "acme", orgId: "org_AAA" } },
		});
	});

	it("sends the slug alone when no ID is known (expand: Convex still accepts it)", () => {
		const r = resolveDoorScope("businessUnits:list", undefined, {
			...facts,
			verifiedOrgSlug: "acme",
		});
		expect(r).toEqual({ args: { verifiedOrg: { orgSlug: "acme" } } });
	});
});

describe("fixPatterns:get carries the verified agent", () => {
	it("is a verified-actor door and the wrapper adds the proof", async () => {
		expect(VERIFIED_ACTOR_DOORS.has("fixPatterns:get")).toBe(true);
		const seen: unknown[] = [];
		const convex = {
			mutation: () => undefined,
			query: (_name: string, args: unknown) => {
				seen.push(args);
				return null;
			},
		};
		const ctx = tokenCtx({
			clerkOrgSlug: "acme",
			actor: { orgSlug: "acme", agentName: "eta", agentId: "agent_1" },
		});
		const wrapped = withVerifiedActor(convex, ctx);
		await (
			wrapped.query as unknown as (n: string, a: unknown) => Promise<unknown>
		)("fixPatterns:get", { patternId: "p" });
		expect(seen).toEqual([
			{
				patternId: "p",
				verifiedActor: { agentId: "agent_1", orgSlug: "acme" },
			},
		]);
	});
});
