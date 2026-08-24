/// <reference types="vite/client" />
/**
 * [P-T5] THE LOCK — convex/lib/auth.ts's `requireAgentCredentialMatch`,
 * wired into convex/messages.ts's `sendMessage` (the `from` write surface)
 * and convex/tasks.ts's `create`/`update` (the `createdBy`/`callerOrchestrator`
 * write surfaces), on top of P-T4's `resolveAgentCredential`.
 *
 * Cap analysis/le-cap/le-cap.md @ e3c1ffd6 §6 VP.4 (second half) — NO
 * COMPATIBILITY WINDOW: the acting agent is derived from the presented
 * per-agent credential, never from a caller-declared name; a credential
 * that resolves to no agent (an org-only/shared token) is refused with no
 * exemption path.
 *
 * THE PROPERTY (both poles, per surface):
 *   ALLOW — HOLDER of agent-B's credential asserts name "b" -> accepted.
 *   DENY  — HOLDER of agent-B's credential asserts name "c" (a DIFFERENT
 *           agent's name) -> refused AGENT_IDENTITY_MISMATCH.
 *   DENY  — a credential string that resolves to no agent at all (garbage /
 *           an org-only token) presented at the agent-named surface ->
 *           refused, no fallback.
 *   NO REGRESSION — a legitimate call that never presents
 *           `agentCredentialSecret` behaves exactly as before P-T5.
 *
 * Identities named per measurement: mint runs under org:admin
 * (`admin-of-org-o`); the surfaces under test run under the
 * `test-service-account-user-id` master carve-out (see vitest.config.ts) —
 * that identity is what proves the CREDENTIAL layer, not the Clerk org
 * layer, is what's being tested. Neither pole is master's OWN identity
 * asserting a name — the mismatch check runs regardless of who calls, and
 * is scoped by the credential's resolved identity, never by ctx.auth.
 *
 * DELETION PROBE (documented, run manually, not committed as a code change):
 * removing the `if (resolved.agentName !== assertedName) throw ...` branch
 * body from `requireAgentCredentialMatch` (convex/lib/auth.ts) makes the
 * "DENY: agent-B-cred asserting name c" test below go RED (the forged-name
 * call PASSES instead of refusing) — proving the test measures the mismatch
 * check, not something incidental. Restored afterward; ratio recorded in
 * the dispatching brief's RETURN section.
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

function createT(): ReturnType<typeof convexTest> {
	return convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;
}

const orgAdminIdentity = (org: string) => ({
	subject: `admin-of-${org}`,
	org_slug: org,
	org_role: "org:admin",
});

// The master service-account carve-out (vitest.config.ts sets
// CLERK_SERVICE_ACCOUNT_USER_ID to this exact subject) — used for the
// write-surface calls so the identity dimension is held constant and the
// credential dimension is the only thing varying between ALLOW and DENY.
function asServiceAccount(t: ReturnType<typeof createT>) {
	return t.withIdentity({ subject: "test-service-account-user-id" });
}

async function seedOrgMapping(t: ReturnType<typeof createT>, clerkOrgSlug: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators: ["b", "c"],
			scopes: ["view-own-tasks"],
			displayName: clerkOrgSlug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function seedProfile(t: ReturnType<typeof createT>, orchestratorId: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("profiles", {
			orchestratorId,
			name: orchestratorId,
			static: { role: orchestratorId, workspace: "test", capabilities: [] },
			dynamic: { lastSeen: Date.now(), sessionCount: 1 },
		});
	});
}

async function mintAgent(
	t: ReturnType<typeof createT>,
	org: string,
	agentName: string,
): Promise<string> {
	const tAdmin = t.withIdentity(
		orgAdminIdentity(org) as Parameters<typeof t.withIdentity>[0],
	);
	await tAdmin.mutation(api.agents.registerAgent, { orgSlug: org, name: agentName });
	const minted = await tAdmin.mutation(api.agentCredentials.mintAgentCredential, {
		orgSlug: org,
		agentName,
	});
	return minted.secret;
}

describe("[P-T5] THE LOCK — sendMessage (from)", () => {
	test("ALLOW: HOLDER of agent-B's credential sends a message as \"b\"", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		await seedProfile(t, "b");
		await seedProfile(t, "recipient-role");
		const bCred = await mintAgent(t, "org-o", "b");

		const messageId = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "b",
			channel: "recipient-role",
			content: "hello as b",
			agentCredentialSecret: bCred,
		});
		expect(messageId).toBeTruthy();
	});

	test("DENY: HOLDER of agent-B's credential asserts name \"c\" -> AGENT_IDENTITY_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		await seedProfile(t, "c");
		await seedProfile(t, "recipient-role");
		const bCred = await mintAgent(t, "org-o", "b");
		await mintAgent(t, "org-o", "c"); // c also exists in this org

		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "c",
				channel: "recipient-role",
				content: "forged as c",
				agentCredentialSecret: bCred,
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});

	test("DENY (no-compat-window): a credential that resolves to no agent (garbage / org-only token) is refused", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		await seedProfile(t, "b");
		await seedProfile(t, "recipient-role");

		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "b",
				channel: "recipient-role",
				content: "no valid agent credential",
				agentCredentialSecret: "org-only-shared-token-not-an-agent-secret",
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});

	test("NO REGRESSION: a call omitting agentCredentialSecret entirely behaves exactly as before P-T5", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		await seedProfile(t, "b");
		await seedProfile(t, "recipient-role");

		const messageId = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: "b",
			channel: "recipient-role",
			content: "legacy call, no credential",
		});
		expect(messageId).toBeTruthy();
	});
});

describe("[P-T5] THE LOCK — tasks.create (createdBy) / tasks.update (callerOrchestrator)", () => {
	test("ALLOW: HOLDER of agent-B's credential creates a task as \"b\"", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");

		const taskId = await asServiceAccount(t).mutation(api.tasks.create, {
			title: "created by b",
			assignedTo: "b",
			priority: "medium",
			status: "todo",
			createdBy: "b",
			agentCredentialSecret: bCred,
		});
		expect(taskId).toBeTruthy();
	});

	test("DENY: HOLDER of agent-B's credential asserts createdBy \"c\" -> AGENT_IDENTITY_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		await mintAgent(t, "org-o", "c");

		await expect(
			asServiceAccount(t).mutation(api.tasks.create, {
				title: "forged as c",
				assignedTo: "c",
				priority: "medium",
				status: "todo",
				createdBy: "c",
				agentCredentialSecret: bCred,
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});

	test("DENY: HOLDER of agent-B's credential asserts callerOrchestrator \"c\" on update -> AGENT_IDENTITY_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		const cCred = await mintAgent(t, "org-o", "c");

		// c creates and owns its own task legitimately.
		const taskId = await asServiceAccount(t).mutation(api.tasks.create, {
			title: "c's own task",
			assignedTo: "c",
			priority: "medium",
			status: "todo",
			createdBy: "c",
			agentCredentialSecret: cCred,
		});

		// b's credential attempts to update it while ASSERTING to be "c" —
		// refused at the identity layer before task-ownership is even
		// consulted.
		await expect(
			asServiceAccount(t).mutation(api.tasks.update, {
				taskId,
				callerOrchestrator: "c",
				title: "forged update",
				agentCredentialSecret: bCred,
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});

	test("NO REGRESSION: tasks.create omitting agentCredentialSecret behaves exactly as before P-T5", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");

		const taskId = await asServiceAccount(t).mutation(api.tasks.create, {
			title: "legacy call, no credential",
			assignedTo: "b",
			priority: "medium",
			status: "todo",
			createdBy: "b",
		});
		expect(taskId).toBeTruthy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// [P-T5] gap closure — the create/update wiring above left seven other
// requireAuthenticatedCaller-gated mutations in convex/tasks.ts (plus
// attachReviewArtifact, which also writes a caller-asserted actor name to
// `reviewArtifactAttachedBy`) accepting a caller-asserted name with zero
// credential verification: complete, failTask, start, checkout, deleteTask,
// bulkComplete, blockTask, attachReviewArtifact. A partial lock is not a
// lock — this closes the gap with the identical both-pole property, under
// TWO distinct per-agent credentials (agent-B-cred, agent-C-cred), neither
// master nor creator.
//
// Each `describe` below seeds a task owned by "b" (created + started via
// legitimate b-cred calls where a precondition requires it), then exercises
// the mutation under test:
//   ALLOW — b-cred asserts name "b" -> accepted.
//   DENY  — b-cred asserts name "c" -> AGENT_IDENTITY_MISMATCH (refused at
//           the identity layer, before task-ownership/RBAC is even
//           consulted).
// ─────────────────────────────────────────────────────────────────────────────

async function seedOwnedTask(
	t: ReturnType<typeof createT>,
	bCred: string,
	opts?: { status?: "todo" },
): Promise<Id<"tasks">> {
	const taskId = await asServiceAccount(t).mutation(api.tasks.create, {
		title: opts?.status === "todo" ? "b's unclaimed task" : "b's task",
		assignedTo: "b",
		priority: "medium",
		status: "todo",
		createdBy: "b",
		agentCredentialSecret: bCred,
	});
	return taskId;
}

describe("[P-T5] gap closure — tasks.start", () => {
	test("ALLOW: agent-B-cred asserts name \"b\" -> accepted", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		const taskId = await seedOwnedTask(t, bCred);

		await expect(
			asServiceAccount(t).mutation(api.tasks.start, {
				taskId,
				callerOrchestrator: "b",
				agentCredentialSecret: bCred,
			}),
		).resolves.toBeNull();
	});

	test("DENY: agent-B-cred asserts name \"c\" -> AGENT_IDENTITY_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		await mintAgent(t, "org-o", "c");
		const taskId = await seedOwnedTask(t, bCred);

		await expect(
			asServiceAccount(t).mutation(api.tasks.start, {
				taskId,
				callerOrchestrator: "c",
				agentCredentialSecret: bCred,
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});
});

describe("[P-T5] gap closure — tasks.checkout", () => {
	test("ALLOW: agent-B-cred asserts name \"b\" -> accepted", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		const taskId = await seedOwnedTask(t, bCred, { status: "todo" });

		const result = await asServiceAccount(t).mutation(api.tasks.checkout, {
			taskId,
			callerOrchestrator: "b",
			agentCredentialSecret: bCred,
		});
		expect(result.claimed).toBe(true);
	});

	test("DENY: agent-B-cred asserts name \"c\" -> AGENT_IDENTITY_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		await mintAgent(t, "org-o", "c");
		const taskId = await seedOwnedTask(t, bCred, { status: "todo" });

		await expect(
			asServiceAccount(t).mutation(api.tasks.checkout, {
				taskId,
				callerOrchestrator: "c",
				agentCredentialSecret: bCred,
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});
});

describe("[P-T5] gap closure — tasks.complete", () => {
	test("ALLOW: agent-B-cred asserts name \"b\" -> accepted", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		const taskId = await seedOwnedTask(t, bCred);
		await asServiceAccount(t).mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "b",
			agentCredentialSecret: bCred,
		});

		await expect(
			asServiceAccount(t).mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "b",
				completionNote:
					"Completed via TDD proof for P-T5 gap closure, ratio 8/8 — see agentIdentityLock.test.ts",
				agentCredentialSecret: bCred,
			}),
		).resolves.toBeNull();
	});

	test("DENY: agent-B-cred asserts name \"c\" -> AGENT_IDENTITY_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		await mintAgent(t, "org-o", "c");
		const taskId = await seedOwnedTask(t, bCred);
		await asServiceAccount(t).mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "b",
			agentCredentialSecret: bCred,
		});

		await expect(
			asServiceAccount(t).mutation(api.tasks.complete, {
				taskId,
				callerOrchestrator: "c",
				completionNote: "forged completion as c",
				agentCredentialSecret: bCred,
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});
});

describe("[P-T5] gap closure — tasks.failTask", () => {
	test("ALLOW: agent-B-cred asserts name \"b\" -> accepted", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		const taskId = await seedOwnedTask(t, bCred);
		await asServiceAccount(t).mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "b",
			agentCredentialSecret: bCred,
		});

		await expect(
			asServiceAccount(t).mutation(api.tasks.failTask, {
				taskId,
				callerOrchestrator: "b",
				failureNote: "failed via TDD proof for P-T5 gap closure",
				agentCredentialSecret: bCred,
			}),
		).resolves.toBeNull();
	});

	test("DENY: agent-B-cred asserts name \"c\" -> AGENT_IDENTITY_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		await mintAgent(t, "org-o", "c");
		const taskId = await seedOwnedTask(t, bCred);
		await asServiceAccount(t).mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "b",
			agentCredentialSecret: bCred,
		});

		await expect(
			asServiceAccount(t).mutation(api.tasks.failTask, {
				taskId,
				callerOrchestrator: "c",
				failureNote: "forged failure as c",
				agentCredentialSecret: bCred,
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});
});

describe("[P-T5] gap closure — tasks.blockTask", () => {
	test("ALLOW: agent-B-cred asserts name \"b\" -> accepted", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		const taskId = await seedOwnedTask(t, bCred);
		await asServiceAccount(t).mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "b",
			agentCredentialSecret: bCred,
		});

		await expect(
			asServiceAccount(t).mutation(api.tasks.blockTask, {
				taskId,
				callerOrchestrator: "b",
				reason: "# blocked-on-nobody: waiting on third-party outage",
				agentCredentialSecret: bCred,
			}),
		).resolves.toBeNull();
	});

	test("DENY: agent-B-cred asserts name \"c\" -> AGENT_IDENTITY_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		await mintAgent(t, "org-o", "c");
		const taskId = await seedOwnedTask(t, bCred);
		await asServiceAccount(t).mutation(api.tasks.start, {
			taskId,
			callerOrchestrator: "b",
			agentCredentialSecret: bCred,
		});

		await expect(
			asServiceAccount(t).mutation(api.tasks.blockTask, {
				taskId,
				callerOrchestrator: "c",
				reason: "# blocked-on-nobody: forged block as c",
				agentCredentialSecret: bCred,
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});
});

describe("[P-T5] gap closure — tasks.deleteTask", () => {
	test("ALLOW: agent-B-cred asserts name \"b\" -> accepted", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		const taskId = await seedOwnedTask(t, bCred);

		const result = await asServiceAccount(t).mutation(api.tasks.deleteTask, {
			taskId,
			callerOrchestrator: "b",
			agentCredentialSecret: bCred,
		});
		expect(result.deleted).toBe(true);
	});

	test("DENY: agent-B-cred asserts name \"c\" -> AGENT_IDENTITY_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		await mintAgent(t, "org-o", "c");
		const taskId = await seedOwnedTask(t, bCred);

		await expect(
			asServiceAccount(t).mutation(api.tasks.deleteTask, {
				taskId,
				callerOrchestrator: "c",
				agentCredentialSecret: bCred,
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});
});

describe("[P-T5] gap closure — tasks.bulkComplete", () => {
	test("ALLOW: agent-B-cred asserts name \"b\" -> accepted (dry run)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		await seedOwnedTask(t, bCred);

		const result = await asServiceAccount(t).mutation(api.tasks.bulkComplete, {
			filter: { assignedTo: "b" },
			dryRun: true,
			callerOrchestrator: "b",
			agentCredentialSecret: bCred,
		});
		expect(result.count).toBeGreaterThanOrEqual(1);
	});

	test("DENY: agent-B-cred asserts name \"c\" -> AGENT_IDENTITY_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		await mintAgent(t, "org-o", "c");
		await seedOwnedTask(t, bCred);

		await expect(
			asServiceAccount(t).mutation(api.tasks.bulkComplete, {
				filter: { assignedTo: "b" },
				dryRun: true,
				callerOrchestrator: "c",
				agentCredentialSecret: bCred,
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});
});

describe("[P-T5] gap closure — tasks.attachReviewArtifact", () => {
	test("ALLOW: agent-B-cred asserts name \"b\" -> accepted", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		const taskId = await seedOwnedTask(t, bCred);

		await expect(
			asServiceAccount(t).mutation(api.tasks.attachReviewArtifact, {
				taskId,
				callerOrchestrator: "b",
				artifactRef: "https://github.com/vantageos-agency/vantage-peers/pull/9999",
				agentCredentialSecret: bCred,
			}),
		).resolves.toBeNull();
	});

	test("DENY: agent-B-cred asserts name \"c\" -> AGENT_IDENTITY_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const bCred = await mintAgent(t, "org-o", "b");
		await mintAgent(t, "org-o", "c");
		const taskId = await seedOwnedTask(t, bCred);

		await expect(
			asServiceAccount(t).mutation(api.tasks.attachReviewArtifact, {
				taskId,
				callerOrchestrator: "c",
				artifactRef: "https://github.com/vantageos-agency/vantage-peers/pull/8888",
				agentCredentialSecret: bCred,
			}),
		).rejects.toThrow(/AGENT_IDENTITY_MISMATCH/);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// [Pi ruling, task k1746tn3jy22k0jphbx48vzmvd8d0y50] ORG BIND — the lock
// resolves the presented credential to its ORGANISATION and refuses when
// that organisation is not the one the operation targets. Prior to this
// fix, `requireAgentCredentialMatch` enforced only the agent NAME: a
// SAME-NAMED agent credential minted in a DIFFERENT organisation passed
// the name check — org isolation rested solely on the surrounding
// `withOrgScope` scoping. Both callers below are scoped to a NON-master,
// NON-admin, non-creator identity (`user-org-o`/`user-org-p`, plain
// `organizationId` claim) so the property under test is the CREDENTIAL's
// own org binding, not an incidental master/admin bypass.
//
// DELETION PROBE (documented, run manually, not committed as a code
// change): removing the `if (targetOrgSlug !== null && resolved.orgSlug
// !== targetOrgSlug) throw ...` branch body from
// `requireAgentCredentialMatch` (convex/lib/auth.ts) makes the
// "DENY: foreign-org same-named credential" tests below go RED (a
// foreign-org "b" credential is ACCEPTED into org-o) — proving the tests
// measure the org-bind check, not something incidental. Restored
// afterward; ratio recorded in the dispatching brief's RETURN section.
// ─────────────────────────────────────────────────────────────────────────

function asOrgCaller(t: ReturnType<typeof createT>, org: string, subject: string) {
	return t.withIdentity({
		subject,
		organizationId: org,
	} as Parameters<typeof t.withIdentity>[0]);
}

describe("[Pi ORG BIND] sendMessage (from) \u2014 same name, foreign org", () => {
	test("DENY: agent-B-cred minted in FOREIGN org-p, asserted into org-o -> ORG_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		await seedOrgMapping(t, "org-p");
		await seedProfile(t, "b");
		await seedProfile(t, "recipient-role");
		const foreignBCred = await mintAgent(t, "org-p", "b");

		await expect(
			asOrgCaller(t, "org-o", "user-org-o").mutation(api.messages.sendMessage, {
				from: "b",
				channel: "recipient-role",
				content: "forged from a foreign org",
				agentCredentialSecret: foreignBCred,
			}),
		).rejects.toThrow(/ORG_MISMATCH/);
	});

	test("ALLOW: legitimate same-org agent-B-cred (org-o) into org-o -> accepted (positive control)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		await seedProfile(t, "b");
		await seedProfile(t, "recipient-role");
		const legitBCred = await mintAgent(t, "org-o", "b");

		const messageId = await asOrgCaller(t, "org-o", "user-org-o").mutation(
			api.messages.sendMessage,
			{
				from: "b",
				channel: "recipient-role",
				content: "legitimate same-org send",
				agentCredentialSecret: legitBCred,
			},
		);
		expect(messageId).toBeTruthy();
	});
});

describe("[Pi ORG BIND] tasks.create (createdBy) \u2014 same name, foreign org", () => {
	test("DENY: agent-B-cred minted in FOREIGN org-p, asserted into org-o -> ORG_MISMATCH", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		await seedOrgMapping(t, "org-p");
		const foreignBCred = await mintAgent(t, "org-p", "b");

		await expect(
			asOrgCaller(t, "org-o", "user-org-o").mutation(api.tasks.create, {
				title: "forged from a foreign org",
				assignedTo: "b",
				priority: "medium",
				status: "todo",
				createdBy: "b",
				agentCredentialSecret: foreignBCred,
			}),
		).rejects.toThrow(/ORG_MISMATCH/);
	});

	test("ALLOW: legitimate same-org agent-B-cred (org-o) into org-o -> accepted (positive control)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const legitBCred = await mintAgent(t, "org-o", "b");

		const taskId = await asOrgCaller(t, "org-o", "user-org-o").mutation(api.tasks.create, {
			title: "legitimate same-org create",
			assignedTo: "b",
			priority: "medium",
			status: "todo",
			createdBy: "b",
			agentCredentialSecret: legitBCred,
		});
		expect(taskId).toBeTruthy();
	});
});
