/// <reference types="vite/client" />
/**
 * Task k179y0wpsd6fv7055f4p2w6b358hdrxe — the search ACTIONS (recall,
 * textSearch, hybridSearch; the MCP's recall / text_search / hybrid_search and
 * the episode searches) resolve the acting org through their scope bridge.
 *
 * An action has no db: it resolves its caller through
 * `internal.lib.auth.resolveOrgScopeForAction`, whose own ctx does not carry
 * the action's `__actingOrg`, so the action hands it in. Poles, per action:
 *   - acting for A, namespace team/<B>  -> nothing is searched, empty result;
 *   - acting for A, namespace team/<A>  -> served from team/<A>;
 *   - the fleet without the argument    -> team/<B> searched (unchanged);
 *   - a member of B naming org A        -> team/<A> refused (ignored argument).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import schema from "../schema";
import { __setRagSearcherForTests } from "../search";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const A = "search-org-a";
const B = "search-org-b";
const A_NS = `team/${testClerkOrgId(A)}`;
const B_NS = `team/${testClerkOrgId(B)}`;

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		organizationId: org,
		org_id: testClerkOrgId(org),
		organizationSlug: org,
	} as Parameters<T["withIdentity"]>[0]);

let searched: string[] = [];
type Searcher = Parameters<typeof __setRagSearcherForTests>[0];

async function seed(t: T): Promise<string> {
	return await t.run(async (ctx) => {
		for (const org of [A, B]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				allowedOrchestrators: ["sigma"],
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: 1,
			});
		}
		return (await ctx.db.insert("memories", {
			namespace: A_NS,
			type: "project",
			content: "row",
			createdBy: "sigma",
			relations: [],
			isLatest: true,
			createdAt: 1,
			updatedAt: 1,
		})) as string;
	});
}

function install(key: string): void {
	__setRagSearcherForTests((async (
		_ctx: unknown,
		args: { namespace: string },
	) => {
		searched.push(args.namespace);
		return {
			results: [{ entryId: "e", score: 0.9, content: [{ text: "hit" }] }],
			entries: [
				{
					entryId: "e",
					key,
					filterValues: [
						{ name: "namespace", value: args.namespace },
						{ name: "type", value: "project" },
					],
				},
			],
		};
	}) as unknown as Searcher);
}

beforeEach(() => {
	searched = [];
	__setRagSearcherForTests(null);
});
afterEach(() => {
	__setRagSearcherForTests(null);
});

const ACTIONS = [
	["recall", api.search.recall],
	["textSearch", api.search.textSearch],
	["hybridSearch", api.search.hybridSearch],
] as const;

for (const [name, ref] of ACTIONS) {
	describe(`search:${name} under the acting org`, () => {
		test("acting for A: B's namespace is never searched; A's is", async () => {
			const t = createT();
			install(await seed(t));
			const intoB = await asService(t).action(ref, {
				query: "q",
				namespace: B_NS,
				__actingOrg: testClerkOrgId(A),
			} as never);
			expect(intoB).toEqual([]);
			expect(searched).toEqual([]);
			const intoA = (await asService(t).action(ref, {
				query: "q",
				namespace: A_NS,
				__actingOrg: testClerkOrgId(A),
			} as never)) as unknown[];
			expect(intoA.length).toBe(1);
			expect(searched).toEqual([A_NS]);
		});

		test("the fleet without the argument still searches B (unchanged)", async () => {
			const t = createT();
			install(await seed(t));
			await asService(t).action(ref, { query: "q", namespace: B_NS } as never);
			expect(searched).toEqual([B_NS]);
		});

		test("a member of B naming org A cannot search A's namespace", async () => {
			const t = createT();
			install(await seed(t));
			const out = await asMember(t, B).action(ref, {
				query: "q",
				namespace: A_NS,
				__actingOrg: testClerkOrgId(A),
			} as never);
			expect(out).toEqual([]);
			expect(searched).toEqual([]);
		});
	});
}
