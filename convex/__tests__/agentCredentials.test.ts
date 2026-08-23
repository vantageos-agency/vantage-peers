/// <reference types="vite/client" />
/**
 * [P-T4] convex/agentCredentials.ts — the per-agent CREDENTIAL, on top of
 * P-T2's `agents` entity and P-T3's `agent_relations` edge. Task
 * le-cap.md @ e3c1ffd6 §6 VP.4 (first half): today the token identifies the
 * ORGANISATION and the agent writes its own name into the call, so agents of
 * one client share a token and nothing compares the declared name to the
 * token presented. This file mints that missing per-agent key.
 *
 * THE PROPERTY (both poles):
 *   ALLOW — mint for agent A1 in org O; presenting the returned plaintext
 *   resolves to (O, A1).
 *   DENY (direction 1) — a wrong/garbage secret does NOT authenticate.
 *   DENY (direction 2) — after a rotation (second mint) the OLD plaintext no
 *   longer authenticates; only the NEW plaintext does.
 *   PER-AGENT not per-org — two agents in the same org get DISTINCT secrets;
 *   A1's secret does not resolve to A2.
 *
 * Identities (both named per measurement): mint runs under the org:admin
 * (creator, `admin-of-org-o`); the AUTHENTICATION measurement is made by the
 * credential HOLDER (the agent, e.g. `a1`) — neither master nor the creator.
 *
 * DELETION PROBE (documented, not committed as a code change): removing the
 * `if (!row || !row.isActive) return null;` guard's `!row.isActive` half (or
 * hard-coding `resolveAgentCredential` to always return the matched row) in
 * `resolveAgentCredential`'s handler makes the "DENY (direction 2): rotation
 * invalidates the OLD plaintext" test below go RED (old secret resolves
 * instead of returning null) — proving that DENY test binds to the
 * `isActive` check, not something else. Run manually via a single-line edit
 * + `npm test -- agentCredentials` from the worktree root, then restored.
 * Ratio recorded in the dispatching brief's RETURN section.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);

async function seedOrgMapping(
	t: ReturnType<typeof createT>,
	clerkOrgSlug: string,
	allowedOrchestrators: string[] = ["existing-seat"],
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

// Identities named per measurement — none is master, none is the row's
// creator where that matters.
const orgAdminIdentity = (org: string) => ({
	subject: `admin-of-${org}`,
	org_slug: org,
	org_role: "org:admin",
});

const orgMemberIdentity = (org: string) => ({
	subject: `member-of-${org}`,
	org_slug: org,
	org_role: "org:member",
});

describe("[P-T4] agentCredentials — per-agent secret, hashed at rest", () => {
	test("POLE ALLOW: org:admin of O mints a credential for A1; presenting the returned plaintext resolves to (O, A1)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const tAdminO = t.withIdentity(
			orgAdminIdentity("org-o") as Parameters<typeof t.withIdentity>[0],
		);

		await tAdminO.mutation(api.agents.registerAgent, {
			orgSlug: "org-o",
			name: "a1",
		});

		const minted = await tAdminO.mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: "org-o", agentName: "a1" },
		);
		expect(typeof minted.secret).toBe("string");
		expect(minted.secret.length).toBe(64); // 32 bytes -> 64 hex chars

		// The AUTHENTICATION measurement is made by the credential HOLDER (the
		// agent itself), an anonymous caller presenting only the secret — not
		// the org:admin who minted it.
		const resolved = await t.query(api.agentCredentials.resolveAgentCredential, {
			presentedSecret: minted.secret,
		});
		expect(resolved).toEqual({ orgSlug: "org-o", agentName: "a1" });
	});

	test("stored row carries a hash distinct from the plaintext — no plaintext at rest", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const tAdminO = t.withIdentity(
			orgAdminIdentity("org-o") as Parameters<typeof t.withIdentity>[0],
		);
		await tAdminO.mutation(api.agents.registerAgent, {
			orgSlug: "org-o",
			name: "a1",
		});
		const minted = await tAdminO.mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: "org-o", agentName: "a1" },
		);

		const rows = await t.run(async (ctx) => {
			return await ctx.db
				.query("agent_credentials")
				.withIndex("by_org_agent", (q) =>
					q.eq("orgSlug", "org-o").eq("agentName", "a1"),
				)
				.collect();
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].secretHash).not.toBe(minted.secret);
		expect(rows[0].secretHash.length).toBe(64); // sha256 hex
		expect(rows[0].isActive).toBe(true);
	});

	test("DENY (direction 1): a wrong/garbage secret does not authenticate", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const tAdminO = t.withIdentity(
			orgAdminIdentity("org-o") as Parameters<typeof t.withIdentity>[0],
		);
		await tAdminO.mutation(api.agents.registerAgent, {
			orgSlug: "org-o",
			name: "a1",
		});
		await tAdminO.mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-o",
			agentName: "a1",
		});

		const resolved = await t.query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: "0000garbage0000not-a-real-secret0000" },
		);
		expect(resolved).toBeNull();
	});

	test("DENY (direction 2): after rotation (second mint) the OLD plaintext no longer authenticates; only the NEW one does", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const tAdminO = t.withIdentity(
			orgAdminIdentity("org-o") as Parameters<typeof t.withIdentity>[0],
		);
		await tAdminO.mutation(api.agents.registerAgent, {
			orgSlug: "org-o",
			name: "a1",
		});

		const first = await tAdminO.mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: "org-o", agentName: "a1" },
		);

		// Positive control BEFORE rotation: the first secret authenticates.
		const resolvedFirstBefore = await t.query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: first.secret },
		);
		expect(resolvedFirstBefore).toEqual({ orgSlug: "org-o", agentName: "a1" });

		const second = await tAdminO.mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: "org-o", agentName: "a1" },
		);
		expect(second.secret).not.toBe(first.secret);

		// OLD plaintext: refused after rotation.
		const resolvedFirstAfter = await t.query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: first.secret },
		);
		expect(resolvedFirstAfter).toBeNull();

		// NEW plaintext: authenticates.
		const resolvedSecond = await t.query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: second.secret },
		);
		expect(resolvedSecond).toEqual({ orgSlug: "org-o", agentName: "a1" });

		// Rotation preserves the audit trail — the old row still exists,
		// just inactive.
		const rows = await t.run(async (ctx) => {
			return await ctx.db
				.query("agent_credentials")
				.withIndex("by_org_agent", (q) =>
					q.eq("orgSlug", "org-o").eq("agentName", "a1"),
				)
				.collect();
		});
		expect(rows).toHaveLength(2);
		expect(rows.filter((r) => r.isActive)).toHaveLength(1);
	});

	test("PER-AGENT not per-org: two agents in the same org get DISTINCT secrets; A1's secret does not resolve to A2", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const tAdminO = t.withIdentity(
			orgAdminIdentity("org-o") as Parameters<typeof t.withIdentity>[0],
		);
		await tAdminO.mutation(api.agents.registerAgent, {
			orgSlug: "org-o",
			name: "a1",
		});
		await tAdminO.mutation(api.agents.registerAgent, {
			orgSlug: "org-o",
			name: "a2",
		});

		const mintedA1 = await tAdminO.mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: "org-o", agentName: "a1" },
		);
		const mintedA2 = await tAdminO.mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: "org-o", agentName: "a2" },
		);

		expect(mintedA1.secret).not.toBe(mintedA2.secret);

		const resolvedA1 = await t.query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: mintedA1.secret },
		);
		expect(resolvedA1).toEqual({ orgSlug: "org-o", agentName: "a1" });

		// A1's secret must never resolve to A2's identity, nor authenticate as
		// A2 under any interpretation.
		expect(resolvedA1?.agentName).not.toBe("a2");

		const resolvedA2 = await t.query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: mintedA2.secret },
		);
		expect(resolvedA2).toEqual({ orgSlug: "org-o", agentName: "a2" });

		// Rotating A1 must not disturb A2's still-active credential.
		await tAdminO.mutation(api.agentCredentials.mintAgentCredential, {
			orgSlug: "org-o",
			agentName: "a1",
		});
		const resolvedA2StillGood = await t.query(
			api.agentCredentials.resolveAgentCredential,
			{ presentedSecret: mintedA2.secret },
		);
		expect(resolvedA2StillGood).toEqual({ orgSlug: "org-o", agentName: "a2" });
	});

	test("POLE DENY: non-admin member of O is refused mintAgentCredential (RBAC_DENIED)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const tAdminO = t.withIdentity(
			orgAdminIdentity("org-o") as Parameters<typeof t.withIdentity>[0],
		);
		await tAdminO.mutation(api.agents.registerAgent, {
			orgSlug: "org-o",
			name: "a1",
		});

		const tMemberO = t.withIdentity(
			orgMemberIdentity("org-o") as Parameters<typeof t.withIdentity>[0],
		);
		await expect(
			tMemberO.mutation(api.agentCredentials.mintAgentCredential, {
				orgSlug: "org-o",
				agentName: "a1",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		const rows = await t.run(async (ctx) => {
			return await ctx.db
				.query("agent_credentials")
				.withIndex("by_org_agent", (q) =>
					q.eq("orgSlug", "org-o").eq("agentName", "a1"),
				)
				.collect();
		});
		expect(rows).toHaveLength(0);
	});

	test("mintAgentCredential refuses an agentName with no `agents` row in this org (AGENT_NOT_FOUND)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const tAdminO = t.withIdentity(
			orgAdminIdentity("org-o") as Parameters<typeof t.withIdentity>[0],
		);

		await expect(
			tAdminO.mutation(api.agentCredentials.mintAgentCredential, {
				orgSlug: "org-o",
				agentName: "ghost-agent",
			}),
		).rejects.toThrow(/AGENT_NOT_FOUND/);
	});
});
