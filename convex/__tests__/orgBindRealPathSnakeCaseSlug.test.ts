/// <reference types="vite/client" />
/**
 * Real-path org-bind check (withOrgScope casing-class follow-up).
 *
 * Before the fix, `withOrgScope` (convex/lib/auth.ts) resolved `orgSlug`
 * from camelCase `organizationSlug ?? organizationId` ONLY. A Clerk-native
 * caller whose token carries snake_case `org_slug` therefore hit the
 * `!orgSlug` branch and was REFUSED (RBAC_DENIED) before ever reaching
 * `sendMessage`'s [P-T5] THE LOCK (`requireAgentCredentialMatch`,
 * `scope.orgSlug` as `targetOrgSlug`) — the org-bind assertion for such a
 * caller could previously only be exercised through a harness that
 * synthesized `scope.orgSlug` directly, bypassing `withOrgScope` entirely.
 *
 * This test exercises the REAL `sendMessage` mutation (no harness): a
 * snake_case-org_slug identity now resolves a real, populated
 * `scope.orgSlug` via the fixed `withOrgScope`, so `requireAgentCredentialMatch`
 * receives a real `targetOrgSlug` and refuses a same-named agent credential
 * minted in a DIFFERENT organisation with ORG_MISMATCH — proving the org
 * bind is now live end-to-end for this claim shape, not just unit-tested on
 * withOrgScope in isolation.
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

const orgAdminIdentity = (org: string) => ({
	subject: `admin-of-${org}`,
	org_slug: org,
	org_role: "org:admin",
});

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	clerkOrgSlug: string,
	allowedOrchestrators: string[] = ["b", "c"],
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug,
			allowedOrchestrators,
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

describe("REAL-PATH org-bind — snake_case org_slug caller, no harness", () => {
	test("DENY: snake_case-org caller presenting a same-named agent credential minted in a DIFFERENT org is refused ORG_MISMATCH via the REAL sendMessage path", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-home");
		await seedOrgMapping(t, "org-foreign");
		await seedProfile(t, "b");
		await seedProfile(t, "recipient-role");

		// Agent "b" minted in a DIFFERENT org than the caller's own.
		const foreignCred = await mintAgent(t, "org-foreign", "b");

		// Caller is a genuine Clerk-native member of org-home, carrying ONLY
		// snake_case org_slug — the exact shape withOrgScope previously
		// refused outright (RBAC_DENIED) before ever reaching the credential
		// check. No harness: this goes through the real sendMessage mutation.
		const tHomeMember = t.withIdentity({
			subject: "member-of-org-home",
			org_slug: "org-home",
		} as Parameters<typeof t.withIdentity>[0]);

		await expect(
			tHomeMember.mutation(api.messages.sendMessage, {
				from: "b",
				channel: "recipient-role",
				content: "cross-org credential attempt",
				agentCredentialSecret: foreignCred,
			}),
		).rejects.toThrow(/ORG_MISMATCH/);
	});

	test("ALLOW: snake_case-org caller presenting a same-org agent credential is accepted via the REAL sendMessage path", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-home");
		await seedProfile(t, "b");
		await seedProfile(t, "recipient-role");

		const homeCred = await mintAgent(t, "org-home", "b");

		const tHomeMember = t.withIdentity({
			subject: "member-of-org-home-2",
			org_slug: "org-home",
		} as Parameters<typeof t.withIdentity>[0]);

		const messageId = await tHomeMember.mutation(api.messages.sendMessage, {
			from: "b",
			channel: "recipient-role",
			content: "same-org credential, allowed",
			agentCredentialSecret: homeCred,
		});
		expect(messageId).toBeTruthy();
	});
});
