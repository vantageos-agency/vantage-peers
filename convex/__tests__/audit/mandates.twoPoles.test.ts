/// <reference types="vite/client" />
/**
 * AUDIT RED reproduction, group R2 — mandates doors (create / accept / update / settle).
 *
 * Every test asserts what the door MUST do. A test that FAILS here means the
 * audited defect is real on this tree. Identity: `mandates` is fleet-internal
 * and master-only (requireFleetMaster), so the only identity that reaches the
 * handler is the claimless fleet service account (CLERK_SERVICE_ACCOUNT_USER_ID).
 * The defect under test is precisely "that identity can type any party name /
 * the word 'system' / any number", so the service account is the subject here.
 * A positive control per file proves the doors are reachable under that identity.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const asMaster = (t: T) =>
	t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);

async function seedMandate(
	t: T,
	o: {
		requestedBy: string;
		fulfilledBy: string;
		status?: "requested" | "accepted" | "in_progress" | "delivered";
	},
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert("mandates", {
			requestedBy: o.requestedBy,
			fulfilledBy: o.fulfilledBy,
			service: "seo audit",
			budget: 1000,
			status: o.status ?? "requested",
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe("mandates — positive control (the doors are reachable as the service account)", () => {
	test("mandates:create with a valid budget is served", async () => {
		const t = createT();
		const id = await asMaster(t).mutation(api.mandates.create, {
			requestedBy: "pi",
			fulfilledBy: "sigma",
			service: "x",
			budget: 10,
		});
		expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
	});
});

describe("mandates:create", () => {
	test("mandates:create — a negative budget is refused and nothing is inserted (service account)", async () => {
		const t = createT();
		let outcome = "resolved";
		try {
			await asMaster(t).mutation(api.mandates.create, {
				requestedBy: "pi",
				fulfilledBy: "sigma",
				service: "x",
				budget: -1,
			});
		} catch {
			outcome = "refused";
		}
		const rows = await t.run((ctx) => ctx.db.query("mandates").collect());
		expect(
			{ outcome, rows: rows.map((r) => r.budget) },
			"a mandate with budget -1 was inserted",
		).toEqual({ outcome: "refused", rows: [] });
	});
});

describe("mandates:accept", () => {
	test("mandates:accept — typing 'system' does not accept a mandate fulfilledBy omega (service account, no verified actor)", async () => {
		const t = createT();
		const id = await seedMandate(t, { requestedBy: "pi", fulfilledBy: "omega" });
		let outcome = "resolved";
		try {
			await asMaster(t).mutation(api.mandates.accept, {
				mandateId: id,
				callerOrchestrator: "system",
			});
		} catch {
			outcome = "refused";
		}
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(
			{ outcome, status: row?.status },
			"mandate fulfilledBy omega was accepted by the typed word 'system'",
		).toEqual({ outcome: "refused", status: "requested" });
	});

	test("mandates:accept — typing another orchestrator's name ('sigma') does not accept it (deny pole already enforced by name compare)", async () => {
		const t = createT();
		const id = await seedMandate(t, { requestedBy: "pi", fulfilledBy: "omega" });
		await expect(
			asMaster(t).mutation(api.mandates.accept, {
				mandateId: id,
				callerOrchestrator: "sigma",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});

describe("mandates:update", () => {
	test("mandates:update — the fulfiller cannot settle with a self-chosen cost (service account typed as 'sigma')", async () => {
		const t = createT();
		const id = await seedMandate(t, {
			requestedBy: "pi",
			fulfilledBy: "sigma",
			status: "in_progress",
		});
		let outcome = "resolved";
		try {
			await asMaster(t).mutation(api.mandates.update, {
				mandateId: id,
				callerOrchestrator: "sigma",
				status: "settled",
				tokensCost: 99999,
			});
		} catch {
			outcome = "refused";
		}
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(
			{ outcome, status: row?.status, tokensCost: row?.tokensCost },
			"fulfiller settled the mandate through update with tokensCost 99999, requestedBy never confirmed",
		).toEqual({ outcome: "refused", status: "in_progress", tokensCost: undefined });
	});
});

describe("mandates:settle", () => {
	test("mandates:settle — a mandate still 'requested' cannot be settled, nor with a negative finalCost (service account typed 'system')", async () => {
		const t = createT();
		const id = await seedMandate(t, { requestedBy: "pi", fulfilledBy: "sigma" });
		let outcome = "resolved";
		try {
			await asMaster(t).mutation(api.mandates.settle, {
				mandateId: id,
				callerOrchestrator: "system",
				finalCost: -5,
			});
		} catch {
			outcome = "refused";
		}
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(
			{ outcome, status: row?.status, tokensCost: row?.tokensCost },
			"a 'requested' mandate was settled with finalCost -5",
		).toEqual({ outcome: "refused", status: "requested", tokensCost: undefined });
	});
});
