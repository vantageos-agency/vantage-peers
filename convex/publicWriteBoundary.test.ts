/// <reference types="vite/client" />
/**
 * convex/businessUnits.ts — public write-boundary enforcement.
 *
 * DEFECT (pre-fix, on main): `businessUnits.create` inserted whatever
 * `orchestratorId` the caller supplied with NO identity/scope check at all
 * (no ctx.auth.getUserIdentity, no withOrgScope anywhere in the handler).
 * `businessUnits.update` authorized solely on a client-supplied
 * `callerOrchestrator` STRING ARGUMENT — an assertion, never a verified
 * identity — so any caller could type the literal "system" and rewrite, or
 * cross-tenant-reassign, any organisation's business unit.
 * `businessUnits.remove` performed no check whatsoever. A direct call to the
 * public Convex deployment (bypassing the MCP server's guardFrom /
 * guardMasterOnly layer, which is NOT a defence for this class — see
 * .claude/rules/authority-attached-to-anonymous-object.md and
 * .claude/rules/http-boundary-derives-from-principal.md) could create,
 * reassign, or delete any organisation's business unit.
 *
 * Owner key: the `orchestratorId` field — guarded via
 * isOrchestratorAllowedForScope (scope.allowedOrchestrators), mirroring
 * convex/diary.ts's / convex/messages.ts's identical pattern for the same
 * defect class.
 *
 * Fictitious identifiers only — org-a/org-b, seat-a/seat-b.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const createT = () => convexTest(schema, modules);

async function seedOrgAMapping(t: ReturnType<typeof createT>) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: "org-a",
			allowedOrchestrators: ["seat-a"],
			scopes: ["view-own-tasks"],
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
			scopes: ["view-own-tasks"],
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

function asOrgB(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-b",
		organizationId: "org-b",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

function buArgs(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		name: "Test BU",
		description: "desc",
		purpose: "purpose",
		orchestratorId: "seat-a",
		status: "idea" as const,
		businessModel: "saas",
		targetCustomers: "orgs",
		services: [],
		pricing: "free",
		revenueProjections: { y1: 0, y2: 0, y3: 0 },
		coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
		coreProcesses: [],
		dependencies: [],
		kpis: [],
		managementFee: 10,
		...overrides,
	};
}

describe("businessUnits.create — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await expect(
			t.mutation(api.businessUnits.create, buArgs()),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a-scoped caller creating a BU for org-b's seat is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(
				api.businessUnits.create,
				buArgs({ orchestratorId: "seat-b" }),
			),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a caller creating a BU for its own seat succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		const buId = await tA.mutation(
			api.businessUnits.create,
			buArgs({ orchestratorId: "seat-a" }),
		);
		expect(buId).toBeDefined();
	});

	test("the master/service-account identity creates as today", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const buId = await tMaster.mutation(
			api.businessUnits.create,
			buArgs({ orchestratorId: "seat-b" }),
		);
		expect(buId).toBeDefined();
	});
});

describe("businessUnits.update — write-scope enforcement", () => {
	async function seedOrgBBu(t: ReturnType<typeof createT>) {
		return await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert("businessUnits", {
				name: "org-b BU",
				description: "d",
				purpose: "p",
				orchestratorId: "seat-b",
				status: "idea",
				businessModel: "saas",
				targetCustomers: "orgs",
				services: [],
				pricing: "free",
				revenueProjections: { y1: 0, y2: 0, y3: 0 },
				coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
				coreProcesses: [],
				dependencies: [],
				kpis: [],
				managementFee: 10,
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		await seedOrgBMapping(t);
		const buId = await seedOrgBBu(t);

		await expect(
			t.mutation(api.businessUnits.update, {
				buId,
				callerOrchestrator: "seat-b",
				name: "renamed",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an anonymous caller gets RBAC_DENIED for a NON-EXISTENT buId too — scope is resolved before ctx.db.get, so buId existence is never an unauthenticated oracle", async () => {
		const t = createT();
		const fakeBuId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("businessUnits", {
				name: "temp",
				description: "d",
				purpose: "p",
				orchestratorId: "seat-a",
				status: "idea",
				businessModel: "saas",
				targetCustomers: "orgs",
				services: [],
				pricing: "free",
				revenueProjections: { y1: 0, y2: 0, y3: 0 },
				coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
				coreProcesses: [],
				dependencies: [],
				kpis: [],
				managementFee: 10,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		await expect(
			t.mutation(api.businessUnits.update, {
				buId: fakeBuId,
				callerOrchestrator: "seat-a",
				name: "renamed",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a caller cannot update org-b's BU by claiming callerOrchestrator=\"system\"", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const buId = await seedOrgBBu(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.businessUnits.update, {
				buId,
				callerOrchestrator: "system",
				name: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a caller cannot reassign its own BU to org-b's seat", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const tA = asOrgA(t);

		const buId = await tA.mutation(
			api.businessUnits.create,
			buArgs({ orchestratorId: "seat-a" }),
		);

		await expect(
			tA.mutation(api.businessUnits.update, {
				buId,
				callerOrchestrator: "seat-a",
				orchestratorId: "seat-b",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a caller updating its own seat's BU succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		const buId = await tA.mutation(
			api.businessUnits.create,
			buArgs({ orchestratorId: "seat-a" }),
		);

		await tA.mutation(api.businessUnits.update, {
			buId,
			callerOrchestrator: "seat-a",
			name: "renamed by owner",
		});

		const bu = await t.run(async (ctx) => ctx.db.get(buId));
		expect(bu?.name).toBe("renamed by owner");
	});

	test("the master/service-account identity updates any org's BU as today", async () => {
		const t = createT();
		const buId = await seedOrgBBu(t);
		const tMaster = asMaster(t);

		await tMaster.mutation(api.businessUnits.update, {
			buId,
			callerOrchestrator: "system",
			name: "master renamed",
		});

		const bu = await t.run(async (ctx) => ctx.db.get(buId));
		expect(bu?.name).toBe("master renamed");
	});
});

describe("businessUnits.remove — write-scope enforcement", () => {
	async function seedBu(t: ReturnType<typeof createT>) {
		return await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert("businessUnits", {
				name: "to delete",
				description: "d",
				purpose: "p",
				orchestratorId: "seat-a",
				status: "idea",
				businessModel: "saas",
				targetCustomers: "orgs",
				services: [],
				pricing: "free",
				revenueProjections: { y1: 0, y2: 0, y3: 0 },
				coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
				coreProcesses: [],
				dependencies: [],
				kpis: [],
				managementFee: 10,
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const buId = await seedBu(t);

		await expect(
			t.mutation(api.businessUnits.remove, { buId }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("an org-a-scoped (non-master) caller is refused, even for its own seat's BU", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const buId = await seedBu(t);
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.businessUnits.remove, { buId }),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("the master/service-account identity deletes as today", async () => {
		const t = createT();
		const buId = await seedBu(t);
		const tMaster = asMaster(t);

		const result = await tMaster.mutation(api.businessUnits.remove, {
			buId,
		});
		expect(result.deleted).toBe(true);
	});
});
