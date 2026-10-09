/// <reference types="vite/client" />
/**
 * AUDIT RED reproduction, group R2 — missionTemplates:instantiateTemplateIntoMission.
 *
 * Identities: member(org-a) = Clerk org member of org-a, roster ['sigma'] only,
 * NOT master / NOT the service account. The shared template catalog is seeded
 * by the service account (the catalog is master-only to write, by design).
 * Each org-a member test uses a mission of org-a, so the tenant gate passes and
 * only the assignee / writer-role checks are measured.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T, role: string) =>
	t.withIdentity({
		subject: `member-${role}`,
		organizationSlug: "org-a",
		org_role: role,
	} as Identity);

async function world(stepAssignee: string) {
	const t = createT();
	await t.run(async (ctx) => {
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: Date.now(),
		});
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["sigma"],
			scopes: ["view-own-tasks"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
	await asService(t).mutation(api.missionTemplates.upsert, {
		name: "audit-tpl",
		steps: [{ title: "a", description: "d", assignedTo: stepAssignee }],
		createdBy: "pi",
	});
	const missionId = await t.run((ctx) =>
		ctx.db.insert("missions", {
			name: "m",
			project: "p",
			status: "execute",
			priority: "low",
			pilot: "sigma",
			agents: ["sigma"],
			createdBy: "sigma",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			orgId: "org-a",
		}),
	);
	return { t, missionId };
}
const tasksOf = (t: T) => t.run((ctx) => ctx.db.query("tasks").collect());

describe("missionTemplates:instantiateTemplateIntoMission — assignee roster and writer role", () => {
	test("positive control: an editor member of org-a instantiates a template whose step is assigned to 'sigma' (on its roster)", async () => {
		const { t, missionId } = await world("sigma");
		const r = await asMember(t, "org:editor").mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "audit-tpl", missionId },
		);
		expect(r.count).toBe(1);
	});

	test("missionTemplates:instantiateTemplateIntoMission — a step assigned to 'omega' (not on org-a's roster) is refused for an editor member of org-a", async () => {
		const { t, missionId } = await world("omega");
		let text = "";
		let ok = true;
		try {
			await asMember(t, "org:editor").mutation(
				api.missionTemplates.instantiateTemplateIntoMission,
				{ templateName: "audit-tpl", missionId },
			);
		} catch (e) {
			ok = false;
			const x = e as { data?: unknown; message?: string };
			text = `${typeof x.data === "string" ? x.data : ""} ${x.message ?? ""}`;
		}
		const created = (await tasksOf(t)).filter((x) => x.assignedTo === "omega");
		expect(
			{ ok, created: created.length },
			"a task assigned to a foreign orchestrator was fanned into org-a's mission",
		).toEqual({ ok: false, created: 0 });
		expect(text).toMatch(/RBAC_DENIED/);
	});

	test("missionTemplates:instantiateTemplateIntoMission — a viewer-role member of org-a (no writer role) cannot fan tasks out", async () => {
		const { t, missionId } = await world("sigma");
		let ok = true;
		try {
			await asMember(t, "org:viewer").mutation(
				api.missionTemplates.instantiateTemplateIntoMission,
				{ templateName: "audit-tpl", missionId },
			);
		} catch {
			ok = false;
		}
		expect(
			{ ok, created: (await tasksOf(t)).length },
			"a non-writer member created tasks through the template door",
		).toEqual({ ok: false, created: 0 });
	});
});
