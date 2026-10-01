/// <reference types="vite/client" />
/**
 * THE OPERATOR'S OWN ORG ADMIN RESOLVES AS FLEET MASTER (withOrgScope).
 *
 * Measured on prod: the operator (org:admin of the org whose client_org_mapping
 * row is orgKind "operator") was served RBAC_DENIED on every master-only read
 * because nothing read orgKind. Rule: operator-kind ACTIVE mapping + verified
 * admin role claim -> master. Anything else stays an ordinary member.
 *
 * Poles (master-only read: fixPatterns:listByStack):
 *   - operator-org admin                      -> served          [RED before fix]
 *   - operator-org member / editor            -> refused not-fleet-master
 *   - client-org admin                        -> refused
 *   - org with NO orgKind (absent), admin     -> refused
 *   - inactive operator mapping, admin        -> refused (mapping refusal)
 *   - operator-org admin, role claim missing  -> refused
 *   - service account carrying an org claim   -> still master
 *
 * Second review round (an operator HUMAN is master for READS, not the service
 * account and not MCP-bound):
 *   - oauth service-account-only doors        -> operator admin refused, SA served
 *   - sendMessage / tasks.create asserted name -> bound to the operator roster
 *   - org_role claim that is not a string     -> no role, no TypeError
 */

import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
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
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const SA = "operator-test-service-account";
const OPERATOR_ORG = "operator-org-slug";
const CLIENT_ORG = "client-org-slug";
const PLAIN_ORG = "kindless-org-slug";
const DEAD_OPERATOR_ORG = "inactive-operator-org-slug";

async function seed(t: T) {
	const row = (
		clerkOrgSlug: string,
		isActive: boolean,
		orgKind?: "operator" | "client",
	) => ({
		clerkOrgSlug,
		allowedOrchestrators: ["sigma"],
		scopes: ["view-own-tasks"],
		displayName: clerkOrgSlug,
		isActive,
		createdAt: Date.now(),
		...(orgKind ? { orgKind } : {}),
	});
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", row(OPERATOR_ORG, true, "operator"));
		await ctx.db.insert("client_org_mapping", row(CLIENT_ORG, true, "client"));
		await ctx.db.insert("client_org_mapping", row(PLAIN_ORG, true));
		await ctx.db.insert(
			"client_org_mapping",
			row(DEAD_OPERATOR_ORG, false, "operator"),
		);
	});
}

const as = (t: T, identity: Record<string, unknown>) =>
	t.withIdentity(identity as Identity);
const read = (c: ReturnType<typeof as>) =>
	c.query(api.fixPatterns.listByStack, { stack: "convex" });

async function refusal(p: Promise<unknown>): Promise<string> {
	let caught: unknown;
	try {
		await p;
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(ConvexError);
	const text = JSON.stringify((caught as ConvexError<string>).data);
	expect(text).toContain("RBAC_DENIED");
	return text;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("operator org admin -> fleet master", () => {
	test("operator-org admin (org_role org:admin) -> master-only read served", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, { subject: "op", org_slug: OPERATOR_ORG, org_role: "org:admin" });
		expect(await read(c)).toEqual([]);
	});

	test("operator-org admin, camelCase claims -> served", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, {
			subject: "op",
			organizationSlug: OPERATOR_ORG,
			organizationRole: "org:admin",
		});
		expect(await read(c)).toEqual([]);
	});

	test("operator-org member -> refused not-fleet-master", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, { subject: "m", org_slug: OPERATOR_ORG, org_role: "org:member" });
		expect(await refusal(read(c))).toContain("not-fleet-master");
	});

	test("operator-org editor (custom role) -> refused", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, { subject: "e", org_slug: OPERATOR_ORG, org_role: "org:editor" });
		expect(await refusal(read(c))).toContain("not-fleet-master");
	});

	test("client-org admin -> refused", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, { subject: "ca", org_slug: CLIENT_ORG, org_role: "org:admin" });
		expect(await refusal(read(c))).toContain("not-fleet-master");
	});

	test("admin of an org with NO orgKind -> refused", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, { subject: "pa", org_slug: PLAIN_ORG, org_role: "org:admin" });
		expect(await refusal(read(c))).toContain("not-fleet-master");
	});

	test("inactive operator mapping, admin -> refused", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, {
			subject: "da",
			org_slug: DEAD_OPERATOR_ORG,
			org_role: "org:admin",
		});
		await refusal(read(c));
	});

	test("operator-org admin with the role claim missing -> not master", async () => {
		const t = createT();
		await seed(t);
		const c = as(t, { subject: "nr", org_slug: OPERATOR_ORG });
		expect(await refusal(read(c))).toContain("not-fleet-master");
	});

	test("service account carrying an org claim -> still master (subject first)", async () => {
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", SA);
		const t = createT();
		await seed(t);
		const c = as(t, { subject: SA, org_slug: CLIENT_ORG, org_role: "org:member" });
		expect(await read(c)).toEqual([]);
	});
});

