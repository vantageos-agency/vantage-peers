/// <reference types="vite/client" />
/**
 * RED reproduction, group R5 — orgRoster directory doors.
 * Audit rows: orgRoster:getAgentDirectoryForAccessToken, orgRoster:getMyAgentDirectory.
 * Origin of the world: convex/__tests__/inboxByAgentId.test.ts (operator org + client orgs),
 * convex/lib/operatorRosterAgents.ts (the rule sendMessage applies for a client roster name that
 * denotes an operator-org agent).
 *
 * Property under test (correct behaviour): a client org whose roster lists the fleet coordinator
 * "pi" learns pi's agent ID from the directory, because sendMessage admits that same operator agent
 * by ID. Today the directory looks the name up in the client org only.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { normalizeOrchestratorId } from "../../_helpers/normalizeOrchestratorId";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const OP = "vantage-fleet";
const C = "client-c";
const NOW = 1_700_000_000_000;
const TOKEN_HASH = "tokenhash-client-c";

async function seed() {
	const t = createT();
	const w = await t.run(async (ctx) => {
		const mapping = (slug: string, names: string[], operator: boolean) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: names,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(operator ? { orgKind: "operator" as const } : {}),
			});
		await mapping(OP, ["pi"], true);
		await mapping(C, ["pi", "ada"], false);
		const agent = (orgSlug: string, name: string) =>
			ctx.db.insert("agents", {
				orgSlug,
				name,
				normalizedName: normalizeOrchestratorId(name),
				isActive: true,
				createdAt: NOW,
			});
		const opPi: Id<"agents"> = await agent(OP, "pi");
		const cAda: Id<"agents"> = await agent(C, "ada");
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash: TOKEN_HASH,
			clientId: "c",
			userId: "u",
			scopes: [],
			scopeProfile: "p",
			fromAllowList: ["ada"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 3_600_000,
			createdAt: NOW,
			clerkOrgSlug: C,
		});
		return { opPi, cAda };
	});
	return { t, ...w };
}

const asService = (t: T) =>
	t.withIdentity({ subject: process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string });
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: "user-member-c",
		organizationSlug: org,
		org_role: "org:member",
	} as Parameters<T["withIdentity"]>[0]);

describe("orgRoster directory doors", () => {
	test("orgRoster:getAgentDirectoryForAccessToken — a client roster name that denotes the operator's pi resolves to pi's agent ID (identity: MCP service account + client-c token hash)", async () => {
		const { t, opPi, cAda } = await seed();
		const dir = await asService(t).query(
			api.orgRoster.getAgentDirectoryForAccessToken,
			{ tokenHash: TOKEN_HASH },
		);
		// positive control: the org's own agent resolves, so the door serves and can disagree.
		expect(dir.find((e) => e.name === "ada")?.agentId).toBe(cAda);
		expect(dir.find((e) => e.name === "pi")?.agentId).toBe(opPi);
	});

	test("orgRoster:getMyAgentDirectory — a client member's roster name that denotes the operator's pi resolves to pi's agent ID (identity: Clerk member of client-c)", async () => {
		const { t, opPi, cAda } = await seed();
		const dir = await asMember(t, C).query(api.orgRoster.getMyAgentDirectory, {});
		expect(dir.find((e) => e.name === "ada")?.agentId).toBe(cAda);
		expect(dir.find((e) => e.name === "pi")?.agentId).toBe(opPi);
	});
});
