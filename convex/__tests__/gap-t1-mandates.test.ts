/// <reference types="vite/client" />
//
// GAP-T1 (D90 ship-blocker) — direct behavioral tests for financial-mandate
// state machine tools (3 of the 19):
//
//   5. accept_mandate            → convex/mandates.ts :: accept (mutation)
//   6. settle_mandate            → convex/mandates.ts :: settle (mutation)
//   7. validate_mandate_spending → convex/mandates.ts :: validateSpending (query)
//
// State machine: requested → accepted → in_progress → delivered → settled.
// Auth (M11): only the fulfilling AGENT (by verified ID) can accept/update; only
// the requesting agent can settle, and only a delivered mandate. The word
// "system" carries no authority. We test happy-path + auth-refused edge.
//
// Orchestrator: Sigma — VantagePeers | 2026-06-19

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

// mandates.create/accept/settle now require the verified fleet master
// (convex/lib/auth.ts's withOrgScope isMaster grant — see
// convex/__tests__/mandatesWriteScope.test.ts) — this fixture exercises the
// pre-existing state-machine/auth behaviour, so it authenticates as the
// recognized service-account carve-out configured in vitest.config.ts.
function asMaster(t: ReturnType<typeof createTestConvex>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

// The acting agent as the MCP transport would forward it: the operator-org
// agent row of `name`, by ID.
async function actorOf(t: ReturnType<typeof createTestConvex>, name: string) {
	const ids = await seedFleetAgents(t, [name]);
	const row = await t.run((ctx) => ctx.db.get(ids[name]));
	return { agentId: ids[name], orgSlug: row?.orgSlug as string };
}

async function seedMandate(
	t: ReturnType<typeof createTestConvex>,
	opts: {
		requestedBy?: string;
		fulfilledBy?: string;
		budget?: number;
		tokensCost?: number;
		maxPerTransaction?: number;
	} = {},
) {
	const requestedBy = opts.requestedBy ?? "sigma";
	const fulfilledBy = opts.fulfilledBy ?? "tau";
	await seedFleetAgents(t, [requestedBy, fulfilledBy, "phi"]);
	return await asMaster(t).mutation(api.mandates.create, {
		requestedBy,
		fulfilledBy,
		service: "behavioral-test-service",
		budget: opts.budget ?? 1000,
		spendingLimits:
			opts.maxPerTransaction !== undefined
				? {
						maxPerTransaction: opts.maxPerTransaction,
						maxPerPeriod: opts.maxPerTransaction * 10,
					}
				: undefined,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// accept_mandate
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 accept_mandate — mandates.accept mutation", () => {
	test("happy path — fulfilledBy accepts a requested mandate, status flips to accepted", async () => {
		const t = createTestConvex();
		const mandateId = await seedMandate(t, {
			requestedBy: "sigma",
			fulfilledBy: "tau",
		});

		await asMaster(t).mutation(api.mandates.accept, {
			mandateId,
			callerOrchestrator: "tau",
			verifiedActor: await actorOf(t, "tau"),
		});

		const row = await asMaster(t).query(api.mandates.get, { mandateId });
		expect(row?.status).toBe("accepted");
	});

	test("edge case — non-fulfilledBy caller is refused (auth check)", async () => {
		const t = createTestConvex();
		const mandateId = await seedMandate(t, {
			requestedBy: "sigma",
			fulfilledBy: "tau",
		});

		await expect(
			asMaster(t).mutation(api.mandates.accept, {
				mandateId,
				callerOrchestrator: "phi", // not fulfilledBy, not system → refused
				verifiedActor: await actorOf(t, "phi"),
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// settle_mandate
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 settle_mandate — mandates.settle mutation", () => {
	test("happy path — requestedBy settles with final cost, status=settled + completedAt set", async () => {
		const t = createTestConvex();
		const mandateId = await seedMandate(t, {
			requestedBy: "sigma",
			fulfilledBy: "tau",
		});

		await t.run((ctx) => ctx.db.patch(mandateId, { status: "delivered" }));
		await asMaster(t).mutation(api.mandates.settle, {
			mandateId,
			callerOrchestrator: "sigma",
			verifiedActor: await actorOf(t, "sigma"),
			finalCost: 250,
		});

		const row = await asMaster(t).query(api.mandates.get, { mandateId });
		expect(row?.status).toBe("settled");
		expect(row?.tokensCost).toBe(250);
		expect(row?.completedAt).toBeGreaterThan(0);
	});

	test("edge case — non-requestedBy caller is refused", async () => {
		const t = createTestConvex();
		const mandateId = await seedMandate(t, {
			requestedBy: "sigma",
			fulfilledBy: "tau",
		});

		await expect(
			asMaster(t).mutation(api.mandates.settle, {
				mandateId,
				callerOrchestrator: "tau", // fulfilledBy cannot settle — only requestedBy
				verifiedActor: await actorOf(t, "tau"),
				finalCost: 100,
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// validate_mandate_spending
// ─────────────────────────────────────────────────────────────────────────────

describe("GAP-T1 validate_mandate_spending — mandates.validateSpending query", () => {
	test("happy path — proposed spend within budget + per-tx cap returns withinLimits=true", async () => {
		const t = createTestConvex();
		const mandateId = await seedMandate(t, {
			budget: 1000,
			maxPerTransaction: 500,
		});

		const result = await asMaster(t).query(api.mandates.validateSpending, {
			mandateId,
			proposedAmount: 200,
		});

		expect(result.withinLimits).toBe(true);
		expect(result.currentSpend).toBe(0);
		expect(result.perTransactionLimit).toBe(500);
	});

	test("edge case — proposed spend exceeds per-transaction limit, withinLimits=false with reason", async () => {
		const t = createTestConvex();
		const mandateId = await seedMandate(t, {
			budget: 1000,
			maxPerTransaction: 100,
		});

		const result = await asMaster(t).query(api.mandates.validateSpending, {
			mandateId,
			proposedAmount: 250,
		});

		expect(result.withinLimits).toBe(false);
		expect(result.reason).toMatch(/per-transaction/i);
		expect(result.perTransactionLimit).toBe(100);
	});
});