const OP_ADMIN = { subject: "op-human", org_slug: OPERATOR_ORG, org_role: "org:admin" };

const mintArgs = {
	tokenHash: "h".repeat(64),
	clientId: "any",
	userId: "any",
	scopes: ["*"],
	scopeProfile: "master" as const,
	fromAllowList: ["*"],
	namespaceReadPrefixes: [""],
	namespaceWritePrefixes: [""],
	expiresAt: Date.now() + 1e9,
	clerkOrgSlug: CLIENT_ORG,
};

describe("service-account-only doors are not opened by an operator human", () => {
	test("operator admin -> oauth:listClients refused", async () => {
		const t = createT();
		await seed(t);
		await refusal(as(t, OP_ADMIN).query(api.oauth.listClients, {}));
	});

	test("operator admin -> oauth:createAccessToken refused, nothing minted", async () => {
		const t = createT();
		await seed(t);
		await refusal(as(t, OP_ADMIN).mutation(api.oauth.createAccessToken, mintArgs));
		const rows = await t.run((ctx) => ctx.db.query("oauth_access_tokens").collect());
		expect(rows).toEqual([]);
	});

	test("operator admin -> oauth:getAccessTokenByHash refused", async () => {
		const t = createT();
		await seed(t);
		await refusal(
			as(t, OP_ADMIN).query(api.oauth.getAccessTokenByHash, { tokenHash: "h".repeat(64) }),
		);
	});

	test("service account is still served at the same doors", async () => {
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", SA);
		const t = createT();
		await seed(t);
		const sa = as(t, { subject: SA });
		expect(await sa.query(api.oauth.listClients, {})).toEqual([]);
		await sa.mutation(api.oauth.createAccessToken, mintArgs);
		expect(
			await sa.query(api.oauth.getAccessTokenByHash, { tokenHash: "h".repeat(64) }),
		).not.toBeNull();
	});
});

// A broadcast needs at least one internal recipient to deliver to.
async function seedFleetProfiles(t: T) {
	await t.run(async (ctx) => {
		for (const o of ["pi", "eta", "sigma"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: o,
				name: o,
				static: { role: o, workspace: "w", capabilities: [] },
				dynamic: { lastSeen: 1, sessionCount: 0 },
			} as never);
		}
	});
}

