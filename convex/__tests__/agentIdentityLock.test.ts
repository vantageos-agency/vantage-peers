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
