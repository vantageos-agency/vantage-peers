/// <reference types="vite/client" />
/**
 * okfBundleDurable.cancelOkfBundleExportDurable — write-scope enforcement.
 *
 * DEFECT (pre-fix, on main): this mutation took NO identity check at all —
 * any caller holding a `jobId` (fleet-internal, guessed, or another
 * tenant's) could cancel any tenant's durable OKF export. Fix: reuse the
 * file's own `assertCanExportNamespaceV8` (the SAME check
 * `startOkfBundleExportDurable` already enforces — one identity layer,
 * never a second resolver) against the progress row's STORED `orgId`
 * (== export namespace). Defect class:
 * .claude/rules/authority-attached-to-anonymous-object.md.
 *
 * NOTE on the master/positive pole: `cancelOkfBundleExportDurable` calls
 * `components.agentEngine.engine.durableJob.cancel` via `ctx.runMutation`
 * AFTER the auth gate. `convex/__tests__/okfBundleDurable.test.ts` documents
 * that this worktree's `@vantageos/agent-engine` install cannot be driven
 * end-to-end under `convex-test` at all (its own import of the package's
 * component schema fails to resolve — a harness/packaging limitation, not
 * an application defect). The master-pole test below therefore proves the
 * positive claim this suite CAN prove without that missing dependency: the
 * master identity passes the RBAC gate and reaches the durable-job engine
 * call (i.e. it fails, if at all, on the SAME pre-existing
 * harness limitation — never on RBAC_DENIED / AUTH_NO_IDENTITY /
 * AUTH_NAMESPACE_DENIED). The refusal poles (anonymous, cross-tenant) never
 * reach that call at all — the RBAC_DENIED/AUTH_* throw happens strictly
 * BEFORE `ctx.runMutation(...cancel...)`, so they are fully proven here,
 * independent of the missing package artifact.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

function asOrgA(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-a",
		organizationSlug: "org-a",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asOrgB(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "user-org-b",
		organizationSlug: "org-b",
	} as Parameters<typeof t.withIdentity>[0]);
}

function asMaster(t: ReturnType<typeof createT>) {
	return t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
}

async function seedProgress(
	t: ReturnType<typeof createT>,
	jobId: string,
	orgId: string,
) {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("okfDurableExportProgress", {
			jobId,
			orgId,
			namespace: orgId,
			sinceMs: undefined,
			memoriesCursor: null,
			memoriesDone: false,
			briefingsCursor: null,
			briefingsDone: false,
			tasksCursor: null,
			tasksDone: false,
			memoryCount: 0,
			briefingCount: 0,
			taskCount: 0,
			stepsCompleted: 0,
			status: "running",
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe("okfBundleDurable.cancelOkfBundleExportDurable — write-scope enforcement", () => {
	test("an anonymous (no identity) caller is refused (existence oracle: the row is proven to exist via a direct db read)", async () => {
		const t = createT();
		await seedProgress(t, "job-anon", "team/org-a");

		await expect(
			t.mutation(api.okfBundleDurable.cancelOkfBundleExportDurable, {
				jobId: "job-anon",
			}),
		).rejects.toThrow(/AUTH_NO_IDENTITY/);

		// existence oracle — the row really is there; the refusal above was a
		// refusal, not a "job not found" miss.
		const row = await t.run((ctx) =>
			ctx.db
				.query("okfDurableExportProgress")
				.withIndex("by_jobId", (q) => q.eq("jobId", "job-anon"))
				.unique(),
		);
		expect(row).not.toBeNull();
		expect(row?.status).toBe("running");
	});

	test("an anonymous caller is refused BEFORE any existence check — an unknown jobId gets the SAME AUTH_NO_IDENTITY, never a different error", async () => {
		const t = createT();
		await expect(
			t.mutation(api.okfBundleDurable.cancelOkfBundleExportDurable, {
				jobId: "job-does-not-exist",
			}),
		).rejects.toThrow(/AUTH_NO_IDENTITY/);
	});

	test("a caller from a DIFFERENT org may not cancel another org's durable export (cross-tenant)", async () => {
		const t = createT();
		await seedProgress(t, "job-org-a", "team/org-a");
		const tB = asOrgB(t);

		await expect(
			tB.mutation(api.okfBundleDurable.cancelOkfBundleExportDurable, {
				jobId: "job-org-a",
			}),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);

		const row = await t.run((ctx) =>
			ctx.db
				.query("okfDurableExportProgress")
				.withIndex("by_jobId", (q) => q.eq("jobId", "job-org-a"))
				.unique(),
		);
		expect(row?.status).toBe("running");
	});

	test("the owning org may reach the durable-job cancel call for its own export (passes the RBAC gate)", async () => {
		const t = createT();
		await seedProgress(t, "job-org-a-2", "team/org-a");
		const tA = asOrgA(t);

		// Whatever happens past the auth gate is bounded by the pre-existing,
		// documented @vantageos/agent-engine harness limitation
		// (convex/__tests__/okfBundleDurable.test.ts) — the property this test
		// pins is that the owning org is NEVER refused by RBAC_DENIED /
		// AUTH_NO_IDENTITY / AUTH_NAMESPACE_DENIED.
		await tA
			.mutation(api.okfBundleDurable.cancelOkfBundleExportDurable, {
				jobId: "job-org-a-2",
			})
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				expect(message).not.toMatch(/AUTH_NO_IDENTITY/);
				expect(message).not.toMatch(/AUTH_NAMESPACE_DENIED/);
				expect(message).not.toMatch(/RBAC_DENIED/);
			});
	});

	test("the fleet master namespace ('project/elpi-corp') may cancel without an org-mapping row", async () => {
		const t = createT();
		await seedProgress(t, "job-master", "project/elpi-corp");
		const tMaster = asMaster(t);

		await tMaster
			.mutation(api.okfBundleDurable.cancelOkfBundleExportDurable, {
				jobId: "job-master",
			})
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				expect(message).not.toMatch(/AUTH_NO_IDENTITY/);
				expect(message).not.toMatch(/AUTH_NAMESPACE_DENIED/);
				expect(message).not.toMatch(/RBAC_DENIED/);
			});
	});

	test("no progress row for jobId is a distinct, non-auth refusal", async () => {
		const t = createT();
		const tA = asOrgA(t);
		await expect(
			tA.mutation(api.okfBundleDurable.cancelOkfBundleExportDurable, {
				jobId: "job-missing",
			}),
		).rejects.toThrow(/OKF_DURABLE_JOB_NOT_FOUND/);
	});
});
