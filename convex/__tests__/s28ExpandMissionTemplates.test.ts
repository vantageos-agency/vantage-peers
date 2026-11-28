/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17bcj237901qqfghbzsnj13258k0adb (mcp-server-standard
// S-28 expand: missionTemplates:upsert, softDelete, instantiateTemplateIntoMission).
//
// Each door below takes `verifiedOrg` (believed from the fleet service account
// only) and answers the claim as a member of that organisation is answered.
// Doors: missionTemplates:upsert, missionTemplates:softDelete, missionTemplates:instantiateTemplateIntoMission
//
// Poles per door:
//   OWN        the claim names the row's organisation -> served / write applied
//   FOREIGN    the claim names another active organisation -> the member's answer
//   UNCHANGED  the service account with no claim -> as before (expand only)
//   REFUSED    a non-service caller presenting the claim -> RBAC_DENIED
//   INACTIVE   a claim naming an inactive organisation -> RBAC_DENIED
// upsert and softDelete are master-only catalog writes: the claim makes them answer as a
// member does (RBAC_DENIED master-only), for the operator org's claim too, because the
// claim is an ordinary member scope. instantiate serves a claim as the claimed org's member.
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

const TEMPLATE = "s28-template";

async function world() {
	const t = createT();
	const agents = await seedOrgs(t);
	const rows = await t.run(async (ctx) => {
		const template = await ctx.db.insert("missionTemplates", {
			name: TEMPLATE,
			steps: [{ title: "S1", description: "d" }],
			isDefault: false,
			createdBy: "opa",
			createdAt: NOW,
			updatedAt: NOW,
		});
		const missions: Record<string, Id<"missions">> = {};
		for (const [slug, id, name] of [
			[A, A_ID, "alice"],
			[B, B_ID, "bob"],
		] as const) {
			const agentId = agents[`${slug}/${name}`];
			missions[slug] = await ctx.db.insert("missions", {
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
		return { template, missions };
	});
	return { t, ...rows };
}

const templateCount = (t: T, name: string) =>
	t.run(
		async (ctx) =>
			(await ctx.db.query("missionTemplates").collect()).filter(
				(r) => r.name === name && r.deletedAt === undefined,
			).length,
	);
const taskCount = (t: T) =>
	t.run(async (ctx) => (await ctx.db.query("tasks").collect()).length);

describe("missionTemplates:upsert applies the verified org inside the write", () => {
	const args = {
		name: "s28-new",
		steps: [{ title: "S1", description: "d" }],
		createdBy: "opa",
	};
	test("OWN: a claim of the operator org is answered as a member (master-only refusal), nothing written", async () => {
		const { t } = await world();
		const out = await codeOf(
			m(asService(t), api.missionTemplates.upsert, {
				...args,
				verifiedOrg: claimOp,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("master-only");
		expect(await templateCount(t, "s28-new")).toBe(0);
	});
	test("FOREIGN: a claim of a client org is the same member refusal, nothing written", async () => {
		const { t } = await world();
		const out = await codeOf(
			m(asService(t), api.missionTemplates.upsert, {
				...args,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("master-only");
		expect(await templateCount(t, "s28-new")).toBe(0);
	});
	test("UNCHANGED: the service account with no claim writes the template", async () => {
		const { t } = await world();
		await m(asService(t), api.missionTemplates.upsert, args);
		expect(await templateCount(t, "s28-new")).toBe(1);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t } = await world();
		const out = await codeOf(
			m(memberOf(t, A), api.missionTemplates.upsert, {
				...args,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t } = await world();
		const out = await codeOf(
			m(asService(t), api.missionTemplates.upsert, {
				...args,
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});

describe("missionTemplates:softDelete applies the verified org inside the write", () => {
	const args = { name: TEMPLATE };
	test("OWN: a claim of the operator org is answered as a member (master-only refusal), template kept", async () => {
		const { t } = await world();
		const out = await codeOf(
			m(asService(t), api.missionTemplates.softDelete, {
				...args,
				verifiedOrg: claimOp,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("master-only");
		expect(await templateCount(t, TEMPLATE)).toBe(1);
	});
	test("FOREIGN: a claim of a client org is the same member refusal, template kept", async () => {
		const { t } = await world();
		const out = await codeOf(
			m(asService(t), api.missionTemplates.softDelete, {
				...args,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("master-only");
		expect(await templateCount(t, TEMPLATE)).toBe(1);
	});
	test("UNCHANGED: the service account with no claim retires the template", async () => {
		const { t } = await world();
		await m(asService(t), api.missionTemplates.softDelete, args);
		expect(await templateCount(t, TEMPLATE)).toBe(0);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t } = await world();
		const out = await codeOf(
			m(memberOf(t, A), api.missionTemplates.softDelete, {
				...args,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
		expect(await templateCount(t, TEMPLATE)).toBe(1);
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t } = await world();
		const out = await codeOf(
			m(asService(t), api.missionTemplates.softDelete, {
				...args,
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
		expect(await templateCount(t, TEMPLATE)).toBe(1);
	});
});

describe("missionTemplates:instantiateTemplateIntoMission applies the verified org inside the write", () => {
	test("OWN: verifiedOrg A fans the template into A's mission", async () => {
		const { t, missions } = await world();
		const r = await m<{ count: number }>(
			asService(t),
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: TEMPLATE, missionId: missions[A], verifiedOrg: claimA },
		);
		expect(r.count).toBe(1);
		expect(await taskCount(t)).toBe(1);
	});
	test("FOREIGN: verifiedOrg A cannot fan the template into B's mission (RBAC_DENIED, no task)", async () => {
		const { t, missions } = await world();
		const out = await codeOf(
			m(asService(t), api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: TEMPLATE,
				missionId: missions[B],
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("mission-not-in-caller-org");
		expect(await taskCount(t)).toBe(0);
	});
	test("UNCHANGED: the service account with no claim fans the template into B's mission", async () => {
		const { t, missions } = await world();
		const r = await m<{ count: number }>(
			asService(t),
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: TEMPLATE, missionId: missions[B] },
		);
		expect(r.count).toBe(1);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t, missions } = await world();
		const out = await codeOf(
			m(memberOf(t, A), api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: TEMPLATE,
				missionId: missions[A],
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
		expect(await taskCount(t)).toBe(0);
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t, missions } = await world();
		const out = await codeOf(
			m(asService(t), api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: TEMPLATE,
				missionId: missions[A],
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
		expect(await taskCount(t)).toBe(0);
	});
});
