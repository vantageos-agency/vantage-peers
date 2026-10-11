/// <reference types="vite/client" />
// automationTaskCancel.test.ts — task k17d351cphxtad91yqeqrhmhqx8fnktg
//
// A task the GitHub webhook minted (incident chain, created through
// createForWebhook) has no station creator, so no station could cancel it.
// A caller listed under taskClosureConfig "automationTaskCancellers" may set
// status="cancelled" WITH a non-empty cancelReason on such a row, and change
// nothing else. Key absent/empty -> refused, as before.

import { ConvexError } from "convex/values";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search"),
	),
);

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;
const svc = (t: T) => t.withIdentity({ subject: "test-service-account-user-id" });

const seedCancellers = (t: T, value: string[]) =>
	t.run(async (ctx) => {
		await ctx.db.insert("taskClosureConfig", {
			key: "automationTaskCancellers",
			value,
			updatedAt: 0,
		});
	});

// Created exactly the way convex/http.ts creates an incident-chain step.
const chainTask = (t: T) =>
	t.mutation(internal.tasks.createForWebhook, {
		title: "[#41] T0 — triage the incident",
		description: "step\n\nIssue: https://example.test/41\nRepo: org/repo",
		assignedTo: "sigma",
		project: "vantage-peers",
		priority: "high",
		status: "todo",
		createdBy: "system",
		tags: ["github", "irp"],
	});

const cancel = (t: T, id: never, caller: string, extra: Record<string, unknown> = {}) =>
	svc(t)
		.mutation(api.tasks.update, {
			taskId: id,
			callerOrchestrator: caller,
			status: "cancelled",
			cancelReason: "incident chain auto-closed by operator order",
			...extra,
		} as never)
		.catch((e: unknown) => e);

const row = (t: T, id: never) =>
	t.run(async (ctx) => (await ctx.db.get(id)) as Record<string, unknown>);

const expectDenied = (err: unknown) => {
	expect(err).toBeInstanceOf(ConvexError);
	expect((err as ConvexError<string>).message).toContain("RBAC_DENIED");
};

describe("automation task cancel grant", () => {
	test("RED: listed pi cancels a webhook-created chain task with a reason", async () => {
		const t = makeT();
		await seedCancellers(t, ["pi"]);
		const id = (await chainTask(t)) as never;
		const err = await cancel(t, id, "pi");
		expect(err).toBeNull();
		const r = await row(t, id);
		expect(r.status).toBe("cancelled");
		expect(r.cancelReason).toBe("incident chain auto-closed by operator order");
		expect(r.cancelledBy).toBe("pi");
	});

	test("pi without a reason is refused", async () => {
		const t = makeT();
		await seedCancellers(t, ["pi"]);
		const id = (await chainTask(t)) as never;
		const err = await svc(t)
			.mutation(api.tasks.update, { taskId: id, callerOrchestrator: "pi", status: "cancelled" } as never)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConvexError);
		expect((await row(t, id)).status).toBe("todo");
		const blank = await cancel(t, id, "pi", { cancelReason: "   " });
		expect(blank).toBeInstanceOf(ConvexError);
		expect((await row(t, id)).status).toBe("todo");
	});

	test("pi on a NON-automation task it neither created nor holds -> RBAC_DENIED", async () => {
		const t = makeT();
		await seedCancellers(t, ["pi"]);
		const id = (await svc(t).mutation(api.tasks.create, {
			title: "plain chore",
			assignedTo: "sigma",
			priority: "low",
			status: "todo",
			createdBy: "omega",
		})) as never;
		expectDenied(await cancel(t, id, "pi"));
		expect((await row(t, id)).status).toBe("todo");
	});

	test("sigma (not listed) -> RBAC_DENIED", async () => {
		const t = makeT();
		await seedCancellers(t, ["pi"]);
		const id = (await chainTask(t)) as never;
		// sigma is the assignee: the ordinary path still refuses a non-creator cancel.
		expectDenied(await cancel(t, id, "sigma"));
		expect((await row(t, id)).status).toBe("todo");
	});

	test("key absent -> RBAC_DENIED", async () => {
		const t = makeT();
		const id = (await chainTask(t)) as never;
		expectDenied(await cancel(t, id, "pi"));
	});

	test("key present but empty -> RBAC_DENIED", async () => {
		const t = makeT();
		await seedCancellers(t, []);
		const id = (await chainTask(t)) as never;
		expectDenied(await cancel(t, id, "pi"));
	});

	test("pi changing another field on the grant path is refused, row untouched", async () => {
		const t = makeT();
		await seedCancellers(t, ["pi"]);
		const id = (await chainTask(t)) as never;
		for (const extra of [{ title: "hijack" }, { assignedTo: "omega" }]) {
			const err = await cancel(t, id, "pi", extra);
			expect(err).toBeInstanceOf(ConvexError);
		}
		const r = await row(t, id);
		expect(r.status).toBe("todo");
		expect(r.title).toBe("[#41] T0 — triage the incident");
		expect(r.assignedTo).toBe("sigma");
	});

	test("pi cannot use the grant for another status transition (done / in_progress)", async () => {
		const t = makeT();
		await seedCancellers(t, ["pi"]);
		const id = (await chainTask(t)) as never;
		const err = await svc(t)
			.mutation(api.tasks.update, { taskId: id, callerOrchestrator: "pi", status: "in_progress" } as never)
			.catch((e: unknown) => e);
		expectDenied(err);
	});

	test("existing-row shape (createdBy system, NO origin): refused until backfilled, then granted", async () => {
		const t = makeT();
		await seedCancellers(t, ["pi"]);
		const id = (await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "[#7] T2 — verify the fix",
				assignedTo: "sigma",
				priority: "high",
				status: "todo",
				createdBy: "system",
				tags: ["github", "irp"],
				isReviewTask: false,
				orgId: undefined,
				createdAt: 1,
				updatedAt: 1,
			}),
		)) as never;
		expectDenied(await cancel(t, id, "pi"));
		const res = await t.mutation(
			internal.migrations.backfill_webhook_task_origin.backfillOrigin,
			{},
		);
		expect(res.isDone).toBe(true);
		expect(res.updated).toBe(1);
		expect((await row(t, id)).origin).toBe("automation-webhook");
		expect(await cancel(t, id, "pi")).toBeNull();
		expect((await row(t, id)).status).toBe("cancelled");
	});

	test("backfill leaves a createdBy-system row with a non-webhook title alone", async () => {
		const t = makeT();
		const id = (await t.run(async (ctx) =>
			ctx.db.insert("tasks", {
				title: "forged by a master caller",
				assignedTo: "sigma",
				priority: "low",
				status: "todo",
				createdBy: "system",
				isReviewTask: false,
				orgId: undefined,
				createdAt: 1,
				updatedAt: 1,
			}),
		)) as never;
		const res = await t.mutation(
			internal.migrations.backfill_webhook_task_origin.backfillOrigin,
			{},
		);
		expect(res.updated).toBe(0);
		expect((await row(t, id)).origin).toBeUndefined();
	});

	test("an already-done automation task cannot be cancelled through the grant", async () => {
		const t = makeT();
		await seedCancellers(t, ["pi"]);
		const id = (await chainTask(t)) as never;
		await t.run(async (ctx) => ctx.db.patch(id, { status: "done" }));
		const err = await cancel(t, id, "pi");
		expect(err).toBeInstanceOf(ConvexError);
		expect((await row(t, id)).status).toBe("done");
	});
});
