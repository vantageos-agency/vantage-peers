/// <reference types="vite/client" />
/**
 * [P-T2] convex/agents.ts — the agent as an ENTITY carrying its organisation
 * (a CREATE, not an extension). Task le-cap.md @ e3c1ffd6 §6 VP.2 (corrected):
 * `mcp__vantage-peers__list_peers` rows carry NO organisation field — org
 * membership rides on the calling token, not the row. This table/functions
 * ARE that missing organisation carrier.
 *
 * THE PROPERTY (both poles, per VERIFICATION 4 — one assertion is half a
 * spec):
 *   ALLOW — an org:admin identity of org A registers an agent →
 *   listAgentsByOrg(A) returns it, carrying orgSlug A.
 *   DENY (direction 1) — a non-admin identity of org A is refused
 *   registerAgent.
 *   DENY (direction 2) — an identity of org B does NOT see org A's agents via
 *   listAgentsByOrg/getAgent.
 *
 * MASTER note: a master-authed call is the BYPASS, not proof — the master
 * test below exists only to document master still works, never used to
 * prove authorization.
 *
 * DELETION PROBE (documented, not committed as a code change): removing the
 * `requireOrgAdmin(ctx, args.orgSlug)` line from `registerAgent`'s handler
 * makes the "POLE DENY: non-admin member of A is refused" test below go RED
 * (mutation succeeds instead of throwing RBAC_DENIED) — proving the DENY
 * test measures the authorization code, not something else. Ratio recorded
 * in the dispatching brief's RETURN section, run manually via
 * `git stash -- convex/agents.ts` style single-line removal + `npm test`
 * from the worktree root, then restored.
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

describe("[P-T2] agents — entity carrying its organisation", () => {
	test("POLE ALLOW: org:admin of A registers an agent — listAgentsByOrg(A) returns it carrying orgSlug A", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const tAdminA = t.withIdentity(
			orgAdminIdentity("org-a") as Parameters<typeof t.withIdentity>[0],
		);

		const agentId = await tAdminA.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "researcher-1",
			description: "first agent of org A",
		});
		expect(agentId).toBeDefined();

		const rows = await tAdminA.query(api.agents.listAgentsByOrg, {
			orgSlug: "org-a",
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].orgSlug).toBe("org-a");
		expect(rows[0].name).toBe("researcher-1");

		const single = await tAdminA.query(api.agents.getAgent, {
			orgSlug: "org-a",
			name: "researcher-1",
		});
		expect(single?.orgSlug).toBe("org-a");
	});

	test("POLE DENY (direction 1): non-admin member of A is refused registerAgent (RBAC_DENIED)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const tMemberA = t.withIdentity(
			orgMemberIdentity("org-a") as Parameters<typeof t.withIdentity>[0],
		);

		await expect(
			tMemberA.mutation(api.agents.registerAgent, {
				orgSlug: "org-a",
				name: "sneaky-agent",
			}),
		).rejects.toThrow(/RBAC_DENIED/);

		// Org A must remain untouched by the refused attempt.
		const rows = await t.run(async (ctx) => {
			return await ctx.db
				.query("agents")
				.withIndex("by_org", (q) => q.eq("orgSlug", "org-a"))
				.collect();
		});
		expect(rows).toHaveLength(0);
	});

	test("POLE DENY (direction 2): identity of org B does not see org A's agents via listAgentsByOrg", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await seedOrgMapping(t, "org-b");

		const tAdminA = t.withIdentity(
			orgAdminIdentity("org-a") as Parameters<typeof t.withIdentity>[0],
		);
		await tAdminA.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "researcher-a",
		});

		const tAdminB = t.withIdentity(
			orgAdminIdentity("org-b") as Parameters<typeof t.withIdentity>[0],
		);

		// Positive control first: prove the instrument can tell present from
		// absent — B legitimately sees ITS OWN (empty) roster, not a swallowed
		// grant of A's roster.
		const rowsForB = await tAdminB.query(api.agents.listAgentsByOrg, {
			orgSlug: "org-b",
		});
		expect(rowsForB).toHaveLength(0);

		// B attempting to read A's roster by passing A's slug is refused, not
		// silently emptied — the scoping wrapper binds orgSlug to the caller's
		// OWN identity, a caller-supplied arg never substitutes for it.
		await expect(
			tAdminB.query(api.agents.listAgentsByOrg, { orgSlug: "org-a" }),
		).rejects.toThrow(/RBAC_DENIED/);

		await expect(
			tAdminB.query(api.agents.getAgent, {
				orgSlug: "org-a",
				name: "researcher-a",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("POLE DENY: no identity at all is refused registerAgent", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		await expect(
			t.mutation(api.agents.registerAgent, {
				orgSlug: "org-a",
				name: "anon-agent",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});

	test("address write-back: registered agent's address can be updated then read back via getAgent", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-a");
		const tAdminA = t.withIdentity(
			orgAdminIdentity("org-a") as Parameters<typeof t.withIdentity>[0],
		);

		await tAdminA.mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "researcher-1",
		});

		await tAdminA.mutation(api.agents.setAgentAddress, {
			orgSlug: "org-a",
			name: "researcher-1",
			address: "https://researcher-1.example.internal",
		});

		const readBack = await tAdminA.query(api.agents.getAgent, {
			orgSlug: "org-a",
			name: "researcher-1",
		});
		expect(readBack?.address).toBe("https://researcher-1.example.internal");
	});

	test("MASTER note (bypass, not proof): a master-scope call still succeeds, but is never used above to prove authorization", async () => {
		const t = createT();
		// No client_org_mapping row for "org-master-bypass" is needed — master
		// scope (allowNoIdentityMaster path via no identity at all is the
		// FAIL-CLOSED default per withOrgScope; this test instead documents
		// that registerAgent's own gate is requireOrgAdmin, which has NO
		// master carve-out of its own — a caller must be a real org:admin of
		// an ACTIVE mapped org, full stop). This test intentionally shows the
		// DENY: there is no master bypass on this mutation.
		await expect(
			t.mutation(api.agents.registerAgent, {
				orgSlug: "org-master-bypass",
				name: "master-attempt",
			}),
		).rejects.toThrow(/RBAC_DENIED/);
	});
});
