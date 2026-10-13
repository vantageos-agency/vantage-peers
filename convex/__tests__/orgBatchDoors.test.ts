/// <reference types="vite/client" />
/**
 * BATCH F2 (org lane): the doors of missions, missionTemplates, mandates,
 * businessUnits, iframeEmbedSessions, profiles, orgRoster, memberWriterRoles and
 * the agent registry are decided through @vantageos/cloud-identity and refuse in
 * a shape that names the door and the reason.
 *
 * Poles per door, as the brief asks:
 *   REFUSED       an anonymous caller, and an ORDINARY member of an organisation
 *                 (never the master used to prove a denial);
 *   PRESENT       the fleet service account, where the door is the fleet's;
 *   ABSENT        a legitimately admitted caller reading or acting on nothing gets
 *                 a genuine success or a typed not-found, never a refusal;
 *   CROSS-ORG     an ordinary member of organisation B against organisation A.
 *
 * The service-account-only doors used to refuse with a bare string that named
 * neither the door nor the reason. They now say both (`requireResolvedCaller`,
 * `masterOnly` + `mcpBoundOnly`), so a reader can branch on content.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { findAgentId } from "../../tests/lib/agentIdOf";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
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

type T = ReturnType<typeof createT>;
const createT = () => convexTest(schema, modules);

const asFleet = (t: T) =>
	t.withIdentity({
		subject: "test-service-account-user-id",
	} as Parameters<typeof t.withIdentity>[0]);
const asMember = (t: T, org: string) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		organizationId: org,
		org_id: testClerkOrgId(org),
		org_role: "org:editor",
	} as Parameters<typeof t.withIdentity>[0]);
const asAdmin = (t: T, org: string) =>
	t.withIdentity({
		subject: `admin-of-${org}`,
		org_slug: org,
		org_id: testClerkOrgId(org),
		org_role: "org:admin",
	} as Parameters<typeof t.withIdentity>[0]);

async function seedOrg(t: T, slug: string, roster: string[] = [`seat-${slug}`]) {
	await t.run(async (ctx) => {
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: slug,
			clerkOrgId: testClerkOrgId(slug),
			allowedOrchestrators: roster,
			scopes: ["view-own-missions", "view-own-tasks"],
			displayName: slug,
			isActive: true,
			createdAt: Date.now(),
		});
	});
	await seedRosterAgents(t);
}

/** The ConvexError payload a refused call carries, as one string. */
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

