/// <reference types="vite/client" />
/**
 * Task k17bcp6jshmj30fqjm3p3nf4qx8hyy94 -- a client seat finds, through the search
 * ACTIONS (recall, textSearch, hybridSearch), the memory it wrote in its OWN
 * namespaces: orchestrator/<its verified agent ID>, project/<its org slug>,
 * team/<its org ID>.
 *
 * The defect (measured on prod 2026-11-10): store_memory without a namespace lands in
 * orchestrator/<agent ID> (memories:storeMemory admits it, isMemoryNamespaceAllowed),
 * list_memories reads it, but text_search / recall answered [] for the same
 * namespace, because resolveSearchNamespace judged it with the team-only predicate
 * (isNamespaceAllowedForScope) and answered null, the typed empty array.
 *
 * Poles:
 *   - OWN       seat with proof -> orchestrator/<own ID>, project/<slug>, team/<ID>: found
 *   - DENY      another org's seat (same agent ID or same slug string) -> nothing searched
 *   - DENY      same org, another agent's ID; the seat's own NAME; no agent proof -> nothing
 *   - UNCHANGED master and an ordinary Clerk member
 * The vector path embeds the query, which cannot run in a test: the searcher seam
 * (__setRagSearcherForTests) records the namespace and filter values the RAG is asked
 * for, and the test pins them equal to the namespace the row was stored under.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { __setRagSearcherForTests } from "../search";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const A = "seatsearch-org-a";
const B = "seatsearch-org-b";
const A_ID = testClerkOrgId(A);
const B_ID = testClerkOrgId(B);

const service = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		organizationId: org,
		org_id: testClerkOrgId(org),
		organizationSlug: org,
	} as Parameters<T["withIdentity"]>[0]);

type Searcher = Parameters<typeof __setRagSearcherForTests>[0];
type Call = { namespace: string; filters: Array<{ name: string; value: string }> };
let calls: Call[] = [];
let memoryKey = "";

function install(): void {
	__setRagSearcherForTests((async (
		_ctx: unknown,
		args: { namespace: string; filters?: Call["filters"] },
	) => {
		calls.push({ namespace: args.namespace, filters: args.filters ?? [] });
		return {
			results: [{ entryId: "e", score: 0.9, content: [{ text: "marker" }] }],
			entries: [
				{
					entryId: "e",
					key: memoryKey,
					filterValues: [
						{ name: "namespace", value: args.namespace },
						{ name: "type", value: "project" },
						{ name: "isLatest", value: "true" },
					],
				},
			],
		};
	}) as unknown as Searcher);
}

beforeEach(() => {
	vi.useFakeTimers();
	calls = [];
	__setRagSearcherForTests(null);
});
afterEach(async () => {
	await vi.runAllTimersAsync();
	vi.useRealTimers();
	__setRagSearcherForTests(null);
});

type Agents = Record<string, Id<"agents">>;
async function seed(t: T): Promise<Agents> {
	await t.run(async (ctx) => {
		for (const [org, names] of [
			[A, ["alice", "carol"]],
			[B, ["bob"]],
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

const proofOf = (agentId: Id<"agents">, orgSlug = A) => ({
	verifiedActor: { agentId, orgSlug },
});

/** The seat stores into `namespace` as the MCP does, then returns the memory ID. */
async function seatStores(
	t: T,
	namespace: string,
	agentId: Id<"agents">,
): Promise<string> {
	const id = await service(t).mutation(api.memories.storeMemory, {
		namespace,
		type: "project",
		content: "uniquemarker",
		createdBy: "alice",
		__actingOrg: A_ID,
		...proofOf(agentId),
	} as never);
	memoryKey = id as string;
	return memoryKey;
}

const ACTIONS = [
	["recall", api.search.recall],
	["textSearch", api.search.textSearch],
	["hybridSearch", api.search.hybridSearch],
] as const;

