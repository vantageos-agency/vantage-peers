/// <reference types="vite/client" />
//
// Task k176aa231w1te2er5w38vkan898fsgpx: setAddressableFleetCoordinators reads
// the active org mappings through by_isActive with a fail-closed cap (R-31).
// Past the cap it refuses rather than validate against a partial roster; an
// inactive operator org's roster is still not a source of addressable names.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const CAP = 500;

type Row = {
	clerkOrgSlug: string;
	allowedOrchestrators: string[];
	isActive: boolean;
	orgKind?: "operator" | "client";
};

async function seed(t: T, rows: Row[]) {
	await t.run(async (ctx) => {
		for (const r of rows) {
			await ctx.db.insert("client_org_mapping", {
				scopes: ["view-own-tasks"],
				displayName: r.clerkOrgSlug,
				createdAt: Date.now(),
				...r,
			});
		}
	});
}

const set = (t: T, clerkOrgSlug: string, names: string[]) =>
	t.mutation(internal.clientOrgMapping.setAddressableFleetCoordinators, {
		clerkOrgSlug,
		names,
	});

describe("setAddressableFleetCoordinators: bounded, fail-closed org scan", () => {
	test("refuses with ORG_MAPPING_SCAN_CAP_EXCEEDED when active rows exceed the cap", async () => {
		const t = createT();
		const rows: Row[] = [
			{
				clerkOrgSlug: "perello",
				allowedOrchestrators: ["pi"],
				isActive: true,
				orgKind: "operator",
			},
			{
				clerkOrgSlug: "iris-rh",
				allowedOrchestrators: ["irisbot"],
				isActive: true,
			},
		];
		for (let i = 0; i < CAP - 1; i++) {
			rows.push({
				clerkOrgSlug: `filler-${i}`,
				allowedOrchestrators: [],
				isActive: true,
			});
		}
		await seed(t, rows); // CAP + 1 active rows in total
		await expect(set(t, "iris-rh", ["pi"])).rejects.toThrow(
			/ORG_MAPPING_SCAN_CAP_EXCEEDED/,
		);
	});

	test("exactly CAP active rows still serves", async () => {
		const t = createT();
		const rows: Row[] = [
			{
				clerkOrgSlug: "perello",
				allowedOrchestrators: ["pi"],
				isActive: true,
				orgKind: "operator",
			},
			{
				clerkOrgSlug: "iris-rh",
				allowedOrchestrators: ["irisbot"],
				isActive: true,
			},
		];
		for (let i = 0; i < CAP - 2; i++) {
			rows.push({
				clerkOrgSlug: `filler-${i}`,
				allowedOrchestrators: [],
				isActive: true,
			});
		}
		await seed(t, rows);
		const r = await set(t, "iris-rh", ["pi"]);
		expect(r.current).toEqual(["pi"]);
	});

	test("an INACTIVE operator org's roster name is still refused", async () => {
		const t = createT();
		await seed(t, [
			{
				clerkOrgSlug: "perello",
				allowedOrchestrators: ["pi"],
				isActive: true,
				orgKind: "operator",
			},
			{
				clerkOrgSlug: "old-op",
				allowedOrchestrators: ["ghost"],
				isActive: false,
				orgKind: "operator",
			},
			{
				clerkOrgSlug: "iris-rh",
				allowedOrchestrators: ["irisbot"],
				isActive: true,
			},
		]);
		await expect(set(t, "iris-rh", ["ghost"])).rejects.toThrow(
			/NOT_OPERATOR_ORCHESTRATOR/,
		);
		expect((await set(t, "iris-rh", ["pi"])).current).toEqual(["pi"]);
	});
});
