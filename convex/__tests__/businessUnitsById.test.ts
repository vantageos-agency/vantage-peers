/// <reference types="vite/client" />
/**
 * BUSINESS UNITS DECIDE ON AGENT IDs AND ORG IDs, NEVER ON NAMES (module M10f).
 *
 * A unit stores its lead orchestrator as an agents-row ID (`ownerId`) of the
 * unit's own organisation; `orchestratorId` is the display label. Two
 * organisations that both employ an orchestrator labelled "pi" employ two
 * different agents. Every pole runs under an ORDINARY org member or the fleet
 * service account; the fleet is the package's `fleet` standing.
 *
 * POLES
 *   PERMISSION  - the owner (by ID) acts; after a RENAME of the agent's label the
 *                 stale label names nobody and the new label of the same agent
 *                 still reaches the unit; the fleet resolves its labels in the
 *                 operator org.
 *   DENIED      - a same-NAME agent of another org is refused (create, update,
 *                 read); an agent of the member's own org that is not on its ID
 *                 roster is refused; a claimless service account does not delete
 *                 a client org's unit; a unit with no stored owner is served to
 *                 no member.
 *   ABSENT      - an org with no units reads an empty success; a fleet filter on
 *                 a label that names no operator agent is an empty success; the
 *                 backfill leaves an undecidable label unset and lists it.
 */
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedRosterAgent } from "../../tests/fixtures/rosterAgent";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const A = "org-a";
const B = "org-b";
const OP = "fleet-op";
const NOW = 1_700_000_000_000;

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const asMember = (t: T, org: string, role = "org:admin") =>
	t.withIdentity({
		subject: `user-${org}-${role}`,
		organizationSlug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	} as Identity);

const fields = (orchestratorId: string, name: string) => ({
	name,
	description: "d",
	purpose: "p",
	orchestratorId,
	status: "idea" as const,
	businessModel: "m",
	targetCustomers: "c",
	services: [],
	pricing: "x",
	revenueProjections: { y1: 1, y2: 2, y3: 3 },
	coreTeam: { agents: [], skills: [], hooks: [], plugins: [] },
	coreProcesses: [],
	dependencies: [],
	kpis: [],
});

type World = {
	piA: Id<"agents">;
	kappaA: Id<"agents">;
	offA: Id<"agents">;
	piB: Id<"agents">;
	sigmaOp: Id<"agents">;
};

/**
 * Org A: agents pi, kappa on the ID roster, "off" an active agent NOT on it.
 * Org B: its own agent pi. Operator org: agent sigma. Writer roles: admin, editor.
 */
async function seedWorld(t: T): Promise<World> {
	return await t.run(async (ctx) => {
		const mapping = (slug: string, orgKind?: "operator") =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: [],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: NOW,
				...(orgKind ? { orgKind } : {}),
			});
		await mapping(A);
		await mapping(B);
		await mapping(OP, "operator");
		const piA = await seedRosterAgent(ctx, A, "pi");
		const kappaA = await seedRosterAgent(ctx, A, "kappa");
		const offA = await ctx.db.insert("agents", {
			orgSlug: A,
			clerkOrgId: testClerkOrgId(A),
			name: "off",
			normalizedName: "off",
			isActive: true,
			createdAt: NOW,
		});
		const piB = await seedRosterAgent(ctx, B, "pi");
		const sigmaOp = await seedRosterAgent(ctx, OP, "sigma");
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: NOW,
		});
		return { piA, kappaA, offA, piB, sigmaOp };
	});
}

const unit = (
	t: T,
	over: {
		orgSlug?: string;
		ownerId?: Id<"agents">;
		label?: string;
		name?: string;
		status?: "idea" | "live";
	},
) =>
	t.run((ctx) =>
		ctx.db.insert("businessUnits", {
			...fields(over.label ?? "pi", over.name ?? "unit"),
			managementFee: 10,
			status: over.status ?? "idea",
			createdAt: NOW,
			updatedAt: NOW,
			...(over.orgSlug !== undefined
				? { orgId: over.orgSlug, clerkOrgId: testClerkOrgId(over.orgSlug) }
				: {}),
			...(over.ownerId !== undefined ? { ownerId: over.ownerId } : {}),
		}),
	);

