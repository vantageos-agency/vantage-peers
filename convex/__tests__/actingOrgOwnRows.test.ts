/// <reference types="vite/client" />
/**
 * Task k179y0wpsd6fv7055f4p2w6b358hdrxe, Pi ruling k972yajqmtn6qpmcp4xtbjxckh8hdh6f:
 * isolation must not take away what a client seat does today on its OWN rows.
 *
 * A client seat reaches Convex as the fleet service account acting for its org
 * (`__actingOrg`), with the proofs the MCP forwards on each door (the seat's
 * `verifiedActor` on the profile doors, `verifiedOrg` on diary:write). For each
 * own-row door, three poles:
 *   - OWN      seat of org A writes its own row         -> served;
 *   - FOREIGN  the same seat touching org B's / another agent's row -> RBAC_DENIED,
 *              and the row is unchanged;
 *   - MASTER   the fleet (no __actingOrg, no proof)      -> unchanged, served.
 * Doors: profiles:upsertProfile (update_profile), profiles:updateDynamic
 * (set_summary), diary:write (write_diary), memories:storeMemory (store_memory
 * into team/<orgId>).
 */

import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("search") && !path.includes("backfill"),
	),
);
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

const A = "own-org-a";
const B = "own-org-b";
const A_ID = testClerkOrgId(A);
const B_ID = testClerkOrgId(B);
const ALICE = "alice";
const BOB = "bob";

const service = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

type Seeded = {
	alice: Id<"agents">;
	bob: Id<"agents">;
	aliceProfile: Id<"profiles">;
	bobProfile: Id<"profiles">;
};

async function seed(t: T): Promise<Seeded> {
	await t.run(async (ctx) => {
		for (const [org, name] of [
			[A, ALICE],
			[B, BOB],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				allowedOrchestrators: [name],
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: 1,
			});
		}
	});
	const agents = await seedRosterAgents(t);
	const alice = agents[`${A}/${ALICE}`];
	const bob = agents[`${B}/${BOB}`];
	return await t.run(async (ctx) => {
		const profile = (name: string, agentId: Id<"agents">, org: string) =>
			ctx.db.insert("profiles", {
				orchestratorId: name,
				agentId,
				instanceId: `${name}-${org}`,
				name: `${name} profile`,
				static: { role: "r", workspace: "w", capabilities: [] },
				dynamic: { lastSeen: 1, sessionCount: 1 },
			});
		return {
			alice,
			bob,
			aliceProfile: await profile(ALICE, alice, A),
			bobProfile: await profile(BOB, bob, B),
		};
	});
}

const seatA = (s: Seeded, args: Record<string, unknown>) => ({
	...args,
	__actingOrg: A_ID,
	verifiedActor: { agentId: s.alice, orgSlug: A },
});

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "SERVED";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		const m = /([A-Z][A-Z_]{3,}):/.exec(text);
		return m ? m[1] : `OTHER(${text.slice(0, 100)})`;
	}
}

describe("profiles:upsertProfile (update_profile) — own profile", () => {
	test("OWN: seat A updates its own profile", async () => {
		const t = createT();
		const s = await seed(t);
		expect(
			await code(service(t).mutation(api.profiles.upsertProfile, seatA(s, { orchestratorId: ALICE, name: "alice renamed" }) as never)),
		).toBe("SERVED");
		// update_profile forwards no instanceId, so the write lands on (or creates)
		// a profile OWNED by the seat's agent (profileActors.findWritableProfile).
		const own = await t.run((ctx) =>
			ctx.db.query("profiles").withIndex("by_agent", (q) => q.eq("agentId", s.alice)).collect(),
		);
		expect(own.map((r) => r.name)).toContain("alice renamed");
	});
	test("FOREIGN: seat A cannot update org B's agent's profile", async () => {
		const t = createT();
		const s = await seed(t);
		expect(
			await code(service(t).mutation(api.profiles.upsertProfile, seatA(s, { orchestratorId: BOB, name: "hijacked" }) as never)),
		).toBe("RBAC_DENIED");
		const bobRows = await t.run((ctx) =>
			ctx.db.query("profiles").withIndex("by_orchestrator", (q) => q.eq("orchestratorId", BOB)).collect(),
		);
		expect(bobRows.map((r) => r.name)).toEqual(["bob profile"]);
		const aliceRows = await t.run((ctx) =>
			ctx.db.query("profiles").withIndex("by_agent", (q) => q.eq("agentId", s.alice)).collect(),
		);
		expect(aliceRows.map((r) => r.name)).toEqual(["alice profile"]);
	});
	test("MASTER: the fleet updates any profile, unchanged", async () => {
		const t = createT();
		const s = await seed(t);
		expect(
			await code(service(t).mutation(api.profiles.upsertProfile, { orchestratorId: BOB, instanceId: `${BOB}-${B}`, name: "fleet edit" })),
		).toBe("SERVED");
		expect((await t.run((ctx) => ctx.db.get(s.bobProfile)))?.name).toBe("fleet edit");
	});
});

