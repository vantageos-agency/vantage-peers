/// <reference types="vite/client" />
/**
 * resolveAgentCredentialCore — a credential is only as live as its AGENT.
 *
 * task k173ny6as0gsq996xtbtzn5rjd8fbj9m (VantagePeers Cloud). The MCP boundary
 * now resolves the acting agent from this core. Before this change the core
 * checked only `agent_credentials.isActive`, which nothing flips when the
 * AGENT is switched off (`agents.isActive === false`) or removed: a
 * deactivated agent kept authenticating through a credential row that still
 * read active. An inactive agent must be a DENY.
 *
 * Identity: the credential HOLDER — an ordinary agent of a real org, presenting
 * only its secret. Neither the service account nor master is used at any pole;
 * the mint runs under that org's own org:admin.
 *
 * POLES:
 *   ALLOW — an active agent's active credential resolves to (org, agent).
 *   DENY  — the SAME credential is refused once the agent is inactive.
 *   DENY  — ... or once the agent row no longer exists.
 *   ISOLATION — a same-named agent in ANOTHER org keeps resolving to its own
 *   org: deactivating one does not deactivate the other.
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

const orgAdminIdentity = (org: string) => ({
	subject: `admin-of-${org}`,
	org_slug: org,
	org_role: "org:admin",
});

async function seedOrgMapping(t: ReturnType<typeof createT>, org: string) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: org,
			allowedOrchestrators: ["alice"],
			scopes: ["view-own-tasks"],
			displayName: org,
			isActive: true,
			createdAt: Date.now(),
		});
	});
}

async function mintAgent(
	t: ReturnType<typeof createT>,
	org: string,
	name: string,
): Promise<string> {
	const admin = t.withIdentity(
		orgAdminIdentity(org) as Parameters<typeof t.withIdentity>[0],
	);
	await admin.mutation(api.agents.registerAgent, { orgSlug: org, name });
	const minted = await admin.mutation(
		api.agentCredentials.mintAgentCredential,
		{
			orgSlug: org,
			agentName: name,
		},
	);
	return minted.secret;
}

async function setAgentActive(
	t: ReturnType<typeof createT>,
	org: string,
	name: string,
	isActive: boolean,
) {
	await t.run(async (ctx) => {
		const row = await ctx.db
			.query("agents")
			.withIndex("by_org_name", (q) => q.eq("orgSlug", org).eq("name", name))
			.unique();
		if (!row) throw new Error(`fixture: no agent ${org}/${name}`);
		await ctx.db.patch(row._id, { isActive });
	});
}

describe("resolveAgentCredential — an inactive agent is a DENY", () => {
	test("ALLOW: an active agent's active credential resolves to its (org, agent)", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const secret = await mintAgent(t, "org-o", "alice");
		const resolved = await t.query(
			api.agentCredentials.resolveAgentCredential,
			{
				presentedSecret: secret,
			},
		);
		expect(resolved).toEqual({ orgSlug: "org-o", agentName: "alice" });
	});

	test("DENY: the SAME credential is refused once the agent is inactive", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const secret = await mintAgent(t, "org-o", "alice");
		await setAgentActive(t, "org-o", "alice", false);
		await expect(
			t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secret,
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*credential-not-recognised/);
	});

	test("DENY: the credential is refused once the agent row no longer exists", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		const secret = await mintAgent(t, "org-o", "alice");
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("agents")
				.withIndex("by_org_name", (q) =>
					q.eq("orgSlug", "org-o").eq("name", "alice"),
				)
				.unique();
			if (row) await ctx.db.delete(row._id);
		});
		await expect(
			t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secret,
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*credential-not-recognised/);
	});

	test("ISOLATION: deactivating org-o's alice does not touch org-p's alice, which still resolves to org-p", async () => {
		const t = createT();
		await seedOrgMapping(t, "org-o");
		await seedOrgMapping(t, "org-p");
		const secretO = await mintAgent(t, "org-o", "alice");
		const secretP = await mintAgent(t, "org-p", "alice");
		await setAgentActive(t, "org-o", "alice", false);
		await expect(
			t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secretO,
			}),
		).rejects.toThrow(/RBAC_DENIED[\s\S]*credential-not-recognised/);
		expect(
			await t.query(api.agentCredentials.resolveAgentCredential, {
				presentedSecret: secretP,
			}),
		).toEqual({ orgSlug: "org-p", agentName: "alice" });
	});
});
