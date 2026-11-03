/// <reference types="vite/client" />
//
// VantagePeers Cloud, task k170jd1dsdzy7pnnsjbjk0y5r98he2qe. Production defect
// (2026-11-03): an org admin whose agent is bound to her (personalAgentOf AND
// ownerPersonId both her own subject, `kind` and `authSubject` absent, accented
// name, registered from the organisation's roster) saw NO agent on the consent
// screen, only the create field. `choosableAgents` excluded every row carrying an
// `ownerPersonId`, including one owned by the very person choosing.
//
// Poles:
//   PRESENT  the person's own bound agent is listed, by ID, as `mine`.
//   DENY     another person's agent / another org's agent / an inactive agent /
//            an agent owned by someone else (even if bound to this person) /
//            a service agent: not listed, and a posted choice of it is refused.
//   AFTER    the choice stamps the agent on the code, then on the token; the
//            token acts as that agent.

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedMintProfile } from "../../tests/lib/seedMintProfile";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill") &&
			!path.includes("Backfill"),
	),
);

const SERVICE_ACCOUNT_ID = "test-service-account-user-id";
const MARIE = "user_3KrDIUId3qN4ANWphSicL6RsSHr";
const OTHER = "user_2someoneelse";
const SLUG = "iris-rh";
const ORG = testClerkOrgId(SLUG);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

async function seedOrg(t: T, slug: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: [],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

type Extra = {
	ownerPersonId?: string;
	personalAgentOf?: string;
	description?: string;
	isActive?: boolean;
	kind?: "service";
	normalizedName?: string;
};
const seedAgent = (t: T, name: string, extra: Extra = {}, slug = SLUG) =>
	t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			name,
			normalizedName: name.toLowerCase(),
			isActive: true,
			createdAt: Date.now(),
			...extra,
		}),
	);

const choices = (t: T, role = "org:admin") =>
	asService(t).query(api.oauth.listPersonalAgentChoices, {
		clerkUserId: MARIE,
		orgId: ORG,
		orgSlug: SLUG,
		orgRole: role,
	});

const record = (codeHash: string) => ({
	codeHash,
	clerkUserId: MARIE,
	orgId: ORG,
	orgSlug: SLUG,
	orgRole: "org:admin",
	clientId: "client-x",
	redirectUri: "https://claude.ai/cb",
	codeChallenge: "c",
	resource: "https://mcp.example/mcp",
	scope: "mcp:full",
	expiresAt: Date.now() + 600_000,
});

async function world() {
	const t = createT();
	await seedOrg(t, SLUG);
	await seedOrg(t, "other-org");
	// hélios, shaped exactly like the production row r57d7scv...: no kind, no authSubject.
	const helios = await seedAgent(t, "Hélios", {
		normalizedName: "hélios",
		ownerPersonId: MARIE,
		personalAgentOf: MARIE,
		description: "Iris RH agent, registered from the organisation's own roster",
	});
	return { t, helios };
}

describe("PRESENT: the person's own bound agent is offered", () => {
	test("hélios (owner = designated = Marie, no kind) is listed by ID as mine", async () => {
		const { t, helios } = await world();
		const r = await choices(t);
		expect(r.agents).toEqual([{ agentId: helios, name: "Hélios", mine: true }]);
		expect(r.canCreate).toBe(true);
	});
	test("an ordinary member sees her own bound agent too", async () => {
		const { t, helios } = await world();
		const r = await choices(t, "org:member");
		expect(r.agents.map((a) => a.agentId)).toEqual([helios]);
		expect(r.canCreate).toBe(false);
	});
});

describe("DENY: nobody else's agent, no other org, no inactive, no service", () => {
	test("none of these is listed or takeable", async () => {
		const { t, helios } = await world();
		const theirs = await seedAgent(t, "theirs", { personalAgentOf: OTHER });
		const ownedByOther = await seedAgent(t, "owned-by-other", {
			ownerPersonId: OTHER,
			personalAgentOf: MARIE,
		});
		const ownedByOtherUnbound = await seedAgent(t, "owned-unbound", {
			ownerPersonId: OTHER,
		});
		const ownedByMarieUnbound = await seedAgent(t, "owned-by-marie-unbound", {
			ownerPersonId: MARIE,
		});
		const foreign = await seedAgent(
			t,
			"foreign",
			{ personalAgentOf: MARIE, ownerPersonId: MARIE },
			"other-org",
		);
		const inactive = await seedAgent(t, "inactive", {
			personalAgentOf: MARIE,
			ownerPersonId: MARIE,
			isActive: false,
		});
		const service = await seedAgent(t, "svc", {
			personalAgentOf: MARIE,
			ownerPersonId: MARIE,
			kind: "service",
		});
		const r = await choices(t);
		expect(r.agents.map((a) => a.agentId)).toEqual([helios]);
		for (const id of [
			theirs,
			ownedByOther,
			ownedByOtherUnbound,
			ownedByMarieUnbound,
			foreign,
			inactive,
			service,
		]) {
			await expect(
				asService(t).mutation(api.oauth.putPersonCode, {
					record: record(`deny-${id}`),
					choice: { kind: "existing", agentId: id },
				}),
			).rejects.toThrow(/AGENT_CHOICE_REFUSED/);
		}
	});
});

describe("AFTER: the chosen agent is what the token acts as", () => {
	test("choice -> code row -> token -> acts as hélios", async () => {
		const { t, helios } = await world();
		const codeHash = createHash("sha256").update("code-1").digest("hex");
		await asService(t).mutation(api.oauth.putPersonCode, {
			record: record(codeHash),
			choice: { kind: "existing", agentId: helios },
		});
		const code = await t.run((ctx) =>
			ctx.db
				.query("oauth_person_codes")
				.withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
				.unique(),
		);
		expect(code?.agentId).toBe(helios);
		await seedMintProfile(t, "team-member", SLUG);
		const tokenHash = createHash("sha256").update("tok-1").digest("hex");
		await asService(t).mutation(api.oauth.createAccessToken, {
			tokenHash,
			clientId: "client-x",
			userId: MARIE,
			scopes: ["mcp:full"],
			scopeProfile: "team-member",
			fromAllowList: [],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3_600_000,
			clerkOrgSlug: SLUG,
			orgRole: "org:admin",
			principal: "person",
			codeHash,
		});
		const tok = await asService(t).query(api.oauth.getAccessTokenByHash, {
			tokenHash,
		});
		expect(tok?.personalAgent?.agentId).toBe(helios);
		expect(tok?.personalAgent?.agentName).toBe("Hélios");
	});
});
