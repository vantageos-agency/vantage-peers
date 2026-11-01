/// <reference types="vite/client" />
/**
 * Task k1701vj2gxbacdjqr1avpxx7en8hdw2q (Pi ruling k97dafwdd5hwyxdpr9y0kqxv7x8hdnqn):
 * `orchestrator/<name>` for a seat acting for its org is keyed by the VERIFIED agent
 * ID the call carries (`verifiedActor`, forwarded by the MCP), never by the typed
 * string and never by a roster lookup. The name is read server-side from that
 * agent's own row.
 *
 * Poles (memories:storeMemory / listMemories, episodes:storeEpisode / listEpisodes):
 *   - OWN      orchestrator/<the verified agent's own name>            -> served
 *   - SAME ORG another agent of the same org                           -> RBAC_DENIED
 *   - OTHER ORG another org's agent name, or its agent ID as the proof -> refused
 *   - NO PROOF the seat without a verifiedActor                        -> RBAC_DENIED
 *   - MASTER / CLERK MEMBER unchanged.
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

const A = "orch-org-a";
const B = "orch-org-b";
const A_ID = testClerkOrgId(A);
const ALICE = "alice";
const CAROL = "carol";
const BOB = "bob";

const service = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

type Agents = Record<string, Id<"agents">>;

async function seed(t: T): Promise<Agents> {
	await t.run(async (ctx) => {
		for (const [org, names] of [
			[A, [ALICE, CAROL]],
			[B, [BOB]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				allowedOrchestrators: [...names],
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: 1,
			});
		}
	});
	return await seedRosterAgents(t);
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

const seat = (agentId?: Id<"agents">, orgSlug = A) => ({
	__actingOrg: A_ID,
	...(agentId === undefined ? {} : { verifiedActor: { agentId, orgSlug } }),
});
const store = (t: T, namespace: string, extra: Record<string, unknown>) =>
	service(t).mutation(api.memories.storeMemory, {
		namespace,
		type: "project",
		content: `row in ${namespace}`,
		createdBy: ALICE,
		...extra,
	} as never);
const list = async (t: T, namespace: string, extra: Record<string, unknown>) =>
	(await service(t).query(api.memories.listMemories, { namespace, ...extra } as never))
		.value as Array<{ _id: Id<"memories"> }>;

describe("orchestrator/<name> keyed by the verified agent ID", () => {
	test("OWN: alice's proof writes + reads orchestrator/alice, stamped with her org", async () => {
		const t = createT();
		const ag = await seed(t);
		const id = await store(t, `orchestrator/${ALICE}`, seat(ag[`${A}/${ALICE}`]));
		expect((await t.run((ctx) => ctx.db.get(id as Id<"memories">)))?.clerkOrgId).toBe(A_ID);
		const rows = await list(t, `orchestrator/${ALICE}`, seat(ag[`${A}/${ALICE}`]));
		expect(rows.map((r) => r._id)).toEqual([id]);
		await drain(t);
	});

	test("SAME ORG: alice's proof cannot reach carol's namespace, nor a lookalike", async () => {
		const t = createT();
		const ag = await seed(t);
		const proof = seat(ag[`${A}/${ALICE}`]);
		expect(await code(store(t, `orchestrator/${CAROL}`, proof))).toBe("RBAC_DENIED");
		expect(await code(store(t, `orchestrator/${ALICE}x`, proof))).toBe("RBAC_DENIED");
		expect(await code(store(t, "orchestrator/*", proof))).toBe("RBAC_DENIED");
		expect(await list(t, `orchestrator/${CAROL}`, proof)).toEqual([]);
		await drain(t);
	});

	test("OTHER ORG: org B's agent name, and org B's agent ID as the proof, are refused", async () => {
		const t = createT();
		const ag = await seed(t);
		expect(await code(store(t, `orchestrator/${BOB}`, seat(ag[`${A}/${ALICE}`])))).toBe("RBAC_DENIED");
		expect(await code(store(t, `orchestrator/${BOB}`, seat(ag[`${B}/${BOB}`], B)))).not.toBe("SERVED");
		expect(await code(store(t, `orchestrator/${BOB}`, seat(ag[`${B}/${BOB}`])))).not.toBe("SERVED");
		await drain(t);
	});

	test("NO PROOF: the seat without a verifiedActor owns no orchestrator namespace", async () => {
		const t = createT();
		await seed(t);
		expect(await code(store(t, `orchestrator/${ALICE}`, seat()))).toBe("RBAC_DENIED");
	});

	test("MASTER unchanged; CLERK MEMBER unchanged (refused)", async () => {
		const t = createT();
		await seed(t);
		expect(await code(store(t, `orchestrator/${BOB}`, {}))).toBe("SERVED");
		const member = t.withIdentity({
			subject: "user_member_a",
			org_id: A_ID,
			org_slug: A,
			org_role: "org:admin",
		});
		expect(
			await code(
				member.mutation(api.memories.storeMemory, {
					namespace: `orchestrator/${ALICE}`,
					type: "project",
					content: "x",
				} as never),
			),
		).toBe("RBAC_DENIED");
		await drain(t);
	});

	test("EPISODES: own served, same-org other agent refused, read-back", async () => {
		const t = createT();
		const ag = await seed(t);
		const proof = seat(ag[`${A}/${ALICE}`]);
		const ep = (namespace: string) =>
			service(t).mutation(api.episodes.storeEpisode, {
				namespace,
				createdBy: ALICE,
				context: "c",
				goal: "g",
				action: "a",
				outcome: "o",
				insight: "i",
				severity: "minor",
				...proof,
			} as never);
		expect(await code(ep(`orchestrator/${ALICE}`))).toBe("SERVED");
		expect(await code(ep(`orchestrator/${CAROL}`))).toBe("RBAC_DENIED");
		const got = await service(t).query(api.episodes.listEpisodes, {
			namespace: `orchestrator/${ALICE}`,
			...proof,
		} as never);
		expect((got as unknown[]).length).toBe(1);
		await drain(t);
	});
});
