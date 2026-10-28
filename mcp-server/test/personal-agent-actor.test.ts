/**
 * A PERSON token whose Convex lookup names a personal agent acts as that agent
 * through the one path a person with an agent credential already has: `actor`
 * (acting names bound, `verifiedActor` forwarded, no `verifiedPerson`). Convex
 * decides WHICH agent (resolvePersonalAgent); this side only refuses to believe
 * a stamp riding a non-person token (the org check is Convex's, by stored ID).
 * Task k17ee3efn6xz4zpapcg68sgvnh8h43gt.
 */
import { describe, expect, it } from "vitest";
import {
	type OAuthContext,
	personActorOf,
	personalActorOf,
} from "../src/auth.js";
import { verifiedActorOf } from "../src/verifiedActor.js";

const AGENT = { agentId: "agent_tele", orgId: "org-a", agentName: "telemaque" };

const personToken = (over: Partial<OAuthContext> = {}): OAuthContext => ({
	clientId: "c",
	userId: "user_2stephane",
	scopes: ["mcp:full"],
	scopeProfile: "team-member",
	fromAllowList: [],
	namespaceReadPrefixes: [],
	namespaceWritePrefixes: [],
	expiresAt: Date.now() + 60_000,
	isMaster: false,
	clerkOrgSlug: "org-a",
	principal: "person",
	accessTokenHash: "h",
	...over,
});

describe("personalActorOf", () => {
	it("PRESENT: a person token with a personal agent of its own org acts as that agent, by ID", () => {
		expect(personalActorOf(personToken({ personalAgent: AGENT }))).toEqual({
			orgSlug: "org-a",
			agentName: "telemaque",
			agentId: "agent_tele",
		});
	});

	it("ABSENT: null, absent, or an empty stamp leaves the person as the person", () => {
		expect(personalActorOf(personToken({ personalAgent: null }))).toBeUndefined();
		expect(personalActorOf(personToken())).toBeUndefined();
		expect(personalActorOf(personToken({ personalAgent: { ...AGENT, agentId: "" } }))).toBeUndefined();
		expect(personalActorOf(personToken({ personalAgent: { ...AGENT, agentName: "" } }))).toBeUndefined();
		expect(personalActorOf(null)).toBeUndefined();
	});

	it("DENY: a token that is not a person's never takes the stamp (a seat is a seat)", () => {
		const seat = personToken({ principal: undefined, personalAgent: AGENT });
		expect(personalActorOf(seat)).toBeUndefined();
	});
});

describe("the downstream surfaces take the one path they already have", () => {
	it("as the actor: verifiedActor carries the agent ID, and the person no longer acts under its own name", () => {
		const ctx = personToken({ personalAgent: AGENT });
		const actor = personalActorOf(ctx);
		const acting = { ...ctx, ...(actor ? { actor } : {}) };
		expect(verifiedActorOf(acting)).toEqual({ agentId: "agent_tele", orgSlug: "org-a" });
		expect(personActorOf(acting)).toBeUndefined();
		// Without the personal agent the same token is the person, as before.
		expect(personActorOf(ctx)).toBe("user:user_2stephane");
		expect(verifiedActorOf(ctx)).toBeUndefined();
	});
});
