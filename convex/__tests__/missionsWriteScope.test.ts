/// <reference types="vite/client" />
/**
 * missions.create / missions.update / missions.updateStatus /
 * missions.updateProgress — write-scope enforcement.
 *
 * DEFECT (pre-fix, on main): all four mutations took NO caller-identity
 * check of any kind — `create` inserted with no `orgId` set at all, and
 * `update`/`updateStatus`/`updateProgress` patched ANY mission by id with no
 * scope resolution outside `update`'s cancel-branch callerOrchestrator
 * assertion (itself a caller-supplied claim, never a verified identity).
 * This is the class of defect
 * .claude/rules/authority-attached-to-anonymous-object.md describes: a
 * write surface must derive authority from the verified caller
 * (withOrgScope), never trust the client-supplied argument (or nothing at
 * all) in its place.
 *
 * This suite proves all four mutations now enforce org scope via
 * withOrgScope + isOrgAllowedForScope (checked against the mission's STORED
 * `orgId`), both poles, on an ordinary (non-master) identity plus the
 * fleet's master/service-account carve-out.
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

async function seedMission(
	t: ReturnType<typeof createT>,
	orgId: string | undefined,
	createdBy: string,
) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("missions", {
			name: "seed mission",
			project: "p",
			status: "plan",
			priority: "medium",
			pilot: createdBy,
			agents: [createdBy],
			createdBy,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			orgId,
		});
	});
}

describe("missions.create — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();

		await expect(
			t.mutation(api.missions.create, {
				name: "anon mission",
				project: "p",
				status: "plan",
				priority: "medium",
				pilot: "seat-x",
				agents: ["seat-x"],
				createdBy: "seat-x",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const all = await t.run((ctx) => ctx.db.query("missions").collect());
		expect(all).toHaveLength(0);
	});

	test("org-a creating a mission gets orgId forced to its own org, regardless of the createdBy/pilot argument it passes", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const tA = asOrgA(t);

		// Named attack shape: org-a asserts a pilot/createdBy value that could
		// be mistaken for another org's own agent name. orgId must STILL
		// derive from the verified scope, never from anything caller-supplied.
		const missionId = await tA.mutation(api.missions.create, {
			name: "org-a mission",
			project: "p",
			status: "plan",
			priority: "medium",
			pilot: "seat-b",
			agents: ["seat-b"],
			createdBy: "seat-b",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.orgId).toBe("org-a");
	});

	test("the master/service-account identity creates a mission with no orgId (legacy/internal)", async () => {
		const t = createT();
		const tMaster = asMaster(t);

		const missionId = await tMaster.mutation(api.missions.create, {
			name: "master mission",
			project: "p",
			status: "plan",
			priority: "medium",
			pilot: "seat-x",
			agents: ["seat-x"],
			createdBy: "seat-x",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.orgId).toBeUndefined();
	});
});

describe("missions.update — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");

		await expect(
			t.mutation(api.missions.update, {
				missionId,
				name: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.name).toBe("seed mission");
	});

	test("org-a trying to update org-b's mission is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const missionId = await seedMission(t, "org-b", "seat-x");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missions.update, {
				missionId,
				name: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.name).toBe("seed mission");
	});

	// Named attack: org-a asserts callerOrchestrator EQUAL to the foreign
	// mission's own createdBy value — the exact shape that would pass the OLD
	// (pre-fix) cancel-branch `mission.createdBy === callerOrchestrator`
	// check alone. The new org-scope check must independently refuse this
	// regardless of what the caller-supplied callerOrchestrator equals.
	test("org-a trying to cancel org-b's mission is refused even when callerOrchestrator matches the mission's own createdBy", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const missionId = await seedMission(t, "org-b", "seat-b");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missions.update, {
				missionId,
				callerOrchestrator: "seat-b",
				status: "cancelled",
				cancelReason: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.status).toBe("plan");
	});

	test("org-a updating its own (org-a-owned) mission succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const missionId = await seedMission(t, "org-a", "seat-a");
		const tA = asOrgA(t);

		await tA.mutation(api.missions.update, {
			missionId,
			name: "updated by owner",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.name).toBe("updated by owner");
	});

	test("the master/service-account identity updates any org's mission", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");
		const tMaster = asMaster(t);

		await tMaster.mutation(api.missions.update, {
			missionId,
			name: "updated by master",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.name).toBe("updated by master");
	});

	// Anonymous-oracle proof: the scope check must run BEFORE ctx.db.get, so
	// an anonymous caller gets RBAC_DENIED even for a non-existent
	// missionId — never "Mission ... not found", which would let missionId
	// existence leak to an unauthenticated caller.
	test("an anonymous update on a non-existent missionId is refused with RBAC_DENIED, not 'not found'", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(missionId);
		});

		await expect(
			t.mutation(api.missions.update, {
				missionId,
				name: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	// A legacy mission (no orgId at all, seeded via t.run directly) must stay
	// out of an org-scoped caller's reach — the same shape briefingNotes'
	// mutant-B2 regression test pins.
	test("org-a updating a legacy mission (no orgId at all) is refused with RBAC_DENIED, and the mission is unchanged", async () => {
		const t = createT();
		await seedOrgAMapping(t);
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
				// no orgId field at all — the exact shape of a pre-Beta row.
			});
		});
		const before = await t.run((ctx) => ctx.db.get(missionId));
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missions.update, {
				missionId,
				name: "hijacked",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const after = await t.run((ctx) => ctx.db.get(missionId));
		expect(after).toEqual(before);
	});
});

describe("missions.updateStatus — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");

		await expect(
			t.mutation(api.missions.updateStatus, {
				missionId,
				status: "execute",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.status).toBe("plan");
	});

	test("org-a trying to update org-b's mission status is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const missionId = await seedMission(t, "org-b", "seat-x");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missions.updateStatus, {
				missionId,
				status: "execute",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.status).toBe("plan");
	});

	test("org-a updating its own mission's status succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const missionId = await seedMission(t, "org-a", "seat-a");
		const tA = asOrgA(t);

		await tA.mutation(api.missions.updateStatus, {
			missionId,
			status: "execute",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.status).toBe("execute");
	});

	test("the master/service-account identity updates any org's mission status", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");
		const tMaster = asMaster(t);

		await tMaster.mutation(api.missions.updateStatus, {
			missionId,
			status: "execute",
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.status).toBe("execute");
	});

	test("an anonymous updateStatus on a non-existent missionId is refused with RBAC_DENIED, not 'not found'", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(missionId);
		});

		await expect(
			t.mutation(api.missions.updateStatus, {
				missionId,
				status: "execute",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("missions.updateProgress — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");

		await expect(
			t.mutation(api.missions.updateProgress, {
				missionId,
				progress: 50,
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.progress).toBeUndefined();
	});

	test("org-a trying to update org-b's mission progress is refused", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		await seedOrgBMapping(t);
		const missionId = await seedMission(t, "org-b", "seat-x");
		const tA = asOrgA(t);

		await expect(
			tA.mutation(api.missions.updateProgress, {
				missionId,
				progress: 50,
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.progress).toBeUndefined();
	});

	test("org-a updating its own mission's progress succeeds", async () => {
		const t = createT();
		await seedOrgAMapping(t);
		const missionId = await seedMission(t, "org-a", "seat-a");
		const tA = asOrgA(t);

		await tA.mutation(api.missions.updateProgress, {
			missionId,
			progress: 50,
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.progress).toBe(50);
	});

	test("the master/service-account identity updates any org's mission progress", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");
		const tMaster = asMaster(t);

		await tMaster.mutation(api.missions.updateProgress, {
			missionId,
			progress: 50,
		});

		const mission = await t.run((ctx) => ctx.db.get(missionId));
		expect(mission?.progress).toBe(50);
	});

	test("an anonymous updateProgress on a non-existent missionId is refused with RBAC_DENIED, not 'not found'", async () => {
		const t = createT();
		const missionId = await seedMission(t, "org-b", "seat-b");
		await t.run(async (ctx) => {
			await ctx.db.delete(missionId);
		});

		await expect(
			t.mutation(api.missions.updateProgress, {
				missionId,
				progress: 50,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});
