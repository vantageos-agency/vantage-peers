/// <reference types="vite/client" />
//
// Task k176aa231w1te2er5w38vkan898fsgpx, module M1: setAddressableFleetCoordinators
// used to scan the active org mappings (fail-closed cap, R-31) to build the
// operator roster of NAMES. It now takes agent IDs and reads each agent and its
// org by ID, so there is no scan and no cap to exceed: the number of active
// organisations is irrelevant. An agent of an INACTIVE operator org is still not
// a source of addressable agents.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const MANY = 600; // well past the old 500-row scan cap

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

const agentOf = (t: T, orgSlug: string, name: string): Promise<Id<"agents">> =>
	t.run((ctx) =>
		ctx.db.insert("agents", {
			orgSlug,
			name,
			normalizedName: name,
			isActive: true,
			createdAt: Date.now(),
		}),
	);

const set = (t: T, clerkOrgSlug: string, agentIds: Id<"agents">[]) =>
	t.mutation(internal.clientOrgMapping.setAddressableFleetCoordinators, {
		clerkOrgSlug,
		agentIds,
	});

describe("setAddressableFleetCoordinators: by ID, no org scan", () => {
	test("serves however many active organisations exist (no scan cap)", async () => {
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
		for (let i = 0; i < MANY; i++) {
			rows.push({
				clerkOrgSlug: `filler-${i}`,
				allowedOrchestrators: [],
				isActive: true,
			});
		}
		await seed(t, rows);
		const pi = await agentOf(t, "perello", "pi");
		expect((await set(t, "iris-rh", [pi])).current).toEqual([pi]);
	});

	test("an agent of an INACTIVE operator org is refused; an active operator agent is served", async () => {
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
		const pi = await agentOf(t, "perello", "pi");
		const ghost = await agentOf(t, "old-op", "ghost");
		await expect(set(t, "iris-rh", [ghost])).rejects.toThrow(
			/NOT_OPERATOR_AGENT/,
		);
		expect((await set(t, "iris-rh", [pi])).current).toEqual([pi]);
	});
});