describe("service-account-only doors refuse with a payload that names the door and the reason", () => {
	test("memberWriterRoles:assertPersonMayWrite", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const args = { orgSlug: "org-a", role: "org:admin", door: "x" };
		const anonymous = await refusal(
			t.query(api.memberWriterRoles.assertPersonMayWrite, args),
		);
		expect(anonymous).toContain("memberWriterRoles:assertPersonMayWrite");
		expect(anonymous).toContain("no-credential");
		const member = await refusal(
			asMember(t, "org-a").query(api.memberWriterRoles.assertPersonMayWrite, args),
		);
		expect(member).toContain("memberWriterRoles:assertPersonMayWrite");
		expect(member).toContain("not-mcp-bound-master");
		// PRESENT: the service account with a writer list on file.
		await t.run(async (ctx) => {
			await ctx.db.insert("memberWriterRoles", {
				roles: ["org:admin"],
				updatedAt: Date.now(),
			});
		});
		expect(
			await asFleet(t).query(api.memberWriterRoles.assertPersonMayWrite, args),
		).toEqual({ allowed: true });
		// ABSENT list for the role asked: the service account is still refused on the
		// ROLE, never served an allowance by omission.
		await refusal(
			asFleet(t).query(api.memberWriterRoles.assertPersonMayWrite, {
				...args,
				role: "org:viewer",
			}),
		);
	});

	test("missionTemplates:upsert and softDelete: refused, then served to the fleet", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const tpl = {
			name: "tpl-f2",
			steps: [{ title: "s", description: "d" }],
			createdBy: "sigma",
		};
		for (const [fn, args, door] of [
			[api.missionTemplates.upsert, tpl, "missionTemplates:upsert"],
			[api.missionTemplates.softDelete, { name: "tpl-f2" }, "missionTemplates:softDelete"],
		] as const) {
			const anonymous = await refusal(t.mutation(fn as never, args as never));
			expect(anonymous).toContain(door);
			const member = await refusal(
				asMember(t, "org-a").mutation(fn as never, args as never),
			);
			expect(member).toContain(door);
			expect(member).toContain("not-mcp-bound-master");
		}
		// PRESENT
		const id = await asFleet(t).mutation(api.missionTemplates.upsert, tpl);
		expect(id).toBeDefined();
		await asFleet(t).mutation(api.missionTemplates.softDelete, { name: "tpl-f2" });
		// ABSENT: a template that does not exist is a typed not-found, not a refusal.
		await expect(
			asFleet(t).mutation(api.missionTemplates.softDelete, { name: "never-was" }),
		).rejects.toThrow(/not found/);
		// A soft-deleted template reads as absent to the fleet.
		expect(
			await asFleet(t).query(api.missionTemplates.getByName, { name: "tpl-f2" }),
		).toBeNull();
	});

	test("orgRoster token doors", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		for (const [fn, door] of [
			[api.orgRoster.getForAccessToken, "orgRoster:getForAccessToken"],
			[
				api.orgRoster.getAgentDirectoryForAccessToken,
				"orgRoster:getAgentDirectoryForAccessToken",
			],
		] as const) {
			const anonymous = await refusal(t.query(fn, { tokenHash: "h" }));
			expect(anonymous).toContain(door);
			expect(anonymous).toContain("no-credential");
			const member = await refusal(
				asMember(t, "org-a").query(fn, { tokenHash: "h" }),
			);
			expect(member).toContain(door);
			expect(member).toContain("not-mcp-bound-master");
			// The service account passes the caller gate and is refused only on the
			// TOKEN (a different reason): an unknown token is not an empty roster.
			const unknownToken = await refusal(asFleet(t).query(fn, { tokenHash: "h" }));
			expect(unknownToken).not.toContain("not-mcp-bound-master");
		}
	});

	test("profiles:upsertProfile and updateDynamic are the fleet's writes", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		const upsert = { orchestratorId: "sigma" };
		for (const [fn, args] of [
			[api.profiles.upsertProfile, upsert],
			[api.profiles.updateDynamic, upsert],
		] as const) {
			const anonymous = await refusal(t.mutation(fn as never, args as never));
			expect(anonymous).toContain("fleet-internal");
			// CROSS-ORG: a member of org B (or of org A) is not the fleet.
			for (const org of ["org-a", "org-b"]) {
				const member = await refusal(
					asMember(t, org).mutation(fn as never, args as never),
				);
				expect(member).toContain("fleet-internal");
			}
		}
		// PRESENT: the fleet writes its registry.
		const id = await asFleet(t).mutation(api.profiles.upsertProfile, upsert);
		expect(id).toBeDefined();
		await asFleet(t).mutation(api.profiles.updateDynamic, {
			...upsert,
			currentTask: "t",
		});
		const profile = await asFleet(t).query(api.profiles.getProfile, upsert);
		expect(profile?.dynamic.currentTask).toBe("t");
		// ABSENT: an orchestrator with no profile is a genuine null.
		expect(
			await asFleet(t).query(api.profiles.getProfile, { orchestratorId: "nobody" }),
		).toBeNull();
	});

	test("mandates: members are refused, the fleet writes and lists", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		const args = {
			requestedBy: "sigma",
			fulfilledBy: "eta",
			service: "svc",
			budget: 5,
		};
		await refusal(t.mutation(api.mandates.create, args));
		await refusal(asMember(t, "org-a").mutation(api.mandates.create, args));
		// ABSENT: the fleet reads an empty table as a genuine empty success.
		expect(await asFleet(t).query(api.mandates.list, {})).toEqual([]);
		// PRESENT
		const id = await asFleet(t).mutation(api.mandates.create, args);
		const rows = await asFleet(t).query(api.mandates.list, {});
		expect(Array.isArray(rows) && rows.map((r) => r._id)).toEqual([id]);
		// CROSS-ORG: the member gets the typed envelope, never the row.
		expect(await asMember(t, "org-a").query(api.mandates.list, {})).toEqual({
			refused: true,
			items: [],
		});
		await refusal(
			asMember(t, "org-a").query(api.mandates.get, { mandateId: id }),
		);
	});
});

