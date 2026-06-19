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
// Auth: only fulfilledBy (or "system") can accept/update; only requestedBy
// (or "system") can settle. We test happy-path + auth-refused edge.
//
// Orchestrator: Sigma — VantagePeers | 2026-06-19

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createTestConvex = () => convexTest(schema, modules);

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
	return await t.mutation(api.mandates.create, {
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

		await t.mutation(api.mandates.accept, {
			mandateId,
			callerOrchestrator: "tau",
		});

		const row = await t.query(api.mandates.get, { mandateId });
		expect(row?.status).toBe("accepted");
	});

	test("edge case — non-fulfilledBy caller is refused (auth check)", async () => {
		const t = createTestConvex();
		const mandateId = await seedMandate(t, {
			requestedBy: "sigma",
			fulfilledBy: "tau",
		});

		await expect(
			t.mutation(api.mandates.accept, {
				mandateId,
				callerOrchestrator: "phi", // not fulfilledBy, not system → refused
			}),
		).rejects.toThrow(/Unauthorized/);
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

		await t.mutation(api.mandates.settle, {
			mandateId,
			callerOrchestrator: "sigma",
			finalCost: 250,
		});

		const row = await t.query(api.mandates.get, { mandateId });
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
			t.mutation(api.mandates.settle, {
				mandateId,
				callerOrchestrator: "tau", // fulfilledBy cannot settle — only requestedBy
				finalCost: 100,
			}),
		).rejects.toThrow(/Unauthorized/);
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

		const result = await t.query(api.mandates.validateSpending, {
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

		const result = await t.query(api.mandates.validateSpending, {
			mandateId,
			proposedAmount: 250,
		});

		expect(result.withinLimits).toBe(false);
		expect(result.reason).toMatch(/per-transaction/i);
		expect(result.perTransactionLimit).toBe(100);
	});
});