for (const [name, ref] of ACTIONS) {
	const search = (
		t: T,
		namespace: string,
		extra: Record<string, unknown>,
	): Promise<unknown[]> =>
		service(t).action(ref, {
			query: "uniquemarker",
			namespace,
			...extra,
		} as never) as Promise<unknown[]>;

	describe(`search:${name} -- a client seat and its own namespaces`, () => {
		test("OWN: orchestrator/<agent ID>, project/<slug>, team/<org ID> are found, filter == stored namespace", async () => {
			const t = createT();
			install();
			const ag = await seed(t);
			const alice = ag[`${A}/alice`];
			for (const ns of [`orchestrator/${alice}`, `project/${A}`, `team/${A_ID}`]) {
				calls = [];
				const stored = await seatStores(t, ns, alice);
				const row = await t.run((ctx) => ctx.db.get(stored as Id<"memories">));
				expect(row?.namespace).toBe(ns);
				const out = await search(t, ns, { __actingOrg: A_ID, ...proofOf(alice) });
				expect(out.length).toBe(1);
				expect(calls.map((c) => c.namespace)).toEqual([ns]);
				expect(calls[0].filters).toContainEqual({ name: "namespace", value: ns });
			}
		});

		test("OWN without any agent proof: project/<slug> and team/<org ID> are found (the namespace gate alone)", async () => {
			const t = createT();
			install();
			const ag = await seed(t);
			const alice = ag[`${A}/alice`];
			for (const ns of [`project/${A}`, `project/${A}/sub`, `team/${A_ID}`]) {
				calls = [];
				await seatStores(t, ns, alice);
				const out = await search(t, ns, { __actingOrg: A_ID });
				expect(out.length).toBe(1);
				expect(calls.map((c) => c.namespace)).toEqual([ns]);
			}
		});

		test("DENY (cross-tenant, AUTH_NAMESPACE_DENIED shape): another org's seat finds nothing in org A's namespaces", async () => {
			const t = createT();
			install();
			const ag = await seed(t);
			const alice = ag[`${A}/alice`];
			const bob = ag[`${B}/bob`];
			await seatStores(t, `orchestrator/${alice}`, alice);
			const asB = { __actingOrg: B_ID };
			expect(await search(t, `orchestrator/${alice}`, { ...asB, ...proofOf(bob, B) })).toEqual([]);
			// B's seat naming A's agent as ITS proof is refused at the proof check
			expect(await search(t, `orchestrator/${alice}`, { ...asB, ...proofOf(alice, A) })).toEqual([]);
			expect(await search(t, `project/${A}`, { ...asB, ...proofOf(bob, B) })).toEqual([]);
			expect(await search(t, `team/${A_ID}`, { ...asB, ...proofOf(bob, B) })).toEqual([]);
			expect(calls).toEqual([]);
		});

		test("DENY: same org other agent's ID, the seat's own NAME, and a seat with no proof", async () => {
			const t = createT();
			install();
			const ag = await seed(t);
			const alice = ag[`${A}/alice`];
			const carol = ag[`${A}/carol`];
			const own = { __actingOrg: A_ID, ...proofOf(alice) };
			expect(await search(t, `orchestrator/${carol}`, own)).toEqual([]);
			expect(await search(t, "orchestrator/alice", own)).toEqual([]);
			expect(await search(t, `orchestrator/${alice}`, { __actingOrg: A_ID })).toEqual([]);
			expect(await search(t, `orchestrator/${alice}x`, own)).toEqual([]);
			expect(calls).toEqual([]);
		});

		test("UNCHANGED: the fleet master searches any namespace; a Clerk member only its team subtree", async () => {
			const t = createT();
			install();
			const ag = await seed(t);
			const alice = ag[`${A}/alice`];
			await seatStores(t, `orchestrator/${alice}`, alice);
			expect((await search(t, `orchestrator/${alice}`, {})).length).toBe(1);
			const member = (ns: string) =>
				asMember(t, A).action(ref, { query: "q", namespace: ns } as never);
			expect(await member(`orchestrator/${alice}`)).toEqual([]);
			expect(((await member(`team/${A_ID}`)) as unknown[]).length).toBe(1);
		});
	});
}