const refusal = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (e) {
		const x = e as { data?: unknown; message?: string };
		return typeof x.data === "string" ? x.data : String(x.message);
	}
	return "SERVED";
};

describe("PERMISSION - the owner is an agent ID", () => {
	test("a member creates a unit for an agent of its own roster: the owner is stored BY ID and the unit is stamped with the org", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await asMember(t, A).mutation(
			api.businessUnits.create,
			fields("pi", "made-by-a"),
		);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.ownerId).toBe(w.piA);
		expect(row?.orgId).toBe(A);
		expect(row?.clerkOrgId).toBe(testClerkOrgId(A));
	});

	test("the fleet creates a unit: the label is resolved in the OPERATOR org, the unit stays unstamped", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await asService(t).mutation(
			api.businessUnits.create,
			fields("sigma", "fleet-made"),
		);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.ownerId).toBe(w.sigmaOp);
		expect(row?.orgId).toBeUndefined();
	});

	test("RENAME: the owner keeps its authority under its new label; the stale label names nobody", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await unit(t, { orgSlug: A, ownerId: w.piA });
		await t.run((ctx) =>
			ctx.db.patch(w.piA, { name: "pi2", normalizedName: "pi2" }),
		);
		await asMember(t, A).mutation(api.businessUnits.update, {
			buId: id,
			callerOrchestrator: "pi2",
			description: "by the renamed owner",
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.description).toBe(
			"by the renamed owner",
		);
		const stale = await refusal(
			asMember(t, A).mutation(api.businessUnits.update, {
				buId: id,
				callerOrchestrator: "pi",
				description: "by the stale label",
			}),
		);
		expect(stale).toContain("RBAC_DENIED");
		expect((await t.run((ctx) => ctx.db.get(id)))?.description).toBe(
			"by the renamed owner",
		);
	});

	test("a reassignment moves the owner ID with the label", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await unit(t, { orgSlug: A, ownerId: w.piA });
		await asMember(t, A).mutation(api.businessUnits.update, {
			buId: id,
			callerOrchestrator: "pi",
			orchestratorId: "kappa",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.orchestratorId).toBe("kappa");
		expect(row?.ownerId).toBe(w.kappaA);
	});

	test("the fleet's 'system' caller updates any unit; its reassignment resolves the label in the UNIT's org", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await unit(t, { orgSlug: A, ownerId: w.piA });
		await asService(t).mutation(api.businessUnits.update, {
			buId: id,
			callerOrchestrator: "system",
			orchestratorId: "kappa",
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.ownerId).toBe(w.kappaA);
	});

	test("the fleet deletes its own unit, and a client org's unit on the transport's verified claim naming that org", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const fleetUnit = await unit(t, { ownerId: w.sigmaOp, label: "sigma" });
		const clientUnit = await unit(t, { orgSlug: A, ownerId: w.piA });
		expect(
			(await asService(t).mutation(api.businessUnits.remove, { buId: fleetUnit }))
				.deleted,
		).toBe(true);
		expect(
			(
				await asService(t).mutation(api.businessUnits.remove, {
					buId: clientUnit,
					verifiedOrg: { orgSlug: A },
				})
			).deleted,
		).toBe(true);
	});
});