describe("profiles:getProfile judges the roster BY AGENT ID, not by name", () => {
	async function seedOrgWithTwoAgents(t: T) {
		// `extra` is registered in org-a and listed on the legacy NAME roster, but it
		// is NOT an entry of the ID roster (`allowedAgentIds`).
		await seedOrg(t, "org-a", ["seat-a"]);
		await t.run(async (ctx) => {
			const mapping = await ctx.db.query("client_org_mapping").first();
			if (mapping === null) throw new Error("no mapping");
			await ctx.db.patch(mapping._id, {
				allowedOrchestrators: ["seat-a", "extra"],
			});
			await ctx.db.insert("agents", {
				orgSlug: "org-a",
				clerkOrgId: testClerkOrgId("org-a"),
				name: "extra",
				normalizedName: "extra",
				isActive: true,
				createdAt: 1,
			});
		});
	}

	test("REFUSED: an agent of the org that is on the name list but not on the ID roster", async () => {
		const t = createT();
		await seedOrgWithTwoAgents(t);
		await expect(
			asMember(t, "org-a").query(api.profiles.getProfile, {
				orchestratorId: "extra",
			}),
		).rejects.toThrow(/not-on-roster/);
	});

	test("PRESENT: an agent on the ID roster is served its profile", async () => {
		const t = createT();
		await seedOrgWithTwoAgents(t);
		const seat = await findAgentId(t, "org-a", "seat-a");
		await t.run(async (ctx) => {
			await ctx.db.insert("profiles", {
				orchestratorId: "seat-a",
				...(seat !== null ? { agentId: seat } : {}),
				name: "seat-a",
				static: { role: "r", workspace: "w", capabilities: [] },
				dynamic: { lastSeen: 1, sessionCount: 1 },
			});
		});
		const profile = await asMember(t, "org-a").query(api.profiles.getProfile, {
			orchestratorId: "seat-a",
		});
		expect(profile?.orchestratorId).toBe("seat-a");
	});

	test("ABSENT: on the ID roster with no profile row is a genuine null", async () => {
		const t = createT();
		await seedOrgWithTwoAgents(t);
		expect(
			await asMember(t, "org-a").query(api.profiles.getProfile, {
				orchestratorId: "seat-a",
			}),
		).toBeNull();
	});

	test("CROSS-ORG: a member of org B cannot ask for org A's agent by label", async () => {
		const t = createT();
		await seedOrgWithTwoAgents(t);
		await seedOrg(t, "org-b", ["seat-b"]);
		await expect(
			asMember(t, "org-b").query(api.profiles.getProfile, {
				orchestratorId: "seat-a",
			}),
		).rejects.toThrow(/not-on-roster/);
	});
});

