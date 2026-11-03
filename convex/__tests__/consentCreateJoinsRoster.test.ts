/// <reference types="vite/client" />
//
// VantagePeers Cloud, task k17bckpq7bvdqk74adr9cdfpfs8hhsxj. Defect: the consent
// page's "create an agent" inserted an `agents` row and touched no roster. A person
// token's sender list is the mapping's `allowedOrchestrators`, the org's ID roster is
// `allowedAgentIds`; a new client org seeded with empty rosters left its admin's fresh
// agent unable to write.
//
// Poles:
//   AFTER    the created agent's id and exact stored name are on the roster, and the
//            token minted from that code carries the name in its sender list.
//   APPEND   existing roster entries are kept.
//   DENY     a second identical create is AGENT_NAME_TAKEN and adds nothing; a
//            non-admin cannot create; another org's roster is not touched; an org
//            with no mapping row refuses the create.
//   OPERATOR an operator org's roster is not edited by this path.

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedMintProfile } from "../../tests/lib/seedMintProfile";
import { api } from "../_generated/api";
import schema from "../schema";

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
const SLUG = "sp-prive";

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT_ID });

async function seedOrg(
	t: T,
	slug: string,
	extra: { allowedOrchestrators?: string[]; orgKind?: "operator" } = {},
) {
	return await t.run(async (ctx) =>
		ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: [],
			scopes: ["view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
			...extra,
		}),
	);
}

const record = (codeHash: string, role = "org:admin", slug = SLUG) => ({
	codeHash,
	clerkUserId: MARIE,
	orgId: testClerkOrgId(slug),
	orgSlug: slug,
	orgRole: role,
	clientId: "client-x",
	redirectUri: "https://claude.ai/cb",
	codeChallenge: "c",
	resource: "https://mcp.example/mcp",
	scope: "mcp:full",
	expiresAt: Date.now() + 600_000,
});

const create = (t: T, name: string, codeHash: string, role = "org:admin") =>
	asService(t).mutation(api.oauth.putPersonCode, {
		record: record(codeHash, role),
		choice: { kind: "create", name },
	});

const mapping = (t: T, slug = SLUG) =>
	t.run(async (ctx) =>
		ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
			.unique(),
	);

const agentByName = (t: T, name: string) =>
	t.run(async (ctx) => {
		const rows = await ctx.db
			.query("agents")
			.withIndex("by_org", (q) => q.eq("orgSlug", SLUG))
			.collect();
		return rows.find((a) => a.name === name) ?? null;
	});

describe("AFTER: a created agent joins the roster in the same transaction", () => {
	test("empty rosters -> id and exact stored name appended, token may send as it", async () => {
		const t = createT();
		await seedOrg(t, SLUG);
		const codeHash = createHash("sha256").update("code-1").digest("hex");
		await create(t, "Éclair", codeHash);
		const agent = await agentByName(t, "Éclair");
		expect(agent).not.toBeNull();
		const row = await mapping(t);
		expect(row?.allowedAgentIds ?? []).toContain(agent?._id);
		expect(row?.allowedOrchestrators).toContain("Éclair");

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
		expect(tok?.fromAllowList).toContain("Éclair");
		expect(tok?.personalAgent?.agentId).toBe(agent?._id);
	});

	test("APPEND: existing roster entries are kept and not reordered", async () => {
		const t = createT();
		await seedOrg(t, SLUG, { allowedOrchestrators: ["Hélios", "Zed"] });
		await create(t, "Éclair", "h-append");
		const row = await mapping(t);
		expect(row?.allowedOrchestrators).toEqual(["Hélios", "Zed", "Éclair"]);
	});
});

describe("DENY", () => {
	test("a second identical create is AGENT_NAME_TAKEN and adds nothing", async () => {
		const t = createT();
		await seedOrg(t, SLUG);
		await create(t, "Éclair", "h-1");
		const before = await mapping(t);
		await expect(create(t, "Éclair", "h-2")).rejects.toThrow(/AGENT_NAME_TAKEN/);
		const after = await mapping(t);
		expect(after?.allowedAgentIds).toEqual(before?.allowedAgentIds);
		expect(after?.allowedOrchestrators).toEqual(before?.allowedOrchestrators);
		expect(
			after?.allowedOrchestrators.filter((n) => n === "Éclair"),
		).toHaveLength(1);
	});

	test("a non-admin cannot create and the roster is untouched", async () => {
		const t = createT();
		await seedOrg(t, SLUG);
		await expect(create(t, "Éclair", "h-3", "org:member")).rejects.toThrow(
			/AGENT_CHOICE_REFUSED/,
		);
		const row = await mapping(t);
		expect(row?.allowedOrchestrators).toEqual([]);
		expect(row?.allowedAgentIds ?? []).toEqual([]);
	});

	test("another org's roster is not touched", async () => {
		const t = createT();
		await seedOrg(t, SLUG);
		await seedOrg(t, "other-org", { allowedOrchestrators: ["Keep"] });
		await create(t, "Éclair", "h-4");
		const other = await mapping(t, "other-org");
		expect(other?.allowedOrchestrators).toEqual(["Keep"]);
		expect(other?.allowedAgentIds ?? []).toEqual([]);
	});

	test("an org with no mapping row refuses the create, nothing is inserted", async () => {
		const t = createT();
		await expect(create(t, "Éclair", "h-5")).rejects.toThrow(
			/ORG_MAPPING_NOT_FOUND/,
		);
		expect(await agentByName(t, "Éclair")).toBeNull();
	});
});

describe("OPERATOR: the operator org's roster is not edited by this path", () => {
	test("the agent is created, the operator roster is unchanged", async () => {
		const t = createT();
		await seedOrg(t, SLUG, {
			orgKind: "operator",
			allowedOrchestrators: ["Pi"],
		});
		await create(t, "Éclair", "h-6");
		const row = await mapping(t);
		expect(row?.allowedOrchestrators).toEqual(["Pi"]);
		expect(row?.allowedAgentIds ?? []).toEqual([]);
	});
});