describe("DENIED - a name never admits", () => {
	test("a member of another org that employs an agent of the SAME label cannot update, read or list the unit", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await unit(t, { orgSlug: A, ownerId: w.piA });
		const write = await refusal(
			asMember(t, B).mutation(api.businessUnits.update, {
				buId: id,
				callerOrchestrator: "pi",
				description: "from b",
			}),
		);
		expect(write).toContain("row-not-in-caller-org");
		expect(await asMember(t, B).query(api.businessUnits.get, { buId: id })).toBeNull();
		expect((await asMember(t, B).query(api.businessUnits.list, {})).items).toEqual([]);
		expect((await t.run((ctx) => ctx.db.get(id)))?.description).toBe("d");
	});

	test("a member cannot create a unit for a label that names no agent of its org, nor for an agent of its org that is off the ID roster", async () => {
		const t = createT();
		await seedWorld(t);
		for (const label of ["sigma", "omega", "off"]) {
			const r = await refusal(
				asMember(t, A).mutation(api.businessUnits.create, fields(label, "x")),
			);
			expect(r, label).toContain("RBAC_DENIED");
		}
		expect(await t.run((ctx) => ctx.db.query("businessUnits").collect())).toHaveLength(0);
	});

	test("a member cannot hand its unit to an agent that is off its ID roster", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await unit(t, { orgSlug: A, ownerId: w.piA });
		const r = await refusal(
			asMember(t, A).mutation(api.businessUnits.update, {
				buId: id,
				callerOrchestrator: "pi",
				orchestratorId: "off",
			}),
		);
		expect(r).toContain("RBAC_DENIED");
		expect((await t.run((ctx) => ctx.db.get(id)))?.ownerId).toBe(w.piA);
	});

	test("a caller that is not the unit's owner is refused, whichever label it types", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await unit(t, { orgSlug: A, ownerId: w.piA });
		const r = await refusal(
			asMember(t, A).mutation(api.businessUnits.update, {
				buId: id,
				callerOrchestrator: "kappa",
				description: "by kappa",
			}),
		);
		expect(r).toContain("not the owning orchestrator");
	});

	test("a unit with no stored owner names nobody: no member reads it, the fleet still does", async () => {
		const t = createT();
		await seedWorld(t);
		const id = await unit(t, { orgSlug: A });
		expect(await asMember(t, A).query(api.businessUnits.get, { buId: id })).toBeNull();
		expect((await asMember(t, A).query(api.businessUnits.list, {})).items).toEqual([]);
		expect((await asService(t).query(api.businessUnits.get, { buId: id }))?._id).toBe(id);
	});

	test("deletion: a member is refused, a claimless service account is refused on a client unit, a claim naming another org is refused", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await unit(t, { orgSlug: A, ownerId: w.piA });
		expect(
			await refusal(asMember(t, A).mutation(api.businessUnits.remove, { buId: id })),
		).toContain("RBAC_DENIED");
		expect(
			await refusal(asService(t).mutation(api.businessUnits.remove, { buId: id })),
		).toContain("row-not-in-caller-org");
		expect(
			await refusal(
				asService(t).mutation(api.businessUnits.remove, {
					buId: id,
					verifiedOrg: { orgSlug: B },
				}),
			),
		).toContain("row-not-in-caller-org");
		expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
	});

	test("an anonymous caller is refused by raising on every door", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const id = await unit(t, { orgSlug: A, ownerId: w.piA });
		expect(await refusal(t.mutation(api.businessUnits.create, fields("pi", "x")))).toContain("RBAC_DENIED");
		expect(
			await refusal(t.mutation(api.businessUnits.update, { buId: id, callerOrchestrator: "pi" })),
		).toContain("RBAC_DENIED");
		expect(await refusal(t.mutation(api.businessUnits.remove, { buId: id }))).toContain("RBAC_DENIED");
		expect(await refusal(t.query(api.businessUnits.get, { buId: id }))).toContain("RBAC_DENIED");
		expect(await refusal(t.query(api.businessUnits.list, {}))).toContain("RBAC_DENIED");
	});
});

describe("ABSENT - an absence stays an absence", () => {
	test("an org with no units reads an empty success; a deleted unit reads null", async () => {
		const t = createT();
		const w = await seedWorld(t);
		expect((await asMember(t, A).query(api.businessUnits.list, {})).items).toEqual([]);
		const id = await unit(t, { orgSlug: A, ownerId: w.piA });
		await t.run((ctx) => ctx.db.delete(id));
		expect(await asMember(t, A).query(api.businessUnits.get, { buId: id })).toBeNull();
	});

	test("the fleet filter by orchestrator resolves the label in the operator org: a client agent's label is an empty success, the operator's is served", async () => {
		const t = createT();
		const w = await seedWorld(t);
		await unit(t, { orgSlug: A, ownerId: w.piA, name: "client-unit" });
		await unit(t, { ownerId: w.sigmaOp, label: "sigma", name: "fleet-unit" });
		const byClientLabel = await asService(t).query(api.businessUnits.list, {
			orchestratorId: "pi",
		});
		expect(byClientLabel.items).toEqual([]);
		const bySigma = await asService(t).query(api.businessUnits.list, {
			orchestratorId: "sigma",
		});
		expect(bySigma.items.map((u) => u.name)).toEqual(["fleet-unit"]);
	});
});

