/// <reference types="vite/client" />
/**
 * `agentCredentials:resolveAgentCredential` binds an agent credential to its
 * human OWNER, through @vantageos/cloud-identity (`resolveCallerFromAgentCredential`).
 *
 * VantagePeers Cloud (multi-tenant). Task k1778c2hvae8e8vz9f5bbbbbb98g62hw, item 4b.
 *
 * POLES:
 *   PRESENT          owner set + live orgMembership of the agent's org -> resolves
 *   REFUSED owner    agent without ownerPersonId                       -> RBAC_DENIED owner-missing
 *   REFUSED member   owner set, no membership row                      -> RBAC_DENIED agent-owner-not-member
 *   REFUSED tombstone membership row with deletedAt                    -> RBAC_DENIED agent-owner-not-member
 *   REFUSED other org membership row for a DIFFERENT clerkOrgId        -> RBAC_DENIED agent-owner-not-member
 *   REFUSED no org   agent row without clerkOrgId                      -> RBAC_DENIED org-id-missing
 *   UNCHANGED        wrong secret / empty secret keep their reasons
 */
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { agentIdOf } from "../../tests/lib/agentIdOf";
import { ownAgent, ownerOf, tombstoneOwnerMembership } from "../../tests/lib/ownAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;

const DOOR = "agentCredentials:resolveAgentCredential";
const ORG = "org-own";

async function seedOrg(t: T, clerkOrgSlug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			clerkOrgId: testClerkOrgId(clerkOrgSlug),
			allowedOrchestrators: ["bot"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

const adminOf = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

/** An org with one agent "bot" and its minted secret; NO owner yet. */
async function mintUnowned(t: T, org: string): Promise<string> {
	await seedOrg(t, org);
	await adminOf(t, org).mutation(api.agents.registerAgent, {
		name: "bot",
	});
	const minted = await adminOf(t, org).mutation(
		api.agentCredentials.mintAgentCredential,
		{ agentId: await agentIdOf(t, org, "bot") },
	);
	return minted.secret;
}

const resolve = (t: T, presentedSecret: string) =>
	asServiceAccount(t).query(api.agentCredentials.resolveAgentCredential, {
		presentedSecret,
	});

async function refusalOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return typeof data === "string" ? data : String(e);
	}
	throw new Error("expected a refusal, got a success");
}

function expectRefused(text: string, reason: string) {
	expect(text).toContain("RBAC_DENIED");
	expect(text).toContain(DOOR);
	expect(text).toMatch(new RegExp(`reason\\\\*":\\\\*"${reason}`));
}

describe("resolveAgentCredential — the credential is bound to its human owner", () => {
	test("PRESENT: owner set and a live membership resolves to { orgSlug, agentName, agentId }", async () => {
		const t = createT();
		const secret = await mintUnowned(t, ORG);
		await ownAgent(t, ORG, "bot");
		const resolved = await resolve(t, secret);
		expect(resolved).toEqual({
			orgSlug: ORG,
			agentName: "bot",
			agentId: await agentIdOf(t, ORG, "bot"),
		});
	});

	test("REFUSED owner missing: an agent without ownerPersonId", async () => {
		const t = createT();
		const secret = await mintUnowned(t, ORG);
		expectRefused(await refusalOf(resolve(t, secret)), "owner-missing");
	});

	test("REFUSED not a member: owner set, no orgMembership row", async () => {
		const t = createT();
		const secret = await mintUnowned(t, ORG);
		const id = await agentIdOf(t, ORG, "bot");
		await t.run(async (ctx) => {
			await ctx.db.patch(id, { ownerPersonId: ownerOf(ORG) });
		});
		expectRefused(await refusalOf(resolve(t, secret)), "agent-owner-not-member");
	});

	test("REFUSED tombstoned: the membership row carries deletedAt", async () => {
		const t = createT();
		const secret = await mintUnowned(t, ORG);
		await ownAgent(t, ORG, "bot");
		// Control: it resolves before the tombstone.
		await resolve(t, secret);
		await tombstoneOwnerMembership(t, ORG, 5);
		expectRefused(await refusalOf(resolve(t, secret)), "agent-owner-not-member");
	});

	test("REFUSED other org: the membership row is of a different clerkOrgId", async () => {
		const t = createT();
		const secret = await mintUnowned(t, ORG);
		const id = await agentIdOf(t, ORG, "bot");
		await t.run(async (ctx) => {
			await ctx.db.patch(id, { ownerPersonId: ownerOf(ORG) });
			await ctx.db.insert("orgMembership", {
				clerkOrgSlug: "org-elsewhere",
				clerkOrgId: testClerkOrgId("org-elsewhere"),
				clerkUserId: ownerOf(ORG),
				role: "member",
				createdAt: 1,
				updatedAt: 1,
			});
		});
		expectRefused(await refusalOf(resolve(t, secret)), "agent-owner-not-member");
	});

	test("REFUSED no org id: an agent row without clerkOrgId", async () => {
		const t = createT();
		const secret = await mintUnowned(t, ORG);
		await ownAgent(t, ORG, "bot");
		const id = await agentIdOf(t, ORG, "bot");
		await t.run(async (ctx) => {
			await ctx.db.patch(id, { clerkOrgId: undefined });
		});
		expectRefused(await refusalOf(resolve(t, secret)), "org-id-missing");
	});

	test("UNCHANGED: wrong and empty secrets keep their reasons", async () => {
		const t = createT();
		const secret = await mintUnowned(t, ORG);
		await ownAgent(t, ORG, "bot");
		expectRefused(
			await refusalOf(resolve(t, "f".repeat(64))),
			"credential-not-recognised",
		);
		expectRefused(await refusalOf(resolve(t, "   ")), "no-credential");
		// and the live one still resolves
		expect(await resolve(t, secret)).toMatchObject({ agentName: "bot" });
	});
});

/** The MCP login path: the fleet's service account is the only caller this door serves. */
function asServiceAccount<X extends { withIdentity: (i: never) => unknown }>(
	t: X,
): ReturnType<X["withIdentity"]> {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as never) as ReturnType<X["withIdentity"]>;
}
