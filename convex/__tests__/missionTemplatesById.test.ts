/// <reference types="vite/client" />
/**
 * THE TEMPLATE DOOR DECIDES ON AGENT IDs AND ORG IDs, NEVER ON NAMES (module M10g).
 *
 * `instantiateTemplateIntoMission` fans tasks out into an org's mission. The
 * mission's org is compared by its permanent org ID (`sameOrg`); a member writes
 * only with a writer role; the acting identity and every step assignee are
 * resolved to agents of the member's OWN org and judged against its roster BY
 * agent ID. The catalog writes (`upsert`, `softDelete`) and the catalog read
 * (`listNames`) ask the package for the caller's fleet standing.
 *
 * POLES
 *   PERMISSION  - a member names its own roster's agents and is served; the
 *                 tasks it creates are recorded under the member (never under the
 *                 fleet's word); the fleet instantiates into any org's mission and
 *                 writes the catalog.
 *   DENIED      - a same-NAME agent of another org (the label "pi" in org B) is
 *                 not a candidate in org A; an agent of org A that is off its ID
 *                 roster is refused; another org's mission is refused; a viewer
 *                 is refused; an ordinary member never writes the catalog.
 *   ABSENT      - a template the catalog does not hold is "not found"; a member
 *                 reads the name catalog as an empty success.
 */
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedRosterAgent } from "../../tests/fixtures/rosterAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const A = "org-a";
const B = "org-b";
const NOW = 1_700_000_000_000;

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T, org: string, role = "org:editor") =>
	t.withIdentity({
		subject: `user-${org}`,
		organizationSlug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	} as Identity);

/**
 * Org A: agents pi (on the ID roster) and off (active, NOT on it). Org B: its own
 * "pi" and "bee". The catalog holds one template per assignee used below.
 */
async function seedWorld() {
	const t = createT();
	await t.run(async (ctx) => {
		for (const slug of [A, B]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: ["view-own-missions"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
			});
		}
		await seedRosterAgent(ctx, A, "pi");
		await ctx.db.insert("agents", {
			orgSlug: A,
			clerkOrgId: testClerkOrgId(A),
			name: "off",
			normalizedName: "off",
			isActive: true,
			createdAt: NOW,
		});
		await seedRosterAgent(ctx, B, "pi");
		await seedRosterAgent(ctx, B, "bee");
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: NOW,
		});
	});
	for (const [name, assignedTo] of [
		["tpl-pi", "pi"],
		["tpl-off", "off"],
		["tpl-bee", "bee"],
		["tpl-default", undefined],
	] as const) {
		await asService(t).mutation(api.missionTemplates.upsert, {
			name,
			steps: [
				{
					title: "s1",
					description: "d",
					...(assignedTo !== undefined ? { assignedTo } : {}),
				},
			],
			createdBy: "system",
		});
	}
	const missionOf = (orgSlug: string, pilot: string) =>
		t.run((ctx) =>
			ctx.db.insert("missions", {
				name: `m-${orgSlug}`,
				project: "p",
				status: "execute",
				priority: "low",
				pilot,
				agents: [pilot],
				createdBy: pilot,
				createdAt: NOW,
				updatedAt: NOW,
				orgId: orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
			}),
		);
	return { t, missionOf };
}

const refusal = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (e) {
		const x = e as { data?: unknown; message?: string };
		return typeof x.data === "string" ? x.data : String(x.message);
	}
	return "SERVED";
};
const tasksOf = (t: T) => t.run((ctx) => ctx.db.query("tasks").collect());

describe("PERMISSION", () => {
	test("a member instantiates a template whose step is assigned to an agent of its roster: the task is the member's, not the fleet word's", async () => {
		const { t, missionOf } = await seedWorld();
		const missionId = await missionOf(A, "pi");
		const r = await asMember(t, A).mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "tpl-pi", missionId },
		);
		expect(r.count).toBe(1);
		const [task] = await tasksOf(t);
		expect(task.assignedTo).toBe("pi");
		expect(task.createdBy).toBe(`user:user-${A}`);
		expect(task.orgId).toBe(A);
	});

	test("a step with no assignee falls back to the mission's pilot, judged like any assignee", async () => {
		const { t, missionOf } = await seedWorld();
		const missionId = await missionOf(A, "pi");
		const r = await asMember(t, A).mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "tpl-default", missionId },
		);
		expect(r.count).toBe(1);
		expect((await tasksOf(t))[0].assignedTo).toBe("pi");
	});

	test("the member may name an acting identity from its own roster", async () => {
		const { t, missionOf } = await seedWorld();
		const missionId = await missionOf(A, "pi");
		await asMember(t, A).mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "tpl-pi", missionId, callerOrchestrator: "pi" },
		);
		expect((await tasksOf(t))[0].createdBy).toBe("pi");
	});

	test("the fleet instantiates into any org's mission with any assignee, recorded under 'system'", async () => {
		const { t, missionOf } = await seedWorld();
		const missionId = await missionOf(A, "pi");
		const r = await asService(t).mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "tpl-off", missionId },
		);
		expect(r.count).toBe(1);
		expect((await tasksOf(t))[0].createdBy).toBe("system");
	});
});

