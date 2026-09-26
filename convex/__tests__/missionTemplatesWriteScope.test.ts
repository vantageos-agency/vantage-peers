/// <reference types="vite/client" />
/**
 * missionTemplates.upsert / missionTemplates.softDelete /
 * missionTemplates.instantiateTemplateIntoMission — write-scope enforcement.
 *
 * DEFECT (pre-fix, on main): all three mutations took NO caller-identity
 * check of any kind. `upsert`/`softDelete` write the FLEET-WIDE shared
 * template catalog (`missionTemplates` carries no `orgId` column — see
 * convex/schema.ts's doc comment): any caller holding the deployment URL
 * could overwrite or delete a template used by every org (e.g.
 * "issue-resolution-v2"). `instantiateTemplateIntoMission` fanned tasks out
 * into ANY caller-supplied `missionId` with no check that the mission
 * belonged to the caller's own org. This is the class of defect
 * .claude/rules/authority-attached-to-anonymous-object.md describes.
 *
 * This suite proves upsert/softDelete now require the verified MASTER
 * scope (the catalog is shared, never per-org), and
 * instantiateTemplateIntoMission derives authority from the TARGET
 * MISSION's STORED orgId against the caller's verified scope, both poles.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

async function seedOrgAMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a"],
			scopes: ["view-own-missions"],
			displayName: "org-a",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedOrgBMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-b",
			allowedOrchestrators: ["seat-b"],
			scopes: ["view-own-missions"],
			displayName: "org-b",
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationId: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedTemplate(t: ReturnType<typeof createT>, name: string) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("missionTemplates", {
			name,
			steps: [{ title: "Step 1", description: "do the thing" }],
			isDefault: false,
			createdBy: "alpha",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function seedMission(
	t: ReturnType<typeof createT>,
	orgId: string | undefined,
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("missions", {
			name: "target mission",
			project: "p",
			status: "plan",
			priority: "medium",
			pilot: "seat-owner",
			agents: ["seat-owner"],
			createdBy: "seat-owner",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			orgId,
		});
	});
}

describe("missionTemplates.upsert — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();

		await expect(
			t.mutation(api.missionTemplates.upsert, {
				name: "anon-template",
				steps: [{ title: "Step 1", description: "do the thing" }],
				createdBy: "seat-x",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const all = await t.run((ctx) => ctx.db.query("missionTemplates").collect());
		expect(all).toHaveLength(0);
	});

	// The catalog is shared fleet-wide — an ordinary (non-master) org
	// identity must be refused even though it presents a genuine, mapped
	// org. This is not a cross-org isolation test; it is the "master-only"
	// pole: no org identity, however legitimate, may write the shared catalog.
	test("an ordinary org-a identity (not master) is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missionTemplates.upsert, {
				name: "org-a-template",
				steps: [{ title: "Step 1", description: "do the thing" }],
				createdBy: "seat-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const all = await t.run((ctx) => ctx.db.query("missionTemplates").collect());
		expect(all).toHaveLength(0);
	});

	test("the master/service-account identity may upsert a template", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const templateId = await tMaster.mutation(api.missionTemplates.upsert, {
			name: "master-template",
			steps: [{ title: "Step 1", description: "do the thing" }],
			createdBy: "alpha",
		});

		const template = await t.run((ctx) => ctx.db.get(templateId));
		expect(template?.name).toBe("master-template");
	});
});

describe("missionTemplates.softDelete — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const templateId = await seedTemplate(t, "seed-template");

		await expect(
			t.mutation(api.missionTemplates.softDelete, { templateId }),
		).rejects.toThrow(/RBAC_DENIED/);

		const template = await t.run((ctx) => ctx.db.get(templateId));
		expect(template?.deletedAt).toBeUndefined();
	});

	test("an ordinary org-a identity (not master) is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const templateId = await seedTemplate(t, "seed-template");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missionTemplates.softDelete, { templateId }),
		).rejects.toThrow(/RBAC_DENIED/);

		const template = await t.run((ctx) => ctx.db.get(templateId));
		expect(template?.deletedAt).toBeUndefined();
	});

	test("the master/service-account identity may soft-delete a template", async () => {
		const t = createT();
		const templateId = await seedTemplate(t, "seed-template");
		const tMaster = asMaster(t);

		await tMaster.mutation(api.missionTemplates.softDelete, { templateId });

		const template = await t.run((ctx) => ctx.db.get(templateId));
		expect(template?.deletedAt).toBeDefined();
	});
});

describe("missionTemplates.instantiateTemplateIntoMission — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await seedTemplate(t, "tpl");
		const missionId = await seedMission(t, "org-b");

		await expect(
			t.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: "tpl",
				missionId,
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
		expect(tasks).toHaveLength(0);
	});

	test("org-a trying to instantiate a template into org-b's mission is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		await seedTemplate(t, "tpl");
		const missionId = await seedMission(t, "org-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: "tpl",
				missionId,
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
		expect(tasks).toHaveLength(0);
	});

	test("org-a instantiating a (shared) template into its OWN mission succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedTemplate(t, "tpl");
		const missionId = await seedMission(t, "org-a");
		const tA = asOrgA(t);

		const result = await tA.mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "tpl", missionId },
		);
		expect(result.count).toBe(1);

		const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
		expect(tasks).toHaveLength(1);
	});

	test("the master/service-account identity may instantiate a template into any org's mission", async () => {
		const t = createT();
		await seedTemplate(t, "tpl");
		const missionId = await seedMission(t, "org-b");
		const tMaster = asMaster(t);

		const result = await tMaster.mutation(
			api.missionTemplates.instantiateTemplateIntoMission,
			{ templateName: "tpl", missionId },
		);
		expect(result.count).toBe(1);
	});

	// Anonymous-oracle proof: the scope check must run BEFORE either
	// db lookup, so an anonymous caller gets RBAC_DENIED even for a
	// non-existent missionId — never "Mission not found".
	test("an anonymous instantiate on a non-existent missionId is refused with RBAC_DENIED, not 'not found'", async () => {
		const t = createT();
		await seedTemplate(t, "tpl");
		const missionId = await seedMission(t, "org-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(missionId);
		});

		await expect(
			t.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: "tpl",
				missionId,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// A legacy mission (no orgId at all) must stay out of an org-scoped
	// caller's reach, same shape as briefingNotes'/missions' mutant-B2
	// regression tests.
	test("org-a instantiating into a legacy mission (no orgId at all) is refused with RBAC_DENIED", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedTemplate(t, "tpl");
		const missionId = await t.run(async (ctx) => {
			return await ctx.db.insert("missions", {
				name: "legacy mission",
				project: "p",
				status: "plan",
				priority: "medium",
				pilot: "seat-legacy",
				agents: ["seat-legacy"],
				createdBy: "seat-legacy",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				// no orgId field at all.
			});
		});
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missionTemplates.instantiateTemplateIntoMission, {
				templateName: "tpl",
				missionId,
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
		expect(tasks).toHaveLength(0);
	});
});