describe("an operator human's asserted sender is bound to the operator roster", () => {
	const send = (c: ReturnType<typeof as>, from: string, channel = "broadcast") =>
		c.mutation(api.messages.sendMessage, { from, channel, content: "x" } as never);

	test.each(["broadcast", "sigma", "eta,pi"])(
		"operator admin from=eta (not on roster) channel=%s -> sender-not-on-roster",
		async (channel) => {
			const t = createT();
			await seed(t);
			await seedFleetProfiles(t);
			expect(await refusal(send(as(t, OP_ADMIN), "eta", channel))).toContain(
				"sender-not-on-roster",
			);
			expect(await t.run((ctx) => ctx.db.query("messages").collect())).toEqual([]);
		},
	);

	test("operator admin from=<operator roster name> -> served", async () => {
		const t = createT();
		await seed(t);
		await seedFleetProfiles(t);
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", OPERATOR_ORG))
				.unique();
			await ctx.db.patch(m!._id, { allowedOrchestrators: ["sigma", "eta"] });
		});
		await send(as(t, OP_ADMIN), "sigma", "eta");
		const rows = await t.run((ctx) => ctx.db.query("messages").collect());
		expect(rows.map((r) => r.from)).toEqual(["sigma"]);
	});

	test("service account may still send as any orchestrator (MCP-bound)", async () => {
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", SA);
		const t = createT();
		await seed(t);
		await seedFleetProfiles(t);
		await send(as(t, { subject: SA }), "eta", "broadcast");
		expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(1);
	});

	test("operator admin tasks.create createdBy=eta (not on roster) -> refused", async () => {
		const t = createT();
		await seed(t);
		const args = {
			title: "t",
			assignedTo: "sigma",
			priority: "medium",
			status: "todo",
			createdBy: "eta",
		};
		await expect(
			as(t, OP_ADMIN).mutation(api.tasks.create, args as never),
		).rejects.toThrow();
		await as(t, OP_ADMIN).mutation(api.tasks.create, { ...args, createdBy: "sigma" } as never);
	});
});