describe("DENIED", () => {
	test("a label that only another org employs names nobody in the member's org", async () => {
		const { t, missionOf } = await seedWorld();
		const missionId = await missionOf(A, "pi");
		const r = await refusal(
			asMember(t, A).mutation(
				api.missionTemplates.instantiateTemplateIntoMission,
				{ templateName: "tpl-bee", missionId },
			),
		);
		expect(r).toContain("RBAC_DENIED");
		expect(r).toContain("assignee-not-on-roster");
		expect(await tasksOf(t)).toHaveLength(0);
	});

	test("an agent of the member's org that is off its ID roster is refused as assignee and as acting identity", async () => {
		const { t, missionOf } = await seedWorld();
		const missionId = await missionOf(A, "pi");
		const asAssignee = await refusal(
			asMember(t, A).mutation(
				api.missionTemplates.instantiateTemplateIntoMission,
				{ templateName: "tpl-off", missionId },
			),
		);
		expect(asAssignee).toContain("assignee-not-on-roster");
		const asActor = await refusal(
			asMember(t, A).mutation(
				api.missionTemplates.instantiateTemplateIntoMission,
				{ templateName: "tpl-pi", missionId, callerOrchestrator: "off" },
			),
		);
		expect(asActor).toContain("actor-not-on-roster");
		expect(await tasksOf(t)).toHaveLength(0);
	});

	test("a member of org B (which employs its own 'pi') cannot instantiate into org A's mission", async () => {
		const { t, missionOf } = await seedWorld();
		const missionId = await missionOf(A, "pi");
		const r = await refusal(
			asMember(t, B).mutation(
				api.missionTemplates.instantiateTemplateIntoMission,
				{ templateName: "tpl-pi", missionId },
			),
		);
		expect(r).toContain("mission-not-in-caller-org");
		expect(await tasksOf(t)).toHaveLength(0);
	});

	test("a viewer-role member is refused; an anonymous caller is refused by raising, before the mission is read", async () => {
		const { t, missionOf } = await seedWorld();
		const missionId = await missionOf(A, "pi");
		expect(
			await refusal(
				asMember(t, A, "org:viewer").mutation(
					api.missionTemplates.instantiateTemplateIntoMission,
					{ templateName: "tpl-pi", missionId },
				),
			),
		).toContain("role-not-writer");
		expect(
			await refusal(
				t.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
					templateName: "tpl-pi",
					missionId,
				}),
			),
		).toContain("RBAC_DENIED");
		expect(await tasksOf(t)).toHaveLength(0);
	});

	test("an ordinary member never writes the shared catalog, whatever its role", async () => {
		const { t } = await seedWorld();
		const args = {
			name: "member-made",
			steps: [{ title: "s", description: "d" }],
			createdBy: "pi",
		};
		expect(
			await refusal(asMember(t, A, "org:admin").mutation(api.missionTemplates.upsert, args)),
		).toContain("RBAC_DENIED");
		expect(
			await refusal(
				asMember(t, A, "org:admin").mutation(api.missionTemplates.softDelete, {
					name: "tpl-pi",
				}),
			),
		).toContain("RBAC_DENIED");
		const rows = await t.run((ctx) => ctx.db.query("missionTemplates").collect());
		expect(rows.every((r) => r.deletedAt === undefined)).toBe(true);
		expect(rows.some((r) => r.name === "member-made")).toBe(false);
	});
});

describe("ABSENT", () => {
	test("a template the catalog does not hold is 'not found'; a member reads the name catalog as an empty success, the fleet reads the names", async () => {
		const { t, missionOf } = await seedWorld();
		const missionId = await missionOf(A, "pi");
		expect(
			await refusal(
				asMember(t, A).mutation(
					api.missionTemplates.instantiateTemplateIntoMission,
					{ templateName: "no-such-template", missionId },
				),
			),
		).toContain("Template not found");
		expect(await asMember(t, A).query(api.missionTemplates.listNames, {})).toEqual([]);
		expect(
			(await asService(t).query(api.missionTemplates.listNames, {})).sort(),
		).toEqual(["tpl-bee", "tpl-default", "tpl-off", "tpl-pi"]);
	});
});
