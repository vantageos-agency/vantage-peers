/// <reference types="vite/client" />
/**
 * M11 - the fleet-only doors ask the package for the caller's standing, and the
 * mandate / fix-attempt doors decide on agent IDs.
 *
 * Callers, said apart (refusal rule, .claude/rules/refusal-is-distinguishable-from-absence.md):
 *   fleet service account  - admitted, real figures
 *   operator org admin     - admitted on READS only (a human; a write door refuses it)
 *   client org admin       - refused
 *   client org member      - refused
 *   anonymous              - refused (raise)
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
// fixPatterns:create schedules a RAG-sync action; fake timers plus
// finishAllScheduledFunctions drive it to a terminal state inside the test
// (same pattern as fixPatternsWriteScope.test.ts).
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const OPERATOR = "fleet-operator";
const CLIENT = "acme";

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const human = (t: T, org: string, role: string, subject: string) =>
	t.withIdentity({
		subject,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: role,
	} as Identity);

async function seed(t: T) {
	const ids = await seedFleetAgents(t, ["pi", "sigma", "omega"]);
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: CLIENT,
			clerkOrgId: testClerkOrgId(CLIENT),
			allowedOrchestrators: [],
			scopes: [],
			displayName: CLIENT,
			isActive: true,
			createdAt: 1,
		});
		const now = Date.now();
		for (const [n, status] of [
			[1, "open"],
			[2, "open"],
			[3, "closed"],
		] as const) {
			await ctx.db.insert("issues", {
				repo: "o/r",
				issueNumber: n,
				title: `i${n}`,
				body: "b",
				htmlUrl: "u",
				labels: [],
				status,
				priority: "low",
				assignedOrchestrator: "pi",
				project: "p",
				githubCreatedAt: now,
				githubUpdatedAt: now,
			});
		}
	});
	// A same-label agent of the CLIENT org: a different agent from the fleet's "sigma".
	const clientSigma = await t.run((ctx) =>
		ctx.db.insert("agents", {
			orgSlug: CLIENT,
			clerkOrgId: testClerkOrgId(CLIENT),
			name: "sigma",
			normalizedName: "sigma",
			isActive: true,
			createdAt: 1,
		}),
	);
	return { ids, clientSigma };
}

const actor = (agentId: string, orgSlug = OPERATOR) =>
	({ agentId, orgSlug }) as never;

describe("fleet-only reads: the package's standing decides", () => {
	test("the fleet service account is served the real figures (issues:getStats)", async () => {
		const t = createT();
		await seed(t);
		const stats = await asService(t).query(api.issues.getStats, {});
		expect(stats).toMatchObject({ open: 2, closed: 1, total: 3 });
	});

	test("an operator-org admin human is served the same figures on a READ", async () => {
		const t = createT();
		await seed(t);
		const stats = await human(t, OPERATOR, "org:admin", "op-admin").query(
			api.issues.getStats,
			{},
		);
		expect(stats).toMatchObject({ total: 3 });
	});

	test("an operator-org MEMBER (not admin) is refused like any member", async () => {
		const t = createT();
		await seed(t);
		await expect(
			human(t, OPERATOR, "org:member", "op-member").query(api.issues.getStats, {}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test.each([
		["client org admin", "org:admin"],
		["client org member", "org:member"],
	])("a %s is RAISED at on getStats and never handed zeros", async (_n, role) => {
		const t = createT();
		await seed(t);
		await expect(
			human(t, CLIENT, role, `${CLIENT}-${role}`).query(api.issues.getStats, {}),
		).rejects.toThrow(/RBAC_DENIED.*not-fleet-master/s);
	});

	test("anonymous is RAISED at on getStats", async () => {
		const t = createT();
		await seed(t);
		await expect(t.query(api.issues.getStats, {})).rejects.toThrow(/RBAC_DENIED/);
	});

	test("mandates:list - master gets the bare array, a client admin the typed envelope, and an absence stays an absence", async () => {
		const t = createT();
		await seed(t);
		expect(await asService(t).query(api.mandates.list, {})).toEqual([]);
		await asService(t).mutation(api.mandates.create, {
			requestedBy: "pi",
			fulfilledBy: "sigma",
			service: "x",
			budget: 5,
		});
		const served = await asService(t).query(api.mandates.list, {});
		expect(Array.isArray(served) && served.length).toBe(1);
		const refused = await human(t, CLIENT, "org:admin", "acme-admin").query(
			api.mandates.list,
			{},
		);
		expect(refused).toEqual({ refused: true, items: [] });
		await expect(t.query(api.mandates.list, {})).rejects.toThrow(/RBAC_DENIED/);
	});

	test("fixPatterns:listByProject admits the fleet and raises at a client admin", async () => {
		const t = createT();
		await seed(t);
		expect(
			await asService(t).query(api.fixPatterns.listByProject, { sourceProject: "p" }),
		).toBeDefined();
		await expect(
			human(t, CLIENT, "org:admin", "acme-admin").query(
				api.fixPatterns.listByProject,
				{ sourceProject: "p" },
			),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("fleet-only writes: no human, no client", () => {
	const mandateArgs = {
		requestedBy: "pi",
		fulfilledBy: "sigma",
		service: "x",
		budget: 5,
	};

	test("the service account writes; an operator admin (a human) and a client admin do not", async () => {
		const t = createT();
		await seed(t);
		await asService(t).mutation(api.mandates.create, mandateArgs);
		for (const caller of [
			human(t, OPERATOR, "org:admin", "op-admin"),
			human(t, CLIENT, "org:admin", "acme-admin"),
			human(t, CLIENT, "org:member", "acme-member"),
		]) {
			await expect(caller.mutation(api.mandates.create, mandateArgs)).rejects.toThrow(
				/RBAC_DENIED/,
			);
		}
		await expect(t.mutation(api.mandates.create, mandateArgs)).rejects.toThrow(
			/RBAC_DENIED/,
		);
		const rows = await t.run((ctx) => ctx.db.query("mandates").collect());
		expect(rows).toHaveLength(1);
	});

	test("fixPatterns:create and issues writes are refused to a client admin", async () => {
		const t = createT();
		await seed(t);
		await expect(
			human(t, CLIENT, "org:admin", "acme-admin").mutation(api.fixPatterns.create, {
				symptom: "s",
				rootCause: "r",
				tags: [],
				stack: [],
				sourceProject: "p",
				createdBy: "pi",
				severity: "minor",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("mandates act by agent ID", () => {
	async function mandate(t: T, status?: "delivered") {
		const id = await asService(t).mutation(api.mandates.create, {
			requestedBy: "pi",
			fulfilledBy: "sigma",
			service: "x",
			budget: 10,
		});
		if (status) await t.run((ctx) => ctx.db.patch(id, { status }));
		return id;
	}

	test("create stamps both parties as operator-org agent IDs", async () => {
		const t = createT();
		const { ids } = await seed(t);
		const id = await mandate(t);
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.requestedById).toBe(ids.pi);
		expect(row?.fulfilledById).toBe(ids.sigma);
	});

	test("the fulfilling agent, by verified ID, accepts; the word 'system' and a typed name do not", async () => {
		const t = createT();
		const { ids } = await seed(t);
		const id = await mandate(t);
		await expect(
			asService(t).mutation(api.mandates.accept, { mandateId: id, callerOrchestrator: "system" }),
		).rejects.toThrow(/verified-actor-required/);
		await expect(
			asService(t).mutation(api.mandates.accept, { mandateId: id, callerOrchestrator: "sigma" }),
		).rejects.toThrow(/verified-actor-required/);
		await expect(
			asService(t).mutation(api.mandates.accept, {
				mandateId: id,
				callerOrchestrator: "sigma",
				verifiedActor: actor(ids.omega),
			}),
		).rejects.toThrow(/not-fulfilled-by/);
		await asService(t).mutation(api.mandates.accept, {
			mandateId: id,
			callerOrchestrator: "whatever-label",
			verifiedActor: actor(ids.sigma),
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("accepted");
	});

	test("a same-label agent of ANOTHER org is a different agent and is refused", async () => {
		const t = createT();
		const { clientSigma } = await seed(t);
		const id = await mandate(t);
		await expect(
			asService(t).mutation(api.mandates.accept, {
				mandateId: id,
				callerOrchestrator: "sigma",
				verifiedActor: actor(clientSigma, CLIENT),
			}),
		).rejects.toThrow(/ORG_MISMATCH|RBAC_DENIED/);
		expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("requested");
	});

	test("update cannot settle, and settle is the requester's, on a delivered mandate, with a sane cost", async () => {
		const t = createT();
		const { ids } = await seed(t);
		const id = await mandate(t);
		await expect(
			asService(t).mutation(api.mandates.update, {
				mandateId: id,
				callerOrchestrator: "sigma",
				verifiedActor: actor(ids.sigma),
				status: "settled",
				tokensCost: 99999,
			}),
		).rejects.toThrow(/INVALID_TRANSITION/);
		await asService(t).mutation(api.mandates.update, {
			mandateId: id,
			callerOrchestrator: "sigma",
			verifiedActor: actor(ids.sigma),
			status: "delivered",
			tokensCost: 7,
		});
		await expect(
			asService(t).mutation(api.mandates.settle, {
				mandateId: id,
				callerOrchestrator: "pi",
				verifiedActor: actor(ids.sigma),
				finalCost: 7,
			}),
		).rejects.toThrow(/not-requested-by/);
		await expect(
			asService(t).mutation(api.mandates.settle, {
				mandateId: id,
				callerOrchestrator: "pi",
				verifiedActor: actor(ids.pi),
				finalCost: -1,
			}),
		).rejects.toThrow(/INVALID_AMOUNT/);
		await asService(t).mutation(api.mandates.settle, {
			mandateId: id,
			callerOrchestrator: "pi",
			verifiedActor: actor(ids.pi),
			finalCost: 7,
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect({ status: row?.status, cost: row?.tokensCost }).toEqual({
			status: "settled",
			cost: 7,
		});
	});

	test("a legacy mandate without stamped IDs resolves its party once in the operator org", async () => {
		const t = createT();
		const { ids } = await seed(t);
		const id = await t.run((ctx) =>
			ctx.db.insert("mandates", {
				requestedBy: "pi",
				fulfilledBy: "sigma",
				service: "old",
				budget: 1,
				status: "requested",
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		await asService(t).mutation(api.mandates.accept, {
			mandateId: id,
			callerOrchestrator: "sigma",
			verifiedActor: actor(ids.sigma),
		});
		expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("accepted");
	});
});

describe("fixPatterns:addAttempt - the attempting agent must belong to the fleet", () => {
	async function pattern(t: T) {
		const id = await asService(t).mutation(api.fixPatterns.create, {
			symptom: "s",
			rootCause: "r",
			tags: [],
			stack: [],
			sourceProject: "p",
			createdBy: "pi",
			severity: "minor",
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		return id;
	}
	const attempt = (patternId: Id<"fixPatterns">, extra: object = {}) => ({
		patternId,
		description: "d",
		worked: false,
		why: "w",
		createdBy: "pi",
		...extra,
	});

	test("an operator agent and a transport with no agent are served; a client org agent is refused", async () => {
		const t = createT();
		const { ids, clientSigma } = await seed(t);
		const patternId = await pattern(t);
		await asService(t).mutation(api.fixPatterns.addAttempt, attempt(patternId));
		await asService(t).mutation(
			api.fixPatterns.addAttempt,
			attempt(patternId, { verifiedActor: actor(ids.sigma) }),
		);
		await expect(
			asService(t).mutation(
				api.fixPatterns.addAttempt,
				attempt(patternId, { verifiedActor: actor(clientSigma, CLIENT) }),
			),
		).rejects.toThrow(/ORG_MISMATCH|RBAC_DENIED/);
		const rows = await t.run((ctx) => ctx.db.query("fixAttempts").collect());
		expect(rows).toHaveLength(2);
	});

	test("a client org admin cannot append at all", async () => {
		const t = createT();
		await seed(t);
		const patternId = await pattern(t);
		await expect(
			human(t, CLIENT, "org:admin", "acme-admin").mutation(
				api.fixPatterns.addAttempt,
				attempt(patternId),
			),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});