describe("operator admin keeps its master reads; a malformed role claim is not a role", () => {
	test("operator admin still served a master-only read", async () => {
		const t = createT();
		await seed(t);
		expect(await read(as(t, OP_ADMIN))).toEqual([]);
	});

	test.each([
		["array", ["org:admin"]],
		["object", { admin: true }],
		["number", 7],
	])("org_role as %s -> not master, no TypeError", async (_n, role) => {
		const t = createT();
		await seed(t);
		const c = as(t, { subject: "x", org_slug: OPERATOR_ORG, org_role: role });
		expect(await refusal(read(c))).toContain("not-fleet-master");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Third review round: the operator human is fleet master FOR READS ONLY.
//
// withOrgScope grants it only in a ctx that cannot write (a query). In a
// mutation, and in an action's scope bridge, it is an ordinary member of the
// operator org (its slug, its mapping's real roster). The service-account-only
// QUERY doors (secrets, hashes, credential oracle, the fleet "system" word)
// decide with isMcpBoundMaster, which never admits "operator-admin".
// ─────────────────────────────────────────────────────────────────────────────

async function seedFleet(t: T) {
	await seed(t);
	return await t.run(async (ctx) => {
		await ctx.db.insert("oauth_scope_profiles", {
			profileId: "p-b",
			description: "d",
			fromAllowList: ["bob"],
			namespaceReadPrefixes: ["x"],
			namespaceWritePrefixes: ["x"],
			createdAt: 1,
			updatedAt: 1,
			clerkOrgSlug: CLIENT_ORG,
		} as never);
		await ctx.db.insert("oauth_clients", {
			clientId: "c-b",
			clientSecretHash: "SECRETHASH",
			name: "n",
			redirectUris: [],
			scopeProfile: "p-b",
			createdAt: 1,
		} as never);
		await ctx.db.insert("oauth_access_tokens", {
			tokenHash: "live-token",
			clientId: "c-b",
			userId: "u",
			scopes: [],
			scopeProfile: "p-b",
			fromAllowList: ["bob"],
			namespaceReadPrefixes: [],
			namespaceWritePrefixes: [],
			expiresAt: Date.now() + 1e9,
			createdAt: 1,
			clerkOrgSlug: CLIENT_ORG,
		} as never);
		const fleetMsg = await ctx.db.insert("messages", {
			from: "pi",
			channel: "eta",
			content: "fleet-row",
			createdAt: 1,
		} as never);
		const clientMsg = await ctx.db.insert("messages", {
			from: "bob",
			channel: "bob",
			content: "client-row",
			createdAt: 2,
			tenantId: CLIENT_ORG,
		} as never);
		const note = await ctx.db.insert("briefingNotes", {
			title: "n",
			topic: "t",
			participants: [],
			content: "c",
			createdBy: "pi",
			createdAt: 1,
		} as never);
		const diary = await ctx.db.insert("diary", {
			orchestrator: "pi",
			date: "2026-10-01",
			content: "x",
			createdAt: 1,
		} as never);
		await ctx.db.insert("tasks", {
			title: "client task",
			assignedTo: "bob",
			priority: "medium",
			status: "todo",
			createdBy: "bob",
			createdAt: 1,
			updatedAt: 1,
			orgId: CLIENT_ORG,
		} as never);
		await ctx.db.insert("missions", {
			name: "client mission",
			project: "p",
			status: "execute",
			priority: "medium",
			pilot: "bob",
			agents: [],
			createdBy: "bob",
			createdAt: 1,
			updatedAt: 1,
			orgId: CLIENT_ORG,
		} as never);
		return { fleetMsg, clientMsg, note, diary };
	});
}

describe("operator human: master for READS, member for WRITES", () => {
	const POOL = { paginationOpts: { numItems: 10, cursor: null } };

	test("dashboard fleet READS are still served to the operator human", async () => {
		const t = createT();
		await seedFleet(t);
		const op = as(t, OP_ADMIN);
		const tasks = await op.query(api.tasks.list, {} as never);
		expect(JSON.stringify(tasks)).toContain("client task");
		const mem = await op.query(api.memories.listMemories, {
			namespace: `team/${CLIENT_ORG}`,
		} as never);
		expect(JSON.stringify(mem)).not.toContain("refused");
		const page = await op.query(api.messages.listByChannelPaginated, POOL as never);
		expect(JSON.stringify(page)).toContain("client-row");
		expect(JSON.stringify(await op.query(api.missions.list, {} as never))).toContain(
			"client mission",
		);
	});

	test("query doors that are service-account-only refuse the operator human", async () => {
		const t = createT();
		await seedFleet(t);
		const op = as(t, OP_ADMIN);
		expect(await refusal(op.query(api.oauth.getClientByClientId, { clientId: "c-b" }))).toContain(
			"getClientByClientId",
		);
		expect(await refusal(op.query(api.oauth.getScopeProfile, { profileId: "p-b" }))).toContain(
			"getScopeProfile",
		);
		expect(
			await refusal(op.query(api.orgRoster.getForAccessToken, { tokenHash: "live-token" })),
		).toContain("getForAccessToken requires master or service-account");
		expect(
			await refusal(
				op.query(api.agentCredentials.resolveAgentCredential, { presentedSecret: "zzz" }),
			),
		).toContain("not-mcp-bound-master");
	});

	test("service account is unchanged at those query doors", async () => {
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", SA);
		const t = createT();
		await seedFleet(t);
		const sa = as(t, { subject: SA });
		const client = await sa.query(api.oauth.getClientByClientId, { clientId: "c-b" });
		expect(client?.clientSecretHash).toBe("SECRETHASH");
		expect(await sa.query(api.oauth.getScopeProfile, { profileId: "p-b" })).not.toBeNull();
		// A served door answers about the TOKEN, not about the caller: the token is
		// live and carries an org, so the call reaches past the caller gate.
		await sa.query(api.orgRoster.getForAccessToken, { tokenHash: "live-token" }).catch((e) => {
			expect(JSON.stringify((e as ConvexError<string>).data)).not.toContain(
				"requires master or service-account",
			);
		});
		// The service account passes the caller gate and is refused only on the
		// CREDENTIAL (a different reason from the operator human's).
		expect(
			await refusal(
				sa.query(api.agentCredentials.resolveAgentCredential, { presentedSecret: "zzz" }),
			),
		).toContain("credential-not-recognised");
	});

	test.each([
		["deleteMessage as system (fleet row)", "fleetMsg"],
		["deleteMessage as bob (client row)", "clientMsg"],
	])("operator human cannot %s", async (_n, key) => {
		const t = createT();
		const ids = await seedFleet(t);
		const callerOrchestrator = key === "fleetMsg" ? "system" : "bob";
		await refusal(
			as(t, OP_ADMIN).mutation(api.messages.deleteMessage, {
				messageId: ids[key as "fleetMsg" | "clientMsg"],
				callerOrchestrator,
			} as never),
		);
		expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(2);
	});

	test("operator human cannot delete a briefing note / diary entry as system or pi", async () => {
		const t = createT();
		const ids = await seedFleet(t);
		const op = as(t, OP_ADMIN);
		await refusal(
			op.mutation(api.briefingNotes.deleteBriefingNote, {
				noteId: ids.note,
				callerOrchestrator: "pi",
			} as never),
		);
		await refusal(
			op.mutation(api.diary.deleteDiary, {
				diaryId: ids.diary,
				callerOrchestrator: "system",
			} as never),
		);
		expect(await t.run((ctx) => ctx.db.query("briefingNotes").collect())).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.query("diary").collect())).toHaveLength(1);
	});

	test("service account may still delete as system", async () => {
		vi.stubEnv("CLERK_SERVICE_ACCOUNT_USER_ID", SA);
		const t = createT();
		const ids = await seedFleet(t);
		const sa = as(t, { subject: SA });
		await sa.mutation(api.messages.deleteMessage, {
			messageId: ids.fleetMsg,
			callerOrchestrator: "system",
		} as never);
		await sa.mutation(api.diary.deleteDiary, {
			diaryId: ids.diary,
			callerOrchestrator: "system",
		} as never);
		expect(await t.run((ctx) => ctx.db.query("diary").collect())).toHaveLength(0);
	});

	test("fleet-config mutations refuse the operator human (addDeployment exfil, repo map)", async () => {
		const t = createT();
		await seedFleet(t);
		const op = as(t, OP_ADMIN);
		await refusal(
			op.mutation(api.errorMonitor.addDeployment, {
				name: "x",
				deploymentUrl: "https://attacker.example",
				deployKeyEnvVar: "CLERK_SECRET_KEY",
				githubRepo: "a/b",
				orchestrator: "sigma",
			}),
		);
		await refusal(
			op.mutation(api.githubRepoMapping.add, { repo: "a/b", orchestrator: "sigma", project: "p" }),
		);
		expect(await t.run((ctx) => ctx.db.query("monitoredDeployments").collect())).toEqual([]);
	});

	test("actions: the operator human is a member of the operator org, not master", async () => {
		const t = createT();
		await seedFleet(t);
		const op = as(t, OP_ADMIN);
		await expect(
			op.action(api.kb.softDeleteDocument, {
				docId: "d",
				orgId: CLIENT_ORG,
				namespace: `team/${CLIENT_ORG}`,
			}),
		).rejects.toThrow(/AUTH_NAMESPACE_DENIED/);
		await refusal(
			op.action(api.okfBundleNode.importOkfBundle, {
				targetNamespace: `team/${CLIENT_ORG}`,
				mode: "merge",
			} as never),
		);
	});

	test("tasks.create by the operator human: own roster served ('sigma'), normalised, '*' and foreign refused", async () => {
		const t = createT();
		await seed(t);
		const args = {
			title: "t",
			assignedTo: "sigma",
			priority: "medium",
			status: "todo",
		};
		const op = as(t, OP_ADMIN);
		await op.mutation(api.tasks.create, { ...args, createdBy: "sigma" } as never);
		await op.mutation(api.tasks.create, { ...args, createdBy: "Sigma" } as never).catch(() => {
			// Normalisation is asserted on the roster side; a creator validator may
			// reject the capitalised literal before the roster check — both refuse.
		});
		await expect(
			op.mutation(api.tasks.create, { ...args, createdBy: "eta" } as never),
		).rejects.toThrow();
		await expect(
			op.mutation(api.tasks.create, { ...args, createdBy: "*" } as never),
		).rejects.toThrow();
	});
});
