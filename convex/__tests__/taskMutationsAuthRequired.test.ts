/// <reference types="vite/client" />
/**
 * convex/__tests__/taskMutationsAuthRequired.test.ts
 *
 * SECURITY REMEDIATION — task k1712yrxjr570m6ks81rnhjh5n8cryf0, ruled by
 * coordinator Pi. The ten public Convex task mutations (create, update,
 * blockTask, complete, failTask, start, checkout, deleteTask, bulkComplete,
 * attachReviewArtifact) were callable by ANYONE holding the deployment URL,
 * with zero identity verification — `assertTaskCallerAuthorized` trusted a
 * caller-supplied `callerOrchestrator` string with no ctx.auth check at all.
 * (attachReviewArtifact was the tenth public mutation, closed in
 * k17675gzd2bwtnvgp0qzmtx35h8csg23 / PR #1211.)
 *
 * This file proves both halves of the fix:
 *
 *   AUTH_REQUIRED        — every one of the ten mutations REFUSES a call
 *                           with no verified identity (ctx.auth.getUserIdentity()
 *                           === null), for both poles: the door is closed
 *                           unconditionally, and a call WITH identity still
 *                           succeeds (the fix does not also break legitimate
 *                           callers).
 *
 *   CONTRADICTION_REFUSED — when callerOrchestrator names an orchestrator
 *                           NOT in the verified identity's allowedOrchestrators
 *                           scope, the call is refused naming BOTH the
 *                           asserted name and the derived scope. The agreeing
 *                           pole (callerOrchestrator within the allowed scope)
 *                           still passes.
 *
 * See convex/lib/auth.ts (withOrgScope) for the client_org_mapping shape that
 * derives `allowedOrchestrators`, and convex/tasks.ts
 * (requireAuthenticatedCaller) for the full STEP 3/4 rationale comment this
 * file exercises.
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

const SERVICE_ACCOUNT_SUBJECT = "test-service-account-user-id"; // matches vitest.config.ts CLERK_SERVICE_ACCOUNT_USER_ID

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	opts: { clerkOrgSlug: string; allowedOrchestrators: string[] },
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: opts.clerkOrgSlug,
			allowedOrchestrators: opts.allowedOrchestrators,
			scopes: ["view-own-tasks", "view-own-missions", "view-orchestrator-summary"],
			displayName: opts.clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedTask(
	t: ReturnType<typeof createT>,
	overrides: Partial<{ assignedTo: string; createdBy: string; status: string }> = {},
) {
	return await t
		.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
		.mutation(api.tasks.create, {
			title: "Seed task",
			assignedTo: overrides.assignedTo ?? "sigma",
			priority: "medium",
			status: (overrides.status as "todo") ?? "todo",
			createdBy: overrides.createdBy ?? overrides.assignedTo ?? "sigma",
		});
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH_REQUIRED — both poles, all nine mutations
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTH_REQUIRED — unauthenticated callers are refused, all ten public task mutations", () => {
	test("create: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();

		await expect(
			t.mutation(api.tasks.create, {
				title: "anon-created",
				assignedTo: "sigma",
				priority: "medium",
				status: "todo",
				createdBy: "sigma",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		const taskId = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.mutation(api.tasks.create, {
				title: "auth-created",
				assignedTo: "sigma",
				priority: "medium",
				status: "todo",
				createdBy: "sigma",
			});
		expect(taskId).toBeTruthy();
	});

	test("update: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "sigma",
				title: "anon-mutated",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "sigma",
			title: "auth-mutated",
		});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.title).toBe("auth-mutated");
	});

	test("blockTask: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const blockerId = await seedTask(t, { assignedTo: "eta", createdBy: "eta" });
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.blockTask, {
				taskId,
				callerOrchestrator: "sigma",
				blockedOnTaskId: blockerId,
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.blockTask, {
			taskId,
			callerOrchestrator: "sigma",
			blockedOnTaskId: blockerId,
		});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("blocked");
	});

	test("complete: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: Date.now(),
			});
		});

		await expect(
			t.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "anon completion attempt sha:deadbeef1",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "sigma",
			completionNote: "auth completion sha:deadbeef2",
		});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("done");
	});

	test("failTask: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.failTask, {
				taskId,
				callerOrchestrator: "sigma",
				failureNote: "anon failure attempt",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.failTask, {
			taskId,
			callerOrchestrator: "sigma",
			failureNote: "auth failure note",
		});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("failed");
	});

	test("start: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.start, {
				taskId,
				callerOrchestrator: "sigma",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "sigma",
		});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("in_progress");
	});

	test("checkout: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.checkout, {
				taskId,
				callerOrchestrator: "sigma",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		const result = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.mutation(api.tasks.checkout, {
				taskId,
				callerOrchestrator: "sigma",
			});
		expect(result.claimed).toBe(true);
	});

	test("deleteTask: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.deleteTask, {
				taskId,
				callerOrchestrator: "sigma",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		const result = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.mutation(api.tasks.deleteTask, {
				taskId,
				callerOrchestrator: "sigma",
			});
		expect(result.deleted).toBe(true);
	});

	test("bulkComplete: no identity -> AUTH_REQUIRED on the dry-run preview path too", async () => {
		const t = createT();
		await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		await expect(
			t.mutation(api.tasks.bulkComplete, {
				filter: { assignedTo: "sigma" },
				dryRun: true,
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		const preview = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.mutation(api.tasks.bulkComplete, {
				filter: { assignedTo: "sigma" },
				dryRun: true,
			});
		expect(preview.count).toBeGreaterThanOrEqual(1);
	});

	test("attachReviewArtifact: no identity -> AUTH_REQUIRED; with identity -> succeeds", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "eta", createdBy: "pi" });

		await expect(
			t.mutation(api.tasks.attachReviewArtifact, {
				taskId,
				callerOrchestrator: "sigma",
				artifactRef: "https://github.com/org/repo/pull/1234",
			}),
		).rejects.toThrow(/AUTH_REQUIRED/);

		await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.mutation(api.tasks.attachReviewArtifact, {
				taskId,
				callerOrchestrator: "sigma",
				artifactRef: "https://github.com/org/repo/pull/1234",
			});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.reviewArtifactRef).toBe("https://github.com/org/repo/pull/1234");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRADICTION_REFUSED — callerOrchestrator vs the verified identity's
// derived scope (client_org_mapping.allowedOrchestrators)
// ─────────────────────────────────────────────────────────────────────────────

describe("CALLER_IDENTITY_MISMATCH — callerOrchestrator contradicting the verified identity's scope is refused, agreeing passes", () => {
	test("update: callerOrchestrator outside the org's allowedOrchestrators -> refused naming both; inside -> passes", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-hr",
			allowedOrchestrators: ["victor"],
		});
		const taskId = await seedTask(t, { assignedTo: "victor", createdBy: "victor" });

		const tVictorOrg = t.withIdentity({
			subject: "user-nadia",
			organizationSlug: "acme-hr",
		} as Parameters<typeof t.withIdentity>[0]);

		// Contradicting pole: the verified identity's org only allows "victor",
		// but the call asserts "sigma" as callerOrchestrator.
		const error = await tVictorOrg
			.mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "sigma",
				title: "mismatch-attempt",
			})
			.catch((e) => e);
		expect(String(error)).toMatch(/CALLER_IDENTITY_MISMATCH/);
		expect(String(error)).toMatch(/sigma/);
		expect(String(error)).toMatch(/victor/);

		// Agreeing pole: callerOrchestrator "victor" is in the org's allowed set.
		await tVictorOrg.mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "victor",
			title: "agreeing-update",
		});
		const after = await tVictorOrg.query(api.tasks.get, { taskId });
		expect(after?.title).toBe("agreeing-update");
	});

	test("complete: callerOrchestrator outside allowedOrchestrators -> refused; inside -> passes", async () => {
		const t = createT();
		await seedOrgMapping(t, {
			clerkOrgSlug: "acme-hr",
			allowedOrchestrators: ["victor"],
		});
		const taskId = await seedTask(t, { assignedTo: "victor", createdBy: "victor" });
		await t.run(async (ctx) => {
			await ctx.db.insert("taskClosureConfig", {
				key: "billableProjects",
				value: [],
				updatedAt: Date.now(),
			});
		});

		const tVictorOrg = t.withIdentity({
			subject: "user-nadia",
			organizationSlug: "acme-hr",
		} as Parameters<typeof t.withIdentity>[0]);

		const error = await tVictorOrg
			.mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "sigma",
				completionNote: "mismatch attempt sha:deadbeef3",
			})
			.catch((e) => e);
		expect(String(error)).toMatch(/CALLER_IDENTITY_MISMATCH/);
		expect(String(error)).toMatch(/sigma/);
		expect(String(error)).toMatch(/victor/);

		await tVictorOrg.mutation(api.tasks.complete, {
			taskId,
			callerOrchestrator: "victor",
			completionNote: "agreeing completion sha:deadbeef4",
		});
		const after = await tVictorOrg.query(api.tasks.get, { taskId });
		expect(after?.status).toBe("done");
	});

	test("master/service-account identity bypasses the membership check regardless of callerOrchestrator (isMaster short-circuit, unaffected regression)", async () => {
		const t = createT();
		const taskId = await seedTask(t, { assignedTo: "sigma", createdBy: "sigma" });

		// Service account has isMaster=true (see convex/lib/auth.ts
		// CLERK_SERVICE_ACCOUNT_USER_ID carve-out) — any callerOrchestrator
		// string still reaches the resource-derived assertTaskCallerAuthorized
		// check below it, unaffected by CALLER_IDENTITY_MISMATCH.
		await t.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT }).mutation(api.tasks.update, {
			taskId,
			callerOrchestrator: "system",
			title: "master-bypass-update",
		});
		const after = await t
			.withIdentity({ subject: SERVICE_ACCOUNT_SUBJECT })
			.query(api.tasks.get, { taskId });
		expect(after?.title).toBe("master-bypass-update");
	});
});