describe("profiles:updateDynamic (set_summary) — own summary", () => {
	test("OWN: seat A sets its own summary", async () => {
		const t = createT();
		const s = await seed(t);
		expect(
			await code(service(t).mutation(api.profiles.updateDynamic, seatA(s, { orchestratorId: ALICE, currentTask: "own summary", lastSeen: 2 }) as never)),
		).toBe("SERVED");
		expect((await t.run((ctx) => ctx.db.get(s.aliceProfile)))?.dynamic.currentTask).toBe("own summary");
	});
	test("FOREIGN: seat A cannot set org B's agent's summary", async () => {
		const t = createT();
		const s = await seed(t);
		expect(
			await code(service(t).mutation(api.profiles.updateDynamic, seatA(s, { orchestratorId: BOB, currentTask: "hijacked", lastSeen: 2 }) as never)),
		).toBe("RBAC_DENIED");
		expect((await t.run((ctx) => ctx.db.get(s.bobProfile)))?.dynamic.currentTask).toBeUndefined();
	});
	test("MASTER: the fleet sets any summary, unchanged", async () => {
		const t = createT();
		const s = await seed(t);
		expect(
			await code(service(t).mutation(api.profiles.updateDynamic, { orchestratorId: BOB, instanceId: `${BOB}-${B}`, currentTask: "fleet", lastSeen: 2 })),
		).toBe("SERVED");
		expect((await t.run((ctx) => ctx.db.get(s.bobProfile)))?.dynamic.currentTask).toBe("fleet");
	});
});

describe("diary:write (write_diary) — own diary", () => {
	const diaryArgs = (orchestrator: string, org: string) => ({
		date: "2026-11-01",
		orchestrator,
		content: `${orchestrator} entry`,
		createdBy: "seat-user-a",
		verifiedOrg: { orgSlug: org },
		__actingOrg: A_ID,
	});
	test("OWN: seat A writes its own agent's diary, stamped with org A", async () => {
		const t = createT();
		await seed(t);
		const id = await service(t).mutation(api.diary.write, diaryArgs(ALICE, A) as never);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.clerkOrgId).toBe(A_ID);
		await drain(t);
	});
	test("FOREIGN: seat A cannot write a diary for org B's agent, nor under org B's verifiedOrg", async () => {
		const t = createT();
		await seed(t);
		expect(await code(service(t).mutation(api.diary.write, diaryArgs(BOB, A) as never))).toBe("RBAC_DENIED");
		expect(await code(service(t).mutation(api.diary.write, diaryArgs(BOB, B) as never))).toBe("RBAC_DENIED");
		const rows = await t.run((ctx) => ctx.db.query("diary").collect());
		expect(rows).toEqual([]);
		await drain(t);
	});
	test("MASTER: the fleet writes any diary, unchanged", async () => {
		const t = createT();
		await seed(t);
		expect(
			await code(service(t).mutation(api.diary.write, { date: "2026-11-01", orchestrator: BOB, content: "fleet", createdBy: "fleet" })),
		).toBe("SERVED");
		await drain(t);
	});
});

describe("memories:storeMemory (store_memory) — the org's own namespace", () => {
	test("OWN: seat A writes into team/<A>, stamped A; FOREIGN: team/<B> refused; MASTER: team/<B> served", async () => {
		const t = createT();
		await seed(t);
		const svc = service(t);
		const own = await svc.mutation(api.memories.storeMemory, {
			namespace: `team/${A_ID}`,
			type: "project",
			content: "own",
			createdBy: ALICE,
			__actingOrg: A_ID,
		} as never);
		expect((await t.run((ctx) => ctx.db.get(own as Id<"memories">)))?.clerkOrgId).toBe(A_ID);
		expect(
			await code(svc.mutation(api.memories.storeMemory, { namespace: `team/${B_ID}`, type: "project", content: "x", createdBy: ALICE, __actingOrg: A_ID } as never)),
		).toBe("RBAC_DENIED");
		expect(
			await code(svc.mutation(api.memories.storeMemory, { namespace: `team/${B_ID}`, type: "project", content: "fleet", createdBy: "sigma" })),
		).toBe("SERVED");
		await drain(t);
	});
});