describe("backfill_business_unit_owner_ids", () => {
	const run = (t: T, args: { dryRun?: boolean }) =>
		t.mutation(internal.migrations.backfill_business_unit_owner_ids.run, args);

	test("a dry run (the default) writes nothing; the write fills the owner of a stamped and of a fleet unit and lists an undecidable label", async () => {
		const t = createT();
		const w = await seedWorld(t);
		const stamped = await unit(t, { orgSlug: A, label: "pi" });
		const fleet = await unit(t, { label: "sigma" });
		const ghost = await unit(t, { orgSlug: A, label: "ghost" });

		const dry = await run(t, {});
		expect(dry.dryRun).toBe(true);
		expect(dry.toFill).toBe(2);
		expect(dry.filled).toBe(0);
		expect(dry.blocked.map((b) => b.name)).toEqual(["ghost"]);
		expect((await t.run((ctx) => ctx.db.get(stamped)))?.ownerId).toBeUndefined();

		const wrote = await run(t, { dryRun: false });
		expect(wrote.filled).toBe(2);
		expect((await t.run((ctx) => ctx.db.get(stamped)))?.ownerId).toBe(w.piA);
		expect((await t.run((ctx) => ctx.db.get(fleet)))?.ownerId).toBe(w.sigmaOp);
		expect((await t.run((ctx) => ctx.db.get(ghost)))?.ownerId).toBeUndefined();

		const again = await run(t, { dryRun: false });
		expect(again.filled).toBe(0);
		expect(again.preState.with).toBe(2);
	});
});

describe("a bearer acting for its verified org (the MCP transport's claim)", () => {
  const claim = (slug: string) => ({ verifiedOrg: { orgSlug: slug } });

  test("PERMISSION: the service account acting for org A creates, reads and updates A's unit as A's member, never as the fleet", async () => {
    const t = createT();
    const w = await seedWorld(t);
    const id = await asService(t).mutation(api.businessUnits.create, {
      ...fields("pi", "via-claim"),
      ...claim(A),
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.ownerId).toBe(w.piA);
    expect(row?.orgId).toBe(A);
    expect(row?.clerkOrgId).toBe(testClerkOrgId(A));
    expect(
      (await asService(t).query(api.businessUnits.get, { buId: id, ...claim(A) }))?._id,
    ).toBe(id);
    await asService(t).mutation(api.businessUnits.update, {
      buId: id,
      callerOrchestrator: "pi",
      description: "by the bearer",
      ...claim(A),
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.description).toBe("by the bearer");
  });

  test("DENIED: acting for org B, the same bearer neither reads nor updates A's unit, nor creates for A's agent", async () => {
    const t = createT();
    const w = await seedWorld(t);
    const id = await unit(t, { orgSlug: A, ownerId: w.piA });
    expect(
      await asService(t).query(api.businessUnits.get, { buId: id, ...claim(B) }),
    ).toBeNull();
    expect(
      await refusal(
        asService(t).mutation(api.businessUnits.update, {
          buId: id,
          callerOrchestrator: "pi",
          description: "from b",
          ...claim(B),
        }),
      ),
    ).toContain("row-not-in-caller-org");
    expect(
      await refusal(
        asService(t).mutation(api.businessUnits.create, {
          ...fields("sigma", "x"),
          ...claim(A),
        }),
      ),
    ).toContain("RBAC_DENIED");
  });

  test("DENIED: a member presenting the claim is refused, not ignored; an unknown org is refused", async () => {
    const t = createT();
    const w = await seedWorld(t);
    const id = await unit(t, { orgSlug: A, ownerId: w.piA });
    expect(
      await refusal(
        asMember(t, A).mutation(api.businessUnits.create, {
          ...fields("pi", "x"),
          ...claim(A),
        }),
      ),
    ).toContain("verified-org-not-trusted");
    expect(
      await refusal(
        asService(t).mutation(api.businessUnits.update, {
          buId: id,
          callerOrchestrator: "pi",
          ...claim("org-nope"),
        }),
      ),
    ).toContain("org-not-active");
  });
});
