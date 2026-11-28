/// <reference types="vite/client" />
// allow-missing-refs: new file
//
// VantagePeers Cloud, task k17esvscdrzgmx6ef40n3nyj4s8k009s (mcp-server-standard
// S-28 / S-35: the scope is decided INSIDE the read, never after it).
//
// Three public reads served the MCP's service-account call as master and left
// the MCP to narrow the rows afterwards. Each now takes `verifiedOrg` (believed
// from the fleet service account only) and answers the claim as a member of that
// organisation would be answered by the door's existing member logic:
//   memories:listMemories  rows stamped with the org ID; a foreign page is empty
//   profiles:getProfile    roster refusal / absence of a foreign agent's profile
//   fixPatterns:get        the pattern's creator must be on the org roster
//                          (refused RBAC_DENIED, the door's own creator-roster code)
//
// Poles per door:
//   OWN        verifiedOrg of the row's org -> served
//   FOREIGN    another active org -> the door's member shape
//   UNCHANGED  service account, no claim -> as before (expand only)
//   REFUSED    a non-service caller presenting verifiedOrg -> RBAC_DENIED
//   INACTIVE   a claim naming an inactive org -> RBAC_DENIED

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
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

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];

const A_SLUG = "s28-a";
const B_SLUG = "s28-b";
const D_SLUG = "s28-dead";
const A_ID = testClerkOrgId(A_SLUG);
const B_ID = testClerkOrgId(B_SLUG);
const D_ID = testClerkOrgId(D_SLUG);
const claimA = { orgSlug: A_SLUG, orgId: A_ID };
const claimDead = { orgSlug: D_SLUG, orgId: D_ID };

const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);
const memberOf = (t: T, slug: string) =>
	t.withIdentity({
		subject: `member-of-${slug}`,
		org_slug: slug,
		org_id: testClerkOrgId(slug),
		org_role: "org:member",
	} as Identity);
const adminOf = (t: T, slug: string) =>
	t.withIdentity({
		subject: `admin-of-${slug}`,
		org_slug: slug,
		org_id: testClerkOrgId(slug),
		org_role: "org:admin",
	} as Identity);

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		const data = (e as { data?: unknown }).data;
		return `${(e as Error).message} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`;
	}
	return "NO-REFUSAL";
}

async function seedOrgs(t: T) {
	await t.run(async (ctx) => {
		const org = (slug: string, id: string, roster: string[], isActive: boolean) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: id,
				allowedOrchestrators: roster,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive,
				createdAt: 1_700_000_000_000,
			});
		await org(A_SLUG, A_ID, ["ada"], true);
		await org(B_SLUG, B_ID, ["bob"], true);
		await org(D_SLUG, D_ID, ["dan"], false);
	});
}

// ── memories:listMemories ────────────────────────────────────────────────────

async function seedMemory(t: T, namespace: string, clerkOrgId: string, content: string) {
	return await t.run((ctx) =>
		ctx.db.insert("memories", {
			namespace,
			type: "project",
			content,
			createdBy: "someone",
			relations: [],
			isLatest: true,
			createdAt: 1,
			updatedAt: 1,
			clerkOrgId,
		}),
	);
}

async function memoriesWorld() {
	const t = createT();
	await seedOrgs(t);
	await seedMemory(t, `team/${A_SLUG}`, A_ID, "A row");
	await seedMemory(t, `team/${B_SLUG}`, B_ID, "B row");
	return t;
}

