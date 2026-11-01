/// <reference types="vite/client" />
//
// VantagePeers Cloud — task k17cn591av7f4t070vj4hgymhx8hbab1. The write gate of a
// person token is decided by the ID of the agent the token acts as being on the
// organisation's roster BY ID, read live at request time, never by the label
// snapshot minted onto the token. `oauth:getAccessTokenByHash` carries that live
// fact as `personalAgent.onRoster`.
//
// Poles:
//   ON      the stamped agent's ID is in allowedAgentIds -> onRoster true, even though
//           the token's fromAllowList snapshot (taken before the agent joined) lacks it
//   LATE    the agent is added to the roster AFTER the token was minted -> true, no reconnect
//   OFF     the agent's ID is not in allowedAgentIds (label present in the snapshot) -> false
//   REMOVED the agent is taken off the roster after minting -> false
//   NOROSTER a mapping with no allowedAgentIds -> nobody is listed: false (refused by default)
//   INACTIVE the organisation is inactive -> no agent resolves at all (unchanged)
//   NONE    a token resolving no agent -> personalAgent null (unchanged)
//   ADD     addRosterMembers appends the agent's exact stored name as its label

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
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
const PERSON = "user_2onroster";
const SLUG = "org-roster";

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

async function seedOrg(
	t: T,
	allowedOrchestrators: string[],
	allowedAgentIds: Id<"agents">[] | undefined,
): Promise<Id<"client_org_mapping">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: SLUG,
			clerkOrgId: testClerkOrgId(SLUG),
			allowedOrchestrators,
			...(allowedAgentIds === undefined ? {} : { allowedAgentIds }),
			scopes: ["view-own-tasks"],
			displayName: SLUG,
			isActive: true,
			createdAt: Date.now(),
		}),
	);
}

const seedAgent = (t: T, name: string, personal = true) =>
	t.run(async (ctx) =>
		ctx.db.insert("agents", {
			orgSlug: SLUG,
			clerkOrgId: testClerkOrgId(SLUG),
			name,
			normalizedName: name.toLowerCase(),
			isActive: true,
			createdAt: Date.now(),
			...(personal ? { personalAgentOf: PERSON } : {}),
		}),
	);

let counter = 0;
async function mintPersonToken(
	t: T,
	snapshot: string[],
	agentId: Id<"agents">,
): Promise<string> {
	counter += 1;
	const tokenHash = createHash("sha256").update(`onr-${counter}`).digest("hex");
	await seedMintProfile(t, "team-member", SLUG);
	const id = await asService(t).mutation(api.oauth.createAccessToken, {
		tokenHash,
		clientId: `client-${counter}`,
		userId: PERSON,
		scopes: ["mcp:full"],
		scopeProfile: "team-member",
		fromAllowList: snapshot,
		namespaceReadPrefixes: [],
		namespaceWritePrefixes: [],
		expiresAt: Date.now() + 3_600_000,
		clerkOrgSlug: SLUG,
		orgRole: "org:member",
		principal: "person",
	});
	await t.run((ctx) => ctx.db.patch(id, { agentId }));
	return tokenHash;
}

const lookup = async (t: T, tokenHash: string) =>
	await asService(t).query(api.oauth.getAccessTokenByHash, { tokenHash });

describe("personalAgent.onRoster is read live from the mapping's roster by ID", () => {
	test("ON: ID on the roster, snapshot lacks the label", async () => {
		const t = createT();
		const a = await seedAgent(t, "Aria");
		await seedOrg(t, ["bo"], [a]);
		const row = await lookup(t, await mintPersonToken(t, ["bo"], a));
		expect(row?.personalAgent?.agentId).toBe(a);
		expect(row?.personalAgent?.onRoster).toBe(true);
	});

	test("LATE: added to the roster after the token was minted -> true without a reconnect", async () => {
		const t = createT();
		const a = await seedAgent(t, "Aria");
		const mapping = await seedOrg(t, ["bo"], []);
		const hash = await mintPersonToken(t, ["bo"], a);
		expect((await lookup(t, hash))?.personalAgent?.onRoster).toBe(false);
		await t.run((ctx) => ctx.db.patch(mapping, { allowedAgentIds: [a] }));
		expect((await lookup(t, hash))?.personalAgent?.onRoster).toBe(true);
	});

	test("OFF: ID not on the roster even though its label is in the snapshot", async () => {
		const t = createT();
		const a = await seedAgent(t, "Aria");
		const b = await seedAgent(t, "Bo", false);
		await seedOrg(t, ["Aria", "Bo"], [b]);
		const row = await lookup(t, await mintPersonToken(t, ["Aria"], a));
		expect(row?.personalAgent?.agentId).toBe(a);
		expect(row?.personalAgent?.onRoster).toBe(false);
	});

	test("REMOVED: taken off the roster after minting -> false", async () => {
		const t = createT();
		const a = await seedAgent(t, "Aria");
		const mapping = await seedOrg(t, ["aria"], [a]);
		const hash = await mintPersonToken(t, ["aria"], a);
		await t.run((ctx) => ctx.db.patch(mapping, { allowedAgentIds: [] }));
		expect((await lookup(t, hash))?.personalAgent?.onRoster).toBe(false);
	});

	test("NOROSTER: a mapping without allowedAgentIds lists nobody", async () => {
		const t = createT();
		const a = await seedAgent(t, "Aria");
		await seedOrg(t, ["aria"], undefined);
		const row = await lookup(t, await mintPersonToken(t, ["aria"], a));
		expect(row?.personalAgent?.agentId).toBe(a);
		expect(row?.personalAgent?.onRoster).toBe(false);
	});

	test("NONE: a token whose stamped agent is gone resolves no agent (unchanged)", async () => {
		const t = createT();
		const a = await seedAgent(t, "Aria");
		await seedOrg(t, ["aria"], [a]);
		const hash = await mintPersonToken(t, ["aria"], a);
		await t.run((ctx) => ctx.db.patch(a, { isActive: false }));
		expect((await lookup(t, hash))?.personalAgent).toBeNull();
	});
});

describe("addRosterMembers appends the agent's exact stored name", () => {
	test("ADD: a mixed-case name is appended as stored, not normalised", async () => {
		const t = createT();
		const a = await seedAgent(t, "Aria");
		await seedOrg(t, ["bo"], []);
		await t.mutation(internal.clientOrgMapping.addRosterMembers, {
			clerkOrgSlug: SLUG,
			agentIds: [a],
		});
		const row = await t.run(async (ctx) =>
			ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", SLUG))
				.unique(),
		);
		expect(row?.allowedOrchestrators).toEqual(["bo", "Aria"]);
		expect(row?.allowedAgentIds).toEqual([a]);
	});
});
