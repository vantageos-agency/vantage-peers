/// <reference types="vite/client" />
/**
 * convex/__tests__/messagesActingPrincipalById.test.ts
 *
 * Backend standard R-53, messages lane (task k174d95s5qqy8t2r5rdrz3pr3d8fqv82,
 * step 4b). An acting agent forwarded BY ID (`verifiedActor`) on
 * `messages:sendMessage` is resolved through @vantageos/cloud-identity
 * (`resolveActingPrincipal`), and every organisation the call names is checked
 * against the principal's stored org ID (`assertTargetBelongsTo`). Two orgs
 * register agents under the SAME names; a name never selects or authorises.
 *
 * Poles, per shared name:
 *   REFUSED  another org's same-named agent acting into this org (seat org,
 *            declared tenant, or a lying verifiedActor org);
 *   CONFINED another org's agent with no org named reaches its OWN org only;
 *   PRESENT  this org's agent is served, stamped with this org;
 *   HUMAN    a member sending in its own name stays in its own org.
 */

import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { describe, expect, test } from "vitest";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const NAMES = ["clio", "victor", "hélios", "eta"] as const;
const ORGS = ["iris-rh", "other-hr"] as const;
type Org = (typeof ORGS)[number];

const asServiceAccount = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" });
const asMember = (t: T, org: Org, subject: string) =>
	t.withIdentity({
		subject,
		organizationSlug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:editor",
	} as Parameters<T["withIdentity"]>[0]);

async function seedWorld(): Promise<{
	t: T;
	ids: Record<string, Id<"agents">>;
}> {
	const t = createT();
	const ids: Record<string, Id<"agents">> = {};
	await t.run(async (ctx) => {
		const now = Date.now();
		for (const org of ORGS) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				allowedOrchestrators: [...NAMES],
				scopes: ["view-own-tasks"],
				displayName: org,
				isActive: true,
				createdAt: now,
			});
			for (const name of NAMES) {
				ids[`${org}/${name}`] = await ctx.db.insert("agents", {
					orgSlug: org,
					clerkOrgId: testClerkOrgId(org),
					name,
					normalizedName: normalizeOrchestratorId(name),
					isActive: true,
					createdAt: now,
				});
			}
		}
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
		for (const name of NAMES) {
			await ctx.db.insert("profiles", {
				orchestratorId: name,
				name,
				static: { role: name, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: now, sessionCount: 1 },
			});
		}
	});
	return { t, ids };
}

const peerOf = (name: string) => NAMES.find((n) => n !== name) ?? "clio";

async function tenantsOf(t: T, messageId: Id<"messages">) {
	return await t.run(async (ctx) => {
		const message = await ctx.db.get(messageId);
		const receipts = await ctx.db
			.query("messageReceipts")
			.withIndex("by_message", (q) => q.eq("messageId", messageId))
			.collect();
		return {
			message: message?.tenantId ?? null,
			receipts: receipts.map((r) => r.tenantId ?? null),
		};
	});
}

// ── the live case (copied from sigma/connector-agent-identity) ──────────────

describe("connector agent credential", () => {
	test("another org's clio cannot act as the iris-rh clio: ORG_MISMATCH", async () => {
		const { t, ids } = await seedWorld();
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "clio",
				channel: "hélios",
				content: "x",
				seatOrgSlug: "iris-rh",
				verifiedActor: {
					agentId: ids["other-hr/clio"],
					orgSlug: "other-hr",
				},
			}),
		).rejects.toThrow(/ORG_MISMATCH.*target-other-organisation/);
		const delivered = await t.run(
			async (ctx) => (await ctx.db.query("messages").collect()).length,
		);
		expect(delivered).toBe(0);
	});
});

// ── the table over shared names ─────────────────────────────────────────────

