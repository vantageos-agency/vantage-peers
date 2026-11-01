/// <reference types="vite/client" />
/**
 * Task k1744r188ygrqcgp3qgeejnn2x8hck2x (URGENT client regression): since the MCP
 * attaches `__actingOrg`, a client seat is an ORDINARY member of its org, and the
 * member namespace rule admitted only `team/<orgId>`. Every client seat profile
 * grants `project/<slug>` + `orchestrator/<agent>`, so store_memory / list_memories
 * on them were refused / empty.
 *
 * The rule under test (convex/lib/teamNamespace.ts `isMemoryNamespaceAllowed`):
 * under an acting org a namespace is the seat's when it lies inside ITS OWN org:
 * `team/<own orgId>`, `project/<own slug>`, `orchestrator/<agent on its own
 * org's allow-list>`. Never another org's slug or agent.
 *
 * Poles per door (memories:storeMemory / listMemories, episodes:storeEpisode /
 * listEpisodes):
 *   - OWN      project/<own slug>, orchestrator/<own agent>, team/<own id> -> served
 *   - FOREIGN  project/<other slug>, orchestrator/<other org's agent>       -> RBAC_DENIED / empty
 *   - MASTER   the fleet (no __actingOrg) is unchanged
 *   - LEGACY   a row the old master path filed UNSTAMPED in project/<own slug>
 *              stays hidden from the seat (no silent re-stamp).
 */

import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
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

const A = "seat-org-a";
const B = "seat-org-b";
const A_ID = testClerkOrgId(A);
const B_ID = testClerkOrgId(B);
const ALICE = "alice";
const BOB = "bob";

const service = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

async function seed(t: T): Promise<void> {
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
}

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

const asSeatA = { __actingOrg: A_ID };
const store = (t: T, namespace: string, extra: Record<string, unknown> = asSeatA) =>
	service(t).mutation(api.memories.storeMemory, {
		namespace,
		type: "project",
		content: `row in ${namespace}`,
		createdBy: ALICE,
		...extra,
	} as never);
const list = async (t: T, namespace: string, extra: Record<string, unknown> = asSeatA) =>
	(await service(t).query(api.memories.listMemories, { namespace, ...extra } as never))
		.value as Array<{ _id: Id<"memories">; clerkOrgId?: string }>;

