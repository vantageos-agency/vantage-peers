/// <reference types="vite/client" />
/**
 * verifiedPerson — the bridge that lets a PERSON reached through the MCP
 * service account act on the dashboard's human doors in its own name
 * (convex/lib/personPrincipal.ts; task k176ch9tamzab3dnhye94kga1d8fkbhm).
 *
 * The carried proof is ONLY the hash of the bearer the person presented. The
 * door believes it from the service account alone and re-reads subject, org
 * and role from the token row; the unchanged human path (resolveHumanActor)
 * then decides. These poles are on the Convex door itself, below the MCP
 * layer, so each holds even if the MCP gate in front of it were skipped.
 *
 * POLES
 *   SERVED      service account + live person token (editor) -> actor user:<sub>, own org
 *   ROLE        the same with a viewer token -> role-not-writer (the Convex gate, not the MCP one);
 *               cancelling needs org:admin (role-not-admin for an editor)
 *   UNTRUSTED   an org member, an anonymous caller -> verified-person-not-trusted
 *   NAMED       verifiedPerson + an acting name -> PERSON_ACTS_AS_ITSELF
 *   AGENT PROOF verifiedPerson + agentCredentialSecret -> agent-proof-on-person-path
 *   NOT PERSON  a seat token's hash -> not-a-person-token
 *   NOT LIVE    revoked / expired / unknown hash -> person-token-not-live
 *   ORG         the token's org deactivated -> org-not-active
 *   NO ORG ARG  a verifiedPerson carrying an org is rejected by the validator
 *   TENANT      a person of org-a cannot touch org-b's task / mission
 *   RESERVED    an agent may not be registered or renamed "user:..."
 *   ABSENT      no verifiedPerson: the service account keeps its own behaviour
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { agentIdOf } from "../../tests/lib/agentIdOf";

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
const SERVICE = process.env.CLERK_SERVICE_ACCOUNT_USER_ID as string;
const EDITOR = "a".repeat(64);
const VIEWER = "b".repeat(64);
const SEAT = "c".repeat(64);
const REVOKED = "d".repeat(64);
const EXPIRED = "e".repeat(64);

let t: T;
const service = () => t.withIdentity({ subject: SERVICE });
const memberOf = (org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		org_slug: org,
		org_role: "org:editor",
	} as Parameters<typeof t.withIdentity>[0]);

const person = (accessTokenHash: string) => ({
	verifiedPerson: { accessTokenHash },
});

const TASK = {
	title: "t",
	assignedTo: "agent-a",
	priority: "high" as const,
	status: "todo" as const,
};

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
	let caught: unknown;
	try {
		await p;
	} catch (err) {
		caught = err;
	}
	expect(caught, `expected a refusal carrying ${code}`).toBeDefined();
	const data = (caught as { data?: unknown }).data;
	const text = `${(caught as Error).message} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`;
	expect(text).toContain(code);
}

beforeEach(async () => {
	t = createT();
	const now = Date.now();
	await t.run(async (ctx) => {
		for (const [slug, roster] of [
			["org-a", ["agent-a"]],
			["org-b", ["agent-b"]],
		] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				allowedOrchestrators: [...roster],
				scopes: ["vantage:read", "vantage:write"],
				displayName: slug,
				isActive: true,
				createdAt: now,
			});
		}
		await ctx.db.insert("memberWriterRoles", {
			roles: ["org:admin", "org:editor"],
			updatedAt: now,
		});
		await ctx.db.insert("profiles", {
			orchestratorId: "agent-a",
			name: "agent-a",
			static: { role: "agent", workspace: "w", capabilities: [] },
			dynamic: { lastSeen: now, sessionCount: 0 },
		});
		const row = {
			clientId: "c",
			scopes: ["vantage:read", "vantage:write"],
			scopeProfile: "person",
			fromAllowList: ["agent-a"],
			namespaceReadPrefixes: ["team/org-a"],
			namespaceWritePrefixes: ["team/org-a"],
			expiresAt: now + 3_600_000,
			createdAt: now,
			clerkOrgSlug: "org-a",
		};
		await ctx.db.insert("oauth_access_tokens", {
			...row,
			tokenHash: EDITOR,
			userId: "user_editor",
			orgRole: "org:editor",
			principal: "person",
		});
		await ctx.db.insert("oauth_access_tokens", {
			...row,
			tokenHash: VIEWER,
			userId: "user_viewer",
			orgRole: "org:viewer",
			principal: "person",
		});
		await ctx.db.insert("oauth_access_tokens", {
			...row,
			tokenHash: SEAT,
			userId: "seat",
		});
		await ctx.db.insert("oauth_access_tokens", {
			...row,
			tokenHash: REVOKED,
			userId: "user_editor",
			orgRole: "org:editor",
			principal: "person",
			revokedAt: now,
		});
		await ctx.db.insert("oauth_access_tokens", {
			...row,
			tokenHash: EXPIRED,
			userId: "user_editor",
			orgRole: "org:editor",
			principal: "person",
			expiresAt: now - 1,
		});
	});
});

async function taskIn(org: string, assignedTo: string): Promise<Id<"tasks">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("tasks", {
			title: "seeded",
			assignedTo,
			priority: "high",
			status: "todo",
			createdBy: assignedTo,
			orgId: org,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
}

describe("SERVED — a live editor token, through the service account", () => {
	test("tasks.create records user:<sub> in the token's org", async () => {
		const id = await service().mutation(api.tasks.create, {
			...TASK,
			...person(EDITOR),
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.createdBy).toBe("user:user_editor");
		expect(row?.lastActedBy).toBe("user:user_editor");
		expect(row?.orgId).toBe("org-a");
	});

	test("tasks.start / update / complete act as the person on its own org's task", async () => {
		const id = await taskIn("org-a", "agent-a");
		const as = service();
		await as.mutation(api.tasks.start, { taskId: id, ...person(EDITOR) });
		await as.mutation(api.tasks.update, {
			taskId: id,
			priority: "low",
			...person(EDITOR),
		});
		await as.mutation(api.tasks.complete, {
			taskId: id,
			completionNote: "closed by a person, 1 row",
			...person(EDITOR),
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.status).toBe("done");
		expect(row?.lastActedBy).toBe("user:user_editor");
	});

	test("missions.create / update and messages.sendMessage", async () => {
		const as = service();
		const missionId = await as.mutation(api.missions.create, {
			name: "m",
			project: "p",
			status: "brainstorm",
			priority: "high",
			pilot: "agent-a",
			agents: ["agent-a"],
			...person(EDITOR),
		});
		await as.mutation(api.missions.update, {
			missionId,
			progress: 10,
			...person(EDITOR),
		});
		const m = await t.run(async (ctx) => ctx.db.get(missionId));
		expect(m?.createdBy).toBe("user:user_editor");
		expect(m?.lastActedBy).toBe("user:user_editor");
		expect(m?.orgId).toBe("org-a");

		const messageId = await as.mutation(api.messages.sendMessage, {
			channel: "agent-a",
			content: "hi",
			tenantId: "org-b",
			...person(EDITOR),
		});
		const msg = await t.run(async (ctx) => ctx.db.get(messageId));
		expect(msg?.from).toBe("user:user_editor");
		expect(msg?.tenantId).toBe("org-a");
	});
});

describe("ROLE — the Convex door applies the writer role itself", () => {
	test("cancelling stays org:admin: an editor is refused role-not-admin, an admin is served", async () => {
		await t.run(async (ctx) => {
			await ctx.db.insert("oauth_access_tokens", {
				tokenHash: "9".repeat(64),
				clientId: "c",
				userId: "user_admin",
				scopes: ["vantage:read", "vantage:write"],
				scopeProfile: "person",
				fromAllowList: ["agent-a"],
				namespaceReadPrefixes: ["team/org-a"],
				namespaceWritePrefixes: ["team/org-a"],
				expiresAt: Date.now() + 3_600_000,
				createdAt: Date.now(),
				clerkOrgSlug: "org-a",
				orgRole: "org:admin",
				principal: "person",
			});
		});
		const id = await taskIn("org-a", "agent-a");
		const cancel = {
			taskId: id,
			status: "cancelled" as const,
			cancelReason: "no longer needed",
		};
		await expectCode(
			service().mutation(api.tasks.update, { ...cancel, ...person(EDITOR) }),
			"role-not-admin",
		);
		await service().mutation(api.tasks.update, {
			...cancel,
			...person("9".repeat(64)),
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.status).toBe("cancelled");
		expect(row?.cancelledBy).toBe("user:user_admin");
	});

	test("a viewer token is refused role-not-writer and writes nothing", async () => {
		await expectCode(
			service().mutation(api.tasks.create, { ...TASK, ...person(VIEWER) }),
			"role-not-writer",
		);
		await expectCode(
			service().mutation(api.messages.sendMessage, {
				channel: "agent-a",
				content: "x",
				...person(VIEWER),
			}),
			"role-not-writer",
		);
		expect(await t.run(async (ctx) => ctx.db.query("tasks").collect())).toEqual(
			[],
		);
	});
});

describe("UNTRUSTED — only the service account may carry a person", () => {
	test("an org member presenting verifiedPerson is refused, never ignored", async () => {
		await expectCode(
			memberOf("org-a").mutation(api.tasks.create, {
				...TASK,
				...person(EDITOR),
			}),
			"verified-person-not-trusted",
		);
		await expectCode(
			memberOf("org-a").mutation(api.messages.sendMessage, {
				channel: "agent-a",
				content: "x",
				...person(EDITOR),
			}),
			"verified-person-not-trusted",
		);
	});

	test("an anonymous caller presenting verifiedPerson is refused", async () => {
		await expectCode(
			t.mutation(api.missions.create, {
				name: "m",
				project: "p",
				status: "brainstorm",
				priority: "high",
				pilot: "agent-a",
				agents: [],
				...person(EDITOR),
			}),
			"verified-person-not-trusted",
		);
	});
});

describe("NAMED / AGENT PROOF — a person acts only as itself", () => {
	test("verifiedPerson beside an acting name is refused at every covered door", async () => {
		const id = await taskIn("org-a", "agent-a");
		const as = service();
		for (const p of [
			as.mutation(api.tasks.create, {
				...TASK,
				createdBy: "agent-a",
				...person(EDITOR),
			}),
			as.mutation(api.tasks.start, {
				taskId: id,
				callerOrchestrator: "user:other",
				...person(EDITOR),
			}),
			as.mutation(api.messages.sendMessage, {
				from: "agent-a",
				channel: "agent-a",
				content: "x",
				...person(EDITOR),
			}),
			as.mutation(api.missions.create, {
				name: "m",
				project: "p",
				status: "brainstorm",
				priority: "high",
				pilot: "agent-a",
				agents: [],
				createdBy: "user:other",
				...person(EDITOR),
			}),
		]) {
			await expectCode(p, "PERSON_ACTS_AS_ITSELF");
		}
	});

	test("verifiedPerson beside an agent credential is refused", async () => {
		await expectCode(
			service().mutation(api.tasks.create, {
				...TASK,
				agentCredentialSecret: "anything",
				...person(EDITOR),
			}),
			"agent-proof-on-person-path",
		);
	});
});

describe("NOT PERSON / NOT LIVE / ORG — the token row decides", () => {
	test("a seat token's hash is not a person", async () => {
		await expectCode(
			service().mutation(api.tasks.create, { ...TASK, ...person(SEAT) }),
			"not-a-person-token",
		);
	});

	test("revoked, expired and unknown hashes are refused", async () => {
		for (const hash of [REVOKED, EXPIRED, "f".repeat(64)]) {
			await expectCode(
				service().mutation(api.tasks.create, { ...TASK, ...person(hash) }),
				"person-token-not-live",
			);
		}
	});

	test("the token's organisation deactivated: refused", async () => {
		await t.run(async (ctx) => {
			const m = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "org-a"))
				.first();
			if (m) await ctx.db.patch(m._id, { isActive: false });
		});
		await expectCode(
			service().mutation(api.tasks.create, { ...TASK, ...person(EDITOR) }),
			"org-not-active",
		);
	});
});

describe("NO ORG ARG — the proof's shape admits no organisation", () => {
	test("a verifiedPerson carrying an orgSlug is rejected and writes nothing", async () => {
		await expect(
			service().mutation(api.tasks.create, {
				...TASK,
				assignedTo: "agent-b",
				verifiedPerson: { accessTokenHash: EDITOR, orgSlug: "org-b" },
			} as never),
		).rejects.toThrow();
		expect(await t.run(async (ctx) => ctx.db.query("tasks").collect())).toEqual(
			[],
		);
	});
});

describe("TENANT — a person of org-a cannot touch org-b", () => {
	test("start / update / complete on org-b's task are refused", async () => {
		const id = await taskIn("org-b", "agent-b");
		const as = service();
		await expectCode(
			as.mutation(api.tasks.start, { taskId: id, ...person(EDITOR) }),
			"tenant boundary",
		);
		await expectCode(
			as.mutation(api.tasks.complete, {
				taskId: id,
				completionNote: "nope, not mine at all",
				...person(EDITOR),
			}),
			"tenant boundary",
		);
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.status).toBe("todo");
	});

	test("creating a task assigned into org-b is refused", async () => {
		await expectCode(
			service().mutation(api.tasks.create, {
				...TASK,
				assignedTo: "agent-b",
				...person(EDITOR),
			}),
			"RBAC_DENIED",
		);
	});
});

describe("RESERVED — no agent is ever named like a person", () => {
	const admin = () =>
		t.withIdentity({
			subject: "admin-of-org-a",
			org_slug: "org-a",
			org_role: "org:admin",
		} as Parameters<typeof t.withIdentity>[0]);

	test("registerAgent and renameAgent refuse a user: name", async () => {
		await expectCode(
			admin().mutation(api.agents.registerAgent, {
				orgSlug: "org-a",
				name: "User:someone",
			}),
			"AGENT_NAME_RESERVED",
		);
		await admin().mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "agent-a",
		});
		await expectCode(
			admin().mutation(api.agents.renameAgent, {
				orgSlug: "org-a",
				agentId: await agentIdOf(t, "org-a", "agent-a"),
				newName: "user:user_editor",
			}),
			"AGENT_NAME_RESERVED",
		);
	});

	test("provisioning refuses a seat named user:... and writes no mapping", async () => {
		await t.run(async (ctx) => {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: "operator-org",
				allowedOrchestrators: ["op-seat"],
				scopes: ["view-own-tasks"],
				displayName: "operator-org",
				isActive: true,
				createdAt: Date.now(),
				orgKind: "operator",
			});
		});
		const operatorAdmin = t.withIdentity({
			subject: "user_op",
			organizationSlug: "operator-org",
			orgRole: "org:admin",
		} as Parameters<typeof t.withIdentity>[0]);
		await expectCode(
			operatorAdmin.mutation(api.oauth.provisionOrganization, {
				clerkOrgSlug: "client-x",
				displayName: "x",
				orchestrators: [{ name: "user:someone" }],
			}),
			"reserved orchestrator name",
		);
		const mapped = await t.run(async (ctx) =>
			ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", "client-x"))
				.collect(),
		);
		expect(mapped).toEqual([]);
	});
});

describe("ABSENT — no verifiedPerson, the service account is unchanged", () => {
	test("the service account naming an agent still creates as that agent", async () => {
		const id = await service().mutation(api.tasks.create, {
			...TASK,
			createdBy: "agent-a",
		});
		const row = await t.run(async (ctx) => ctx.db.get(id));
		expect(row?.createdBy).toBe("agent-a");
		expect(row?.orgId).toBeUndefined();
	});

	test("the service account naming nobody is still refused (it is no person)", async () => {
		await expectCode(
			service().mutation(api.tasks.create, TASK),
			"callerOrchestrator is required",
		);
	});
});
