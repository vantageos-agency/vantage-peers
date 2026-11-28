/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17bcj237901qqfghbzsnj13258k0adb (mcp-server-standard
// S-28 expand: githubRepoMapping:getByRepo).
//
// Each door below takes `verifiedOrg` (believed from the fleet service account
// only) and answers the claim as a member of that organisation is answered.
// Doors: githubRepoMapping:getByRepo
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
			await ctx.db.insert("githubRepoMapping", {
				repo: `${slug}/repo`,
				orchestrator: slug === A ? "alice" : "bob",
				project: `${slug}-project`,
				active: true,
				orgId: slug,
				clerkOrgId: id,
			} as never);
		}
	});
	return t;
}

describe("githubRepoMapping:getByRepo applies the verified org inside the read", () => {
	type Row = { repo: string } | null;
	test("OWN: verifiedOrg A reads A's repo", async () => {
		const t = await world();
		const r = await q<Row>(asService(t), api.githubRepoMapping.getByRepo, {
			repo: `${A}/repo`,
			verifiedOrg: claimA,
		});
		expect(r?.repo).toBe(`${A}/repo`);
	});
	test("FOREIGN: verifiedOrg A reading B's repo is refused as a member is", async () => {
		const t = await world();
		const out = await codeOf(
			q(asService(t), api.githubRepoMapping.getByRepo, {
				repo: `${B}/repo`,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
	});
	test("UNCHANGED: the service account with no claim reads B's repo", async () => {
		const t = await world();
		const r = await q<Row>(asService(t), api.githubRepoMapping.getByRepo, {
			repo: `${B}/repo`,
		});
		expect(r?.repo).toBe(`${B}/repo`);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const t = await world();
		const out = await codeOf(
			q(memberOf(t, A), api.githubRepoMapping.getByRepo, {
				repo: `${A}/repo`,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const t = await world();
		const out = await codeOf(
			q(asService(t), api.githubRepoMapping.getByRepo, {
				repo: `${A}/repo`,
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});