describe("memories:storeMemory / listMemories under an acting org", () => {
	test("OWN: seat A writes + reads project/<own slug>, stamped with its org", async () => {
		const t = createT();
		await seed(t);
		const id = await store(t, `project/${A}`);
		expect((await t.run((ctx) => ctx.db.get(id as Id<"memories">)))?.clerkOrgId).toBe(A_ID);
		const rows = await list(t, `project/${A}`);
		expect(rows.map((r) => r._id)).toEqual([id]);
		await drain(t);
	});

	test("OWN: a sub-namespace project/<own slug>/x and orchestrator/<own agent> are served", async () => {
		const t = createT();
		await seed(t);
		expect(await code(store(t, `project/${A}/sub`))).toBe("SERVED");
		expect(await code(store(t, `orchestrator/${ALICE}`))).toBe("SERVED");
		expect((await list(t, `orchestrator/${ALICE}`)).length).toBe(1);
		await drain(t);
	});

	test("OWN: team/<own orgId> still served", async () => {
		const t = createT();
		await seed(t);
		expect(await code(store(t, `team/${A_ID}`))).toBe("SERVED");
		expect((await list(t, `team/${A_ID}`)).length).toBe(1);
		await drain(t);
	});

	test("FOREIGN: project/<other slug>, orchestrator/<other org's agent>, a prefix-lookalike are refused", async () => {
		const t = createT();
		await seed(t);
		expect(await code(store(t, `project/${B}`))).toBe("RBAC_DENIED");
		expect(await code(store(t, `orchestrator/${BOB}`))).toBe("RBAC_DENIED");
		expect(await code(store(t, `project/${A}x`))).toBe("RBAC_DENIED");
		expect(await code(store(t, `orchestrator/${ALICE}x`))).toBe("RBAC_DENIED");
		expect(await code(store(t, "orchestrator/*"))).toBe("RBAC_DENIED");
		expect(await code(store(t, "global"))).toBe("RBAC_DENIED");
		// a master-filed row in the OTHER org's project namespace is not served to seat A
		await service(t).mutation(api.memories.storeMemory, {
			namespace: `project/${B}`,
			type: "project",
			content: "b",
			createdBy: "sigma",
		} as never);
		expect(await list(t, `project/${B}`)).toEqual([]);
		await drain(t);
	});

	test("FOREIGN: seat B's row in a namespace both orgs name is never served to seat A", async () => {
		const t = createT();
		await seed(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("memories", {
				namespace: `project/${A}`,
				type: "project",
				content: "stamped B",
				createdBy: BOB,
				relations: [],
				isLatest: true,
				clerkOrgId: B_ID,
				createdAt: 1,
				updatedAt: 1,
			});
		});
		expect(await list(t, `project/${A}`)).toEqual([]);
	});

	test("LEGACY: an unstamped (fleet-filed) row in project/<own slug> stays hidden — no silent re-stamp", async () => {
		const t = createT();
		await seed(t);
		const legacy = await service(t).mutation(api.memories.storeMemory, {
			namespace: `project/${A}`,
			type: "project",
			content: "filed by the old master path",
			createdBy: ALICE,
		} as never);
		const row = await t.run((ctx) => ctx.db.get(legacy as Id<"memories">));
		expect(row?.clerkOrgId).toBeUndefined();
		expect(await list(t, `project/${A}`)).toEqual([]);
		await drain(t);
	});

	test("MASTER unchanged: any namespace written and read, no stamp on a non-team namespace", async () => {
		const t = createT();
		await seed(t);
		for (const ns of [`project/${B}`, `orchestrator/${BOB}`, "global"]) {
			expect(await code(store(t, ns, {}))).toBe("SERVED");
			expect((await list(t, ns, {})).length).toBe(1);
		}
		await drain(t);
	});

	test("CLERK MEMBER unchanged: no __actingOrg, project/<own slug> is still refused", async () => {
		const t = createT();
		await seed(t);
		const member = t.withIdentity({
			subject: "user_member_a",
			org_id: A_ID,
			org_slug: A,
			org_role: "org:admin",
		});
		expect(
			await code(
				member.mutation(api.memories.storeMemory, {
					namespace: `project/${A}`,
					type: "project",
					content: "x",
				} as never),
			),
		).toBe("RBAC_DENIED");
		expect(
			await code(
				member.mutation(api.memories.storeMemory, {
					namespace: `team/${A_ID}`,
					type: "project",
					content: "x",
				} as never),
			),
		).toBe("SERVED");
		await drain(t);
	});
});

describe("episodes:storeEpisode / listEpisodes under an acting org", () => {
	const ep = (t: T, namespace: string, extra: Record<string, unknown> = asSeatA) =>
		service(t).mutation(api.episodes.storeEpisode, {
			namespace,
			createdBy: ALICE,
			context: "c",
			goal: "g",
			action: "a",
			outcome: "o",
			insight: "i",
			severity: "minor",
			...extra,
		} as never);

	test("OWN served, FOREIGN refused, read-back of own", async () => {
		const t = createT();
		await seed(t);
		expect(await code(ep(t, `project/${A}`))).toBe("SERVED");
		expect(await code(ep(t, `orchestrator/${ALICE}`))).toBe("SERVED");
		expect(await code(ep(t, `team/${A_ID}`))).toBe("SERVED");
		expect(await code(ep(t, `project/${B}`))).toBe("RBAC_DENIED");
		expect(await code(ep(t, `orchestrator/${BOB}`))).toBe("RBAC_DENIED");
		const got = await service(t).query(api.episodes.listEpisodes, {
			namespace: `project/${A}`,
			...asSeatA,
		} as never);
		expect((got as unknown[]).length).toBe(1);
		const foreign = await service(t).query(api.episodes.listEpisodes, {
			namespace: `project/${B}`,
			...asSeatA,
		} as never);
		expect(foreign).toEqual([]);
		await drain(t);
	});

	test("MASTER unchanged: writes any namespace", async () => {
		const t = createT();
		await seed(t);
		expect(await code(ep(t, `project/${B}`, {}))).toBe("SERVED");
		await drain(t);
	});
});
