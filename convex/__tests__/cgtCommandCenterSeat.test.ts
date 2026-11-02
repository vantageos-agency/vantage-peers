/// <reference types="vite/client" />
// allow-missing-refs: new file
/**
 * cgtCommandCenterSeat.test.ts - module M3. VantagePeers Cloud (multi-tenant).
 *
 * Pins the exact production shape of the CGT Command Center seat: an org-level
 * label L ("cgt-alsachimie") that is ALSO the name of an agent of that org, a scope
 * profile "L-L" allowlisting [L], and a seat token on that profile.
 *
 *   PRESENT  the profile is bound to the agent BY ID: the bearer lookup returns
 *            seatAgent { that agent's id, org slug, label L } (the MCP side of this
 *            contract is mcp-server/test/cgt-command-center-seat.test.ts).
 *   REFUSED  the SAME profile without agentId (the pre-bind state) resolves no
 *            agent, although an active agent named L sits in the same org: the
 *            label is not an identity. This is why the production bind
 *            (oauth:bindScopeProfileAgent) was required.
 *   PRESENT  binding the unbound profile afterwards makes the same token resolve.
 */
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { api } from "../_generated/api";
import schema from "../schema";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

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
const L = "cgt-alsachimie";
const PROFILE = `${L}-${L}`;
const X = testClerkOrgId(L);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

async function seedCgt(
	t: T,
	bound: boolean,
): Promise<{ agentId: Id<"agents"> }> {
	return await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: L,
			clerkOrgId: X,
			allowedOrchestrators: [L],
			scopes: ["view-own-tasks"],
			displayName: L,
			isActive: true,
			createdAt: Date.now(),
		});
		const agentId = await ctx.db.insert("agents", {
			orgSlug: L,
			clerkOrgId: X,
			name: L,
			normalizedName: L,
			isActive: true,
			createdAt: Date.now(),
		});
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: PROFILE,
			description: PROFILE,
			fromAllowList: [L],
			namespaceReadPrefixes: [`project/${L}`],
			namespaceWritePrefixes: [`project/${L}`],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			clerkOrgSlug: L,
			clerkOrgId: X,
			...(bound ? { agentId } : {}),
		});
		return { agentId };
	});
}

async function mintSeatToken(t: T, tokenHash: string): Promise<void> {
	await asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash,
		clientId: PROFILE,
		userId: "seat",
		scopes: ["mcp:full"],
		scopeProfile: PROFILE,
		fromAllowList: [L],
		namespaceReadPrefixes: [`project/${L}`],
		namespaceWritePrefixes: [`project/${L}`],
		expiresAt: Date.now() + 3_600_000,
		clerkOrgSlug: L,
	});
}

const lookup = (t: T, tokenHash: string) =>
	asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash });

describe("the CGT Command Center seat (org label == agent name)", () => {
	test("PRESENT: a profile bound by ID resolves seatAgent { agent id, org slug, label L }", async () => {
		const t = createT();
		const { agentId } = await seedCgt(t, true);
		await mintSeatToken(t, "cgt-hash-bound");
		const row = await lookup(t, "cgt-hash-bound");
		expect(row?.seatAgent).toEqual({
			agentId,
			orgId: L,
			agentName: L,
		});
		expect(row?.fromAllowList).toEqual([L]);
		expect(row?.clerkOrgSlug).toBe(L);
	});

	test("REFUSED: the same profile WITHOUT agentId resolves no agent, though an active agent named L is in the org", async () => {
		const t = createT();
		await seedCgt(t, false);
		await mintSeatToken(t, "cgt-hash-unbound");
		const row = await lookup(t, "cgt-hash-unbound");
		expect(row?.seatAgent).toBeNull();
		expect(row?.fromAllowList).toEqual([L]);
	});

	test("PRESENT: binding the unbound profile by ID (oauth:bindScopeProfileAgent) makes the token resolve the agent", async () => {
		const t = createT();
		const { agentId } = await seedCgt(t, false);
		await mintSeatToken(t, "cgt-hash-rebind");
		expect((await lookup(t, "cgt-hash-rebind"))?.seatAgent).toBeNull();
		const bound = await t.mutation(internal.oauth.bindScopeProfileAgent, {
			profileId: PROFILE,
			agentId,
		});
		expect(bound).toEqual({ profileId: PROFILE, agentId, previousAgentId: null });
		expect((await lookup(t, "cgt-hash-rebind"))?.seatAgent).toEqual({
			agentId,
			orgId: L,
			agentName: L,
		});
	});
});