describe("memories:listMemories applies the verified org inside the read", () => {
	test("OWN: verifiedOrg A lists A's team namespace", async () => {
		const t = await memoriesWorld();
		const r = await asService(t).query(api.memories.listMemories, {
			namespace: `team/${A_SLUG}`,
			verifiedOrg: claimA,
		});
		expect(r.value.map((m) => m.content)).toEqual(["A row"]);
	});
	test("FOREIGN: verifiedOrg A listing B's team namespace is the typed-empty page", async () => {
		const t = await memoriesWorld();
		const r = await asService(t).query(api.memories.listMemories, {
			namespace: `team/${B_SLUG}`,
			verifiedOrg: claimA,
		});
		expect(r.value).toEqual([]);
		expect(r.isDone).toBe(true);
	});
	test("FOREIGN: verifiedOrg A cannot read every namespace (member, no namespace) -> RBAC_DENIED", async () => {
		const t = await memoriesWorld();
		const out = await codeOf(
			asService(t).query(api.memories.listMemories, {
				type: "project",
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
	});
	test("UNCHANGED: the service account with no claim reads B's namespace as before", async () => {
		const t = await memoriesWorld();
		const r = await asService(t).query(api.memories.listMemories, {
			namespace: `team/${B_SLUG}`,
		});
		expect(r.value.map((m) => m.content)).toEqual(["B row"]);
		const all = await asService(t).query(api.memories.listMemories, {
			type: "project",
		});
		expect(all.value.length).toBe(2);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const t = await memoriesWorld();
		const out = await codeOf(
			memberOf(t, A_SLUG).query(api.memories.listMemories, {
				namespace: `team/${A_SLUG}`,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const t = await memoriesWorld();
		const out = await codeOf(
			asService(t).query(api.memories.listMemories, {
				namespace: `team/${A_SLUG}`,
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});

// ── profiles:getProfile ──────────────────────────────────────────────────────

const STATIC = { role: "backend", workspace: "/work", capabilities: [] };

async function registerAgent(t: T, slug: string, name: string): Promise<Id<"agents">> {
	const id = await adminOf(t, slug).mutation(api.agents.registerAgent, { name });
	await t.run(async (ctx) => {
		const row = await ctx.db
			.query("client_org_mapping")
			.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", slug))
			.first();
		if (row !== null) {
			await ctx.db.patch(row._id, {
				allowedAgentIds: [...(row.allowedAgentIds ?? []), id],
			});
		}
	});
	return id;
}

async function insertProfile(
	t: T,
	orchestratorId: string,
	instanceId: string,
	agentId: Id<"agents">,
) {
	return await t.run((ctx) =>
		ctx.db.insert("profiles", {
			orchestratorId,
			instanceId,
			agentId,
			name: `${orchestratorId} profile`,
			static: STATIC,
			dynamic: { lastSeen: 1, sessionCount: 0 },
		}),
	);
}

async function profilesWorld() {
	const t = createT();
	await seedOrgs(t);
	const ada = await registerAgent(t, A_SLUG, "ada");
	const bob = await registerAgent(t, B_SLUG, "bob");
	const profileA = await insertProfile(t, "ada", "ada-vps", ada);
	const profileB = await insertProfile(t, "bob", "bob-vps", bob);
	return { t, profileA, profileB };
}

describe("profiles:getProfile applies the verified org inside the read", () => {
	test("OWN: verifiedOrg A reads the profile of its own agent", async () => {
		const { t, profileA } = await profilesWorld();
		const r = await asService(t).query(api.profiles.getProfile, {
			orchestratorId: "ada",
			verifiedOrg: claimA,
		});
		expect(r?._id).toBe(profileA);
	});
	test("FOREIGN: verifiedOrg A asking for B's orchestrator is refused (not on roster); by instance it is an absence", async () => {
		const { t } = await profilesWorld();
		const out = await codeOf(
			asService(t).query(api.profiles.getProfile, {
				orchestratorId: "bob",
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("not-on-roster");
		const byInstance = await asService(t).query(api.profiles.getProfile, {
			instanceId: "bob-vps",
			verifiedOrg: claimA,
		});
		expect(byInstance).toBeNull();
	});
	test("UNCHANGED: the service account with no claim reads either org's profile as before", async () => {
		const { t, profileA, profileB } = await profilesWorld();
		const a = await asService(t).query(api.profiles.getProfile, { orchestratorId: "ada" });
		const b = await asService(t).query(api.profiles.getProfile, { orchestratorId: "bob" });
		expect(a?._id).toBe(profileA);
		expect(b?._id).toBe(profileB);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t } = await profilesWorld();
		const out = await codeOf(
			memberOf(t, A_SLUG).query(api.profiles.getProfile, {
				orchestratorId: "ada",
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("verified-org-not-trusted");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t } = await profilesWorld();
		const out = await codeOf(
			asService(t).query(api.profiles.getProfile, {
				orchestratorId: "ada",
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});

// ── fixPatterns:get ──────────────────────────────────────────────────────────

async function insertPattern(t: T, createdBy: string) {
	return await t.run((ctx) =>
		ctx.db.insert("fixPatterns", {
			symptom: `symptom of ${createdBy}`,
			rootCause: "cause",
			tags: [],
			stack: [],
			sourceProject: "p",
			createdBy,
			severity: "minor",
			createdAt: 1,
			updatedAt: 1,
		}),
	);
}

async function patternsWorld() {
	const t = createT();
	await seedOrgs(t);
	const own = await insertPattern(t, "ada");
	const foreign = await insertPattern(t, "bob");
	return { t, own, foreign };
}

describe("fixPatterns:get applies the verified org inside the read", () => {
	test("OWN: verifiedOrg A reads a pattern created by an orchestrator on A's roster", async () => {
		const { t, own } = await patternsWorld();
		const r = await asService(t).query(api.fixPatterns.get, {
			patternId: own,
			verifiedOrg: claimA,
		});
		expect(r?._id).toBe(own);
	});
	test("FOREIGN: verifiedOrg A reading a pattern created outside A's roster is refused, not null", async () => {
		const { t, foreign } = await patternsWorld();
		const out = await codeOf(
			asService(t).query(api.fixPatterns.get, {
				patternId: foreign,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("not-in-creator-roster");
	});
	test("UNCHANGED: the service account with no claim reads any pattern as before", async () => {
		const { t, own, foreign } = await patternsWorld();
		expect((await asService(t).query(api.fixPatterns.get, { patternId: own }))?._id).toBe(own);
		expect((await asService(t).query(api.fixPatterns.get, { patternId: foreign }))?._id).toBe(
			foreign,
		);
	});
	test("REFUSED: a member presenting verifiedOrg is refused RBAC_DENIED", async () => {
		const { t, own } = await patternsWorld();
		const out = await codeOf(
			memberOf(t, A_SLUG).query(api.fixPatterns.get, {
				patternId: own,
				verifiedOrg: claimA,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
	});
	test("INACTIVE: a claim naming an inactive org is refused", async () => {
		const { t, own } = await patternsWorld();
		const out = await codeOf(
			asService(t).query(api.fixPatterns.get, {
				patternId: own,
				verifiedOrg: claimDead,
			}),
		);
		expect(out).toContain("RBAC_DENIED");
		expect(out).toContain("org-not-active");
	});
});
