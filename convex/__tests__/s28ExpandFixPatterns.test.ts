/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17bcj237901qqfghbzsnj13258k0adb (mcp-server-standard
// S-28 expand: fixPatterns:listByProject, fixPatterns:listAll).
//
// Each door below takes `verifiedOrg` (believed from the fleet service account
// only) and answers the claim as a member of that organisation is answered.
// Doors: fixPatterns:listByProject, fixPatterns:listAll
//
// Poles per door:
//   OWN        the claim names the row's organisation -> served / write applied
//   FOREIGN    the claim names another active organisation -> the member's answer
//   UNCHANGED  the service account with no claim -> as before (expand only)
//   REFUSED    a non-service caller presenting the claim -> RBAC_DENIED
//   INACTIVE   a claim naming an inactive organisation -> RBAC_DENIED
// These are fleet-only doors: the table carries no organisation column. The operator
// organisation's own claim is the fleet (served); a claim naming a CLIENT organisation is
// answered as that organisation's member is (RBAC_DENIED not-fleet-master, or the typed
// empty value the door already gives a member). OWN below is therefore the operator claim.
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
const claimOp = { orgSlug: OP, orgId: OP_ID };
const claimA = { orgSlug: A, orgId: A_ID };
const claimDead = { orgSlug: D, orgId: D_ID };
const NOW = 1_780_000_000_000;

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
		await ctx.db.insert("fixPatterns", {
			symptom: "s28 symptom",
			rootCause: "rc",
			tags: [],
			stack: [],
			sourceProject: "s28-project",
			createdBy: "opa",
			severity: "minor",
			createdAt: NOW,
			updatedAt: NOW,
		} as never);
	});
	return t;
}

describe("fixPatterns:listByProject applies the verified org inside the read", () => {
	const args = { sourceProject: "s28-project" };
	test("OWN: the operator org's claim is served", async () => {
		const t = await world();
		const r = await q<unknown[]>(asService(t), api.fixPatterns.listByProject, {
			...args,
			verifiedOrg: claimOp,
		});
		expect(r).toHaveLength(1);
	});
	test("FOREIGN: a client org's claim is refused as a member is (not-fleet-master)", async () => {
		const t = await world();
		const out = await codeOf(
			q(asService(t), api.fixPatterns.listByProject, {
				...args,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("not-fleet-master");
	});
	test("UNCHANGED: the service account with no claim is served", async () => {
		const t = await world();
		const r = await q<unknown[]>(
			asService(t),
			api.fixPatterns.listByProject,
			args,
		);
		expect(r).toHaveLength(1);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const t = await world();
		const out = await codeOf(
			q(memberOf(t, A), api.fixPatterns.listByProject, {
				...args,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const t = await world();
		const out = await codeOf(
			q(asService(t), api.fixPatterns.listByProject, {
				...args,
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});

describe("fixPatterns:listAll applies the verified org inside the read", () => {
	test("OWN: the operator org's claim is served", async () => {
		const t = await world();
		const r = await q<unknown[]>(asService(t), api.fixPatterns.listAll, {
			verifiedOrg: claimOp,
		});
		expect(r).toHaveLength(1);
	});
	test("FOREIGN: a client org's claim is the member's typed empty list", async () => {
		const t = await world();
		const r = await q<unknown[]>(asService(t), api.fixPatterns.listAll, {
			verifiedOrg: claimA,
		});
		expect(r).toEqual([]);
	});
	test("UNCHANGED: the service account with no claim is served", async () => {
		const t = await world();
		const r = await q<unknown[]>(asService(t), api.fixPatterns.listAll, {});
		expect(r).toHaveLength(1);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const t = await world();
		const out = await codeOf(
			q(memberOf(t, A), api.fixPatterns.listAll, { verifiedOrg: claimA }),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const t = await world();
		const out = await codeOf(
			q(asService(t), api.fixPatterns.listAll, { verifiedOrg: claimDead }),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});
