/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17bcj237901qqfghbzsnj13258k0adb (mcp-server-standard
// S-28 expand: orgRoster:getMyOrgRoster, orgRoster:getForAccessToken).
//
// Each door below takes `verifiedOrg` (believed from the fleet service account
// only) and answers the claim as a member of that organisation is answered.
// Doors: orgRoster:getMyOrgRoster, orgRoster:getForAccessToken
//
// Poles per door:
//   OWN        the claim names the row's organisation -> served / write applied
//   FOREIGN    the claim names another active organisation -> the member's answer
//   UNCHANGED  the service account with no claim -> as before (expand only)
//   REFUSED    a non-service caller presenting the claim -> RBAC_DENIED
//   INACTIVE   a claim naming an inactive organisation -> RBAC_DENIED

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

// Writes schedule RAG-sync functions; fake timers keep the scheduler under the
// test's control (same pattern as s28DoorDecisions.test.ts).
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
type Client = ReturnType<T["withIdentity"]>;

const OP = "s28x-op";
const A = "s28x-a";
const B = "s28x-b";
const D = "s28x-dead";
const OP_ID = testClerkOrgId(OP);
const A_ID = testClerkOrgId(A);
const B_ID = testClerkOrgId(B);
const D_ID = testClerkOrgId(D);
const claimA = { orgSlug: A, orgId: A_ID };
const claimB = { orgSlug: B, orgId: B_ID };
const claimDead = { orgSlug: D, orgId: D_ID };

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const memberOf = (t: T, slug: string) =>
	t.withIdentity({
		subject: `member-of-${slug}`,
		org_slug: slug,
		org_id: testClerkOrgId(slug),
		org_role: "org:admin",
	} as Identity);

const q = <R>(c: Client, ref: unknown, args: Record<string, unknown>) =>
	c.query(ref as never, args as never) as Promise<R>;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return `${(e as Error).message} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`;
	}
	return "NO-REFUSAL";
}

// One operator organisation, two client organisations and one inactive one, each
// active org with its roster agent (by ID).
async function seedOrgs(t: T): Promise<Record<string, Id<"agents">>> {
	await t.run(async (ctx) => {
		const org = (
			slug: string,
			id: string,
			roster: string,
			isActive: boolean,
			orgKind: "operator" | "client",
		) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: [roster],
				scopes: [
					"view-own-tasks",
					"view-own-missions",
					"view-stats-aggregated",
				],
				displayName: slug,
				isActive,
				orgKind,
				createdAt: 1,
			});
		await org(OP, OP_ID, "opa", true, "operator");
		await org(A, A_ID, "alice", true, "client");
		await org(B, B_ID, "bob", true, "client");
		await org(D, D_ID, "dan", false, "client");
	});
	return await seedRosterAgents(t);
}

async function world() {
	const t = createT();
	await seedOrgs(t);
	await t.run(async (ctx) => {
		for (const [slug, id] of [
			[A, A_ID],
			[B, B_ID],
		] as const) {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: `tok-${slug}`,
				clientId: "c",
				userId: "u",
				scopes: [],
				scopeProfile: "p",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: Date.now() + 3_600_000,
				createdAt: Date.now(),
				clerkOrgSlug: slug,
				clerkOrgId: id,
			});
		}
	});
	return t;
}

describe("orgRoster:getMyOrgRoster applies the verified org inside the read", () => {
	test("OWN: verifiedOrg A is A's own roster", async () => {
		const t = await world();
		const r = await q<string[]>(asService(t), api.orgRoster.getMyOrgRoster, {
			verifiedOrg: claimA,
		});
		expect(r).toEqual(["alice"]);
	});
	test("FOREIGN: verifiedOrg B is B's roster, never A's", async () => {
		const t = await world();
		const r = await q<string[]>(asService(t), api.orgRoster.getMyOrgRoster, {
			verifiedOrg: claimB,
		});
		expect(r).toEqual(["bob"]);
	});
	test("UNCHANGED: the service account with no claim keeps its legacy wire answer", async () => {
		const t = await world();
		const r = await q<string[]>(asService(t), api.orgRoster.getMyOrgRoster, {});
		expect(r).toEqual(["*"]);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const t = await world();
		const out = await codeOf(
			q(memberOf(t, A), api.orgRoster.getMyOrgRoster, { verifiedOrg: claimA }),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const t = await world();
		const out = await codeOf(
			q(asService(t), api.orgRoster.getMyOrgRoster, { verifiedOrg: claimDead }),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});

describe("orgRoster:getForAccessToken applies the verified org inside the read", () => {
	test("OWN: A's token with verifiedOrg A is A's roster", async () => {
		const t = await world();
		const r = await q<string[]>(asService(t), api.orgRoster.getForAccessToken, {
			tokenHash: `tok-${A}`,
			verifiedOrg: claimA,
		});
		expect(r).toEqual(["alice"]);
	});
	test("FOREIGN: A's token with verifiedOrg B is refused, no roster", async () => {
		const t = await world();
		const out = await codeOf(
			q(asService(t), api.orgRoster.getForAccessToken, {
				tokenHash: `tok-${A}`,
				verifiedOrg: claimB,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("token-outside-verified-org");
	});
	test("UNCHANGED: the service account with no claim reads B's token roster", async () => {
		const t = await world();
		const r = await q<string[]>(asService(t), api.orgRoster.getForAccessToken, {
			tokenHash: `tok-${B}`,
		});
		expect(r).toEqual(["bob"]);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const t = await world();
		const out = await codeOf(
			q(memberOf(t, A), api.orgRoster.getForAccessToken, {
				tokenHash: `tok-${A}`,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const t = await world();
		const out = await codeOf(
			q(asService(t), api.orgRoster.getForAccessToken, {
				tokenHash: `tok-${A}`,
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});
