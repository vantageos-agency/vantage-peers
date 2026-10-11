/// <reference types="vite/client" />
/**
 * Name collision across tenants on the MCP path (bulk_complete_tasks).
 *
 * Orchestrator names are NOT unique across organisations: org-a and org-b can
 * each have an agent named "eta". Through MCP the call reaches Convex as the
 * fleet service account (master scope), so the scan sees every tenant's rows
 * and the only per-row control left was "createdBy/assignedTo === the asserted
 * callerOrchestrator" — a NAME. An org-a "eta" therefore matched, and closed,
 * org-b's "eta" tasks.
 *
 * The fix narrows the match set to the verified org the transport forwards
 * (`verifiedOrg`, believed from the service account only). Without a
 * verifiedOrg (the master / fleet path) nothing narrows, as before.
 *
 * Poles: LEAK (org-b untouched), PRESENT (org-a's own matching tasks close),
 * DRAIN (the continuation keeps the narrowing), FLEET (no verifiedOrg: the
 * unchanged master path still reaches every tenant).
 */

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("search"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function seed(t: T) {
	await t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "billableProjects",
			value: [],
			updatedAt: Date.now(),
		});
		for (const slug of ["org-a", "org-b"]) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: ["eta"],
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: Date.now(),
			});
		}
	});
}

async function seedRows(t: T, orgId: string, n: number, by: "assigned" | "created") {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (let i = 0; i < n; i++) {
			await ctx.db.insert("tasks", {
				title: `${orgId} ${by} ${i}`,
				assignedTo: by === "assigned" ? "eta" : "someone",
				createdBy: by === "created" ? "eta" : "someone",
				priority: "low",
				status: "todo",
				orgId,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

const done = async (t: T, orgId: string) =>
	(await t.run((ctx) => ctx.db.query("tasks").collect())).filter(
		(r) => r.orgId === orgId && r.status === "done",
	).length;

describe("bulkComplete — verifiedOrg narrows the match set", () => {
	test("LEAK + PRESENT: an org-a 'eta' closes org-a's eta tasks and NONE of org-b's, assigned or created", async () => {
		const t = createT();
		await seed(t);
		await seedRows(t, "org-a", 3, "assigned");
		await seedRows(t, "org-a", 2, "created");
		await seedRows(t, "org-b", 3, "assigned");
		await seedRows(t, "org-b", 2, "created");

		// The MCP path: service account + the asserted name + the verified org.
		const preview = await asService(t).mutation(api.tasks.bulkComplete, {
			filter: { status: "todo" },
			callerOrchestrator: "eta",
			verifiedOrg: { orgSlug: "org-a" },
		});
		expect(preview.count).toBe(5); // org-a's only

		const res = await asService(t).mutation(api.tasks.bulkComplete, {
			filter: { status: "todo" },
			dryRun: false,
			callerOrchestrator: "eta",
			verifiedOrg: { orgSlug: "org-a" },
		});
		expect(res.count).toBe(5);
		expect(await done(t, "org-a")).toBe(5); // PRESENT
		expect(await done(t, "org-b")).toBe(0); // LEAK closed
	});

	test("DRAIN: the continuation keeps the narrowing across batches", async () => {
		const t = createT();
		await seed(t);
		await seedRows(t, "org-a", 520, "assigned");
		await seedRows(t, "org-b", 30, "assigned");
		const res = await asService(t).mutation(api.tasks.bulkComplete, {
			filter: { assignedTo: "eta" },
			dryRun: false,
			callerOrchestrator: "eta",
			verifiedOrg: { orgSlug: "org-a" },
		});
		expect(res.remaining).toBe(true);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await done(t, "org-a")).toBe(520);
		expect(await done(t, "org-b")).toBe(0);
	});

	test("FLEET: with no verifiedOrg the master path is unchanged and reaches every tenant", async () => {
		const t = createT();
		await seed(t);
		await seedRows(t, "org-a", 2, "assigned");
		await seedRows(t, "org-b", 2, "assigned");
		const res = await asService(t).mutation(api.tasks.bulkComplete, {
			filter: { assignedTo: "eta" },
			dryRun: false,
			callerOrchestrator: "system",
		});
		expect(res.count).toBe(4);
		expect(await done(t, "org-b")).toBe(2);
	});
});