describe.each(
	NAMES,
)("shared name %s — sendMessage by verifiedActor", (name) => {
	const peer = peerOf(name);

	test("REFUSED: other-hr's agent with the iris-rh seat org", async () => {
		const { t, ids } = await seedWorld();
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: name,
				channel: peer,
				content: "x",
				seatOrgSlug: "iris-rh",
				verifiedActor: {
					agentId: ids[`other-hr/${name}`],
					orgSlug: "other-hr",
				},
			}),
		).rejects.toThrow(/ORG_MISMATCH.*target-other-organisation/);
	});

	test("REFUSED: other-hr's agent declaring tenantId iris-rh", async () => {
		const { t, ids } = await seedWorld();
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: name,
				channel: peer,
				content: "x",
				tenantId: "iris-rh",
				verifiedActor: {
					agentId: ids[`other-hr/${name}`],
					orgSlug: "other-hr",
				},
			}),
		).rejects.toThrow(/ORG_MISMATCH.*target-other-organisation/);
	});

	test("REFUSED: other-hr's agent presented as verified in iris-rh", async () => {
		const { t, ids } = await seedWorld();
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: name,
				channel: peer,
				content: "x",
				seatOrgSlug: "iris-rh",
				verifiedActor: { agentId: ids[`other-hr/${name}`], orgSlug: "iris-rh" },
			}),
		).rejects.toThrow(/ORG_MISMATCH.*"other-organisation"/);
	});

	test("CONFINED: other-hr's agent naming no org reaches other-hr only", async () => {
		const { t, ids } = await seedWorld();
		const id = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: name,
			channel: peer,
			content: "x",
			verifiedActor: { agentId: ids[`other-hr/${name}`], orgSlug: "other-hr" },
		});
		const tenants = await tenantsOf(t, id);
		expect(tenants.message).toBe("other-hr");
		expect(tenants.receipts).toEqual(["other-hr"]);
	});

	test("PRESENT: iris-rh's agent with the iris-rh seat org is served", async () => {
		const { t, ids } = await seedWorld();
		const id = await asServiceAccount(t).mutation(api.messages.sendMessage, {
			from: name,
			channel: peer,
			content: "x",
			seatOrgSlug: "iris-rh",
			verifiedActor: { agentId: ids[`iris-rh/${name}`], orgSlug: "iris-rh" },
		});
		const tenants = await tenantsOf(t, id);
		expect(tenants.message).toBe("iris-rh");
		expect(tenants.receipts).toEqual(["iris-rh"]);
	});

	test("HUMAN: an other-hr member addressing the name stays in other-hr", async () => {
		const { t } = await seedWorld();
		const id = await asMember(t, "other-hr", "user_other").mutation(
			api.messages.sendMessage,
			{ channel: name, content: "x" },
		);
		const tenants = await tenantsOf(t, id);
		expect(tenants.message).toBe("other-hr");
		expect(tenants.receipts).toEqual(["other-hr"]);
	});
});

// ── refusal by default ──────────────────────────────────────────────────────

describe("verifiedActor resolution refuses by default", () => {
	test("an inactive agent is refused (VERIFIED_ACTOR_INACTIVE)", async () => {
		const { t, ids } = await seedWorld();
		await t.run(async (ctx) => {
			await ctx.db.patch(ids["iris-rh/clio"], { isActive: false });
		});
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "clio",
				channel: "eta",
				content: "x",
				seatOrgSlug: "iris-rh",
				verifiedActor: { agentId: ids["iris-rh/clio"], orgSlug: "iris-rh" },
			}),
		).rejects.toThrow(/VERIFIED_ACTOR_INACTIVE.*principal-inactive/);
	});

	test("an agent of an inactive organisation is refused (organisation-not-active)", async () => {
		const { t, ids } = await seedWorld();
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "other-hr"))
				.first();
			if (m) await ctx.db.patch(m._id, { isActive: false });
		});
		await expect(
			asServiceAccount(t).mutation(api.messages.sendMessage, {
				from: "clio",
				channel: "eta",
				content: "x",
				verifiedActor: { agentId: ids["other-hr/clio"], orgSlug: "other-hr" },
			}),
		).rejects.toThrow(/RBAC_DENIED.*organisation-not-active/);
	});

	test("an org member presenting a verifiedActor is refused (verified-actor-not-trusted)", async () => {
		const { t, ids } = await seedWorld();
		await expect(
			asMember(t, "iris-rh", "user_iris").mutation(api.messages.sendMessage, {
				from: "clio",
				channel: "eta",
				content: "x",
				verifiedActor: { agentId: ids["iris-rh/clio"], orgSlug: "iris-rh" },
			}),
		).rejects.toThrow(/RBAC_DENIED.*verified-actor-not-trusted/);
	});
});