describe("iframeEmbedSessions: the standing is the package's", () => {
	const expiresAt = Date.now() + 3_600_000;

	test("REFUSED anonymous, CROSS-ORG denied, PRESENT own org and fleet, ABSENT unknown id", async () => {
		const t = createT();
		await seedOrg(t, "org-a");
		await seedOrg(t, "org-b");
		await refusal(
			t.mutation(api.iframeEmbedSessions.createSession, {
				sessionId: "s-anon",
				origin: "https://a.example",
				expiresAt,
			}),
		);
		await asMember(t, "org-a").mutation(api.iframeEmbedSessions.createSession, {
			sessionId: "s-a",
			origin: "https://a.example",
			expiresAt,
		});
		await refusal(
			asMember(t, "org-b").mutation(api.iframeEmbedSessions.touchSession, {
				sessionId: "s-a",
			}),
		);
		await refusal(
			asMember(t, "org-b").mutation(api.iframeEmbedSessions.revokeSession, {
				sessionId: "s-a",
			}),
		);
		expect(
			await asMember(t, "org-b").query(api.iframeEmbedSessions.getSession, {
				sessionId: "s-a",
			}),
		).toBeNull();
		expect(
			await asMember(t, "org-a").mutation(api.iframeEmbedSessions.touchSession, {
				sessionId: "s-a",
			}),
		).toBe(true);
		expect(
			await asFleet(t).mutation(api.iframeEmbedSessions.revokeSession, {
				sessionId: "s-a",
			}),
		).toBe(true);
		expect(
			await asMember(t, "org-a").mutation(api.iframeEmbedSessions.touchSession, {
				sessionId: "never-was",
			}),
		).toBe(false);
	});
});

describe("agent registry: the stamp is the principal's own organisation", () => {
	test("PRESENT: an admin of org A registers and mints; CROSS-ORG: an admin of org B cannot", async () => {
		const t = createT();
		await seedOrg(t, "org-a", []);
		await seedOrg(t, "org-b", []);
		const id = await asAdmin(t, "org-a").mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "scout",
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.orgSlug).toBe("org-a");
		expect(row?.clerkOrgId).toBe(testClerkOrgId("org-a"));
		const minted = await asAdmin(t, "org-a").mutation(
			api.agentCredentials.mintAgentCredential,
			{ orgSlug: "org-a", agentId: id },
		);
		expect(minted.secret).toHaveLength(64);
		const credential = await t.run((ctx) =>
			ctx.db.query("agent_credentials").first(),
		);
		expect(credential?.orgSlug).toBe("org-a");
		await refusal(
			asAdmin(t, "org-b").mutation(api.agents.registerAgent, {
				orgSlug: "org-a",
				name: "intruder",
			}),
		);
		await refusal(
			asAdmin(t, "org-b").mutation(api.agentCredentials.mintAgentCredential, {
				orgSlug: "org-a",
				agentId: id,
			}),
		);
		// REFUSED: no credential at all.
		await refusal(
			t.mutation(api.agents.registerAgent, { orgSlug: "org-a", name: "ghost" }),
		);
		// ABSENT: an organisation with no agents lists a genuine empty set.
		expect(
			await asAdmin(t, "org-b").query(api.agents.listAgentsByOrg, {
				orgSlug: "org-b",
			}),
		).toEqual([]);
	});

	test("renaming an agent to the same label schedules no continuation", async () => {
		const t = createT();
		await seedOrg(t, "org-a", []);
		const id = await asAdmin(t, "org-a").mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "scout",
		});
		const other = await asAdmin(t, "org-a").mutation(api.agents.registerAgent, {
			orgSlug: "org-a",
			name: "lead",
		});
		await asAdmin(t, "org-a").mutation(api.agentRelations.linkChild, {
			orgSlug: "org-a",
			parentAgentId: other,
			childAgentId: id,
		});
		await asAdmin(t, "org-a").mutation(api.agents.renameAgent, {
			orgSlug: "org-a",
			agentId: id,
			newName: "scout",
		});
		const scheduled = await t.run((ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		expect(scheduled).toHaveLength(0);
		const edges = await asAdmin(t, "org-a").query(api.agentRelations.childrenOf, {
			orgSlug: "org-a",
			parentAgentId: other,
		});
		expect(edges.map((e) => e.childName)).toEqual(["scout"]);
	});
});
