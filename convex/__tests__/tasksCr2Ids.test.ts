/// <reference types="vite/client" />
// ─────────────────────────────────────────────────────────────────────────────
// tasksCr2Ids.test.ts — CR-2 remainder of module M7 (tasks by actor ID).
//
// `tasks:update` refuses to hand a system review task to the repo's OWN
// orchestrator (a delivery is never reviewed by its author). That guard decides
// on agents-row IDs: the repo mapping's owner label and the typed target are
// each resolved within the task's organisation and the two IDs are compared.
// A spelling of the owner that the name compare could not equate (a different
// Unicode form of the same label) is still the same agent.
// ─────────────────────────────────────────────────────────────────────────────

import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { api, internal } from "../_generated/api";
import { normalizeOrchestratorId } from "../_helpers/normalizeOrchestratorId";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const REPO = "vantageos-agency/author-repo";
// "séraphin" with a precomposed é (NFC) as the stored label; the caller types the
// decomposed form (e + combining acute), which normalizeOrchestratorId equates.
const OWNER_NFC = "séraphin";
const OWNER_NFD = "séraphin";

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const svc = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function setup() {
	const t = createT();
	await seedFleetAgents(t, ["pi", "argus"]);
	await t.run(async (ctx) => {
		// The accented owner is seeded by hand: seedFleetAgents returns a record
		// keyed by label, and a Convex value cannot carry a non-ASCII field name.
		const operator = (await ctx.db.query("client_org_mapping").collect()).find(
			(m) => m.orgKind === "operator",
		);
		await ctx.db.insert("agents", {
			orgSlug: operator?.clerkOrgSlug ?? "fleet-operator",
			clerkOrgId: operator?.clerkOrgId,
			name: OWNER_NFC,
			normalizedName: normalizeOrchestratorId(OWNER_NFC),
			isActive: true,
			createdAt: 1,
		});
		await ctx.db.insert("githubRepoMapping", {
			repo: REPO,
			orchestrator: OWNER_NFC,
			project: "author-repo",
			active: true,
		});
		await ctx.db.insert("taskClosureConfig", {
			key: "reviewCoordinators",
			value: ["pi"],
			updatedAt: Date.now(),
		});
	});
	const taskId = (await t.mutation(internal.tasks.createOrUpdateReviewTask, {
		repoFullName: REPO,
		prNumber: 7,
		prTitle: "a change",
		assignedTo: "argus",
		priority: "high",
		createdBy: "system",
	}))!;
	return { t, taskId };
}

describe("tasks:update — the self-review guard decides on agent IDs", () => {
	test("RED/GREEN: the coordinator cannot hand the review to the repo owner typed in another Unicode form", async () => {
		const { t, taskId } = await setup();
		const err = await svc(t)
			.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "pi",
				assignedTo: OWNER_NFD,
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		expect((err as ConvexError<string>).message).toContain("never reviewed by its author");
		const row = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(row?.assignedTo).toBe("argus");
	});

	test("the owner's own spelling is refused as before", async () => {
		const { t, taskId } = await setup();
		const err = await svc(t)
			.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "pi",
				assignedTo: OWNER_NFC,
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		expect((err as ConvexError<string>).message).toContain("never reviewed by its author");
	});

	test("a reviewer who is not the owner is still assignable", async () => {
		const { t, taskId } = await setup();
		await seedFleetAgents(t, ["eta"]);
		await svc(t).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "pi",
			assignedTo: "eta",
		});
		const row = await t.run(async (ctx) => await ctx.db.get(taskId));
		expect(row?.assignedTo).toBe("eta");
	});
});
