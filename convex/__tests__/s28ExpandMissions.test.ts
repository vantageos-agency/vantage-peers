/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17bcj237901qqfghbzsnj13258k0adb (mcp-server-standard
// S-28 expand: missions:list, missions:updateStatus).
//
// Each door below takes `verifiedOrg` (believed from the fleet service account
// only) and answers the claim as a member of that organisation is answered.
// Doors: missions:list, missions:updateStatus
//
// Poles per door:
//   OWN        the claim names the row's organisation -> served / write applied
//   FOREIGN    the claim names another active organisation -> the member's answer
//   UNCHANGED  the service account with no claim -> as before (expand only)
//   REFUSED    a non-service caller presenting the claim -> RBAC_DENIED
//   INACTIVE   a claim naming an inactive organisation -> RBAC_DENIED
// missions:updateStatus is a human-path write: the claim makes it a member's write,
// which needs a verified person; a service account presents none, so OWN is the
// member's refusal (callerOrchestrator is required), distinct from FOREIGN's tenant refusal.
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
const m = <R>(c: Client, ref: unknown, args: Record<string, unknown>) =>
	c.mutation(ref as never, args as never) as Promise<R>;

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
	const agents = await seedOrgs(t);
	const missions = await t.run(async (ctx) => {
		const out: Record<string, Id<"missions">> = {};
		for (const [slug, id, name] of [
			[A, A_ID, "alice"],
			[B, B_ID, "bob"],
		] as const) {
			const agentId = agents[`${slug}/${name}`];
			out[slug] = await ctx.db.insert("missions", {
				name: `${slug} mission`,
				project: `${slug}-project`,
				status: "execute",
				priority: "medium",
				agents: [name],
				pilot: name,
				pilotId: agentId,
				agentIds: [agentId],
				createdBy: name,
				createdAt: NOW,
				updatedAt: NOW,
				orgId: slug,
				clerkOrgId: id,
			} as never);
		}
		return out;
	});
	return { t, missions };
}

const statusOf = (t: T, id: Id<"missions">) =>
	t.run(async (ctx) => (await ctx.db.get(id))?.status);

describe("missions:list applies the verified org inside the read", () => {
	type Row = { name: string };
	test("OWN: verifiedOrg A lists only A's missions", async () => {
		const { t } = await world();
		const r = await q<Row[]>(asService(t), api.missions.list, {
			verifiedOrg: claimA,
		});
		expect(r.map((x) => x.name)).toEqual([`${A} mission`]);
	});
	test("FOREIGN: verifiedOrg B never lists A's mission", async () => {
		const { t } = await world();
		const r = await q<Row[]>(asService(t), api.missions.list, {
			verifiedOrg: claimB,
		});
		expect(r.map((x) => x.name)).toEqual([`${B} mission`]);
	});
	test("UNCHANGED: the service account with no claim lists both", async () => {
		const { t } = await world();
		const r = await q<Row[]>(asService(t), api.missions.list, {});
		expect(r.map((x) => x.name).sort()).toEqual([
			`${A} mission`,
			`${B} mission`,
		]);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t } = await world();
		const out = await codeOf(
			q(memberOf(t, A), api.missions.list, { verifiedOrg: claimA }),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t } = await world();
		const out = await codeOf(
			q(asService(t), api.missions.list, { verifiedOrg: claimDead }),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});

describe("missions:updateStatus applies the verified org inside the write", () => {
	test("OWN: verifiedOrg A on A's mission passes the tenant gate and meets the human path (refused, unchanged)", async () => {
		const { t, missions } = await world();
		const out = await codeOf(
			m(asService(t), api.missions.updateStatus, {
				missionId: missions[A],
				status: "complete",
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).not.toContain("may not update mission");
		expect(await statusOf(t, missions[A])).toBe("execute");
	});
	test("FOREIGN: verifiedOrg A on B's mission is refused at the tenant gate, unchanged", async () => {
		const { t, missions } = await world();
		const out = await codeOf(
			m(asService(t), api.missions.updateStatus, {
				missionId: missions[B],
				status: "complete",
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("may not update mission");
		expect(await statusOf(t, missions[B])).toBe("execute");
	});
	test("UNCHANGED: the service account with no claim updates B's mission", async () => {
		const { t, missions } = await world();
		await m(asService(t), api.missions.updateStatus, {
			missionId: missions[B],
			status: "complete",
		});
		expect(await statusOf(t, missions[B])).toBe("complete");
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t, missions } = await world();
		const out = await codeOf(
			m(memberOf(t, A), api.missions.updateStatus, {
				missionId: missions[A],
				status: "complete",
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
		expect(await statusOf(t, missions[A])).toBe("execute");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t, missions } = await world();
		const out = await codeOf(
			m(asService(t), api.missions.updateStatus, {
				missionId: missions[A],
				status: "complete",
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
		expect(await statusOf(t, missions[A])).toBe("execute");
	});
});
