/// <reference types="vite/client" />
/**
 * Task k179y0wpsd6fv7055f4p2w6b358hdrxe — VantagePeers Cloud (multi-tenant):
 * the fleet service account, acting for a NON-MASTER MCP bearer, is an ORDINARY
 * MEMBER of that bearer's organisation at every door.
 *
 * The MCP reaches Convex as the fleet service account for every non-Clerk
 * bearer; on its own that identity is fleet master. The org now rides on every
 * such call as the reserved `__actingOrg` argument (the permanent Clerk org ID),
 * attached by the MCP client wrapper and consumed by the identity layer, so a
 * door needs no per-door argument.
 *
 * Two organisations, A and B, each with rows in every family the scope sweep
 * found leaking. Per door, five poles:
 *   1. ISOLATION   service account + __actingOrg(A) never returns a B row;
 *   2. EQUIVALENCE its outcome equals what an ordinary Clerk member of A gets
 *                  (the same rows, or the same refusal code);
 *   3. OWN ROWS    where an A member is served A rows, so is the acting call;
 *   4. MASTER      the service account WITHOUT the argument is unchanged (it
 *                  still reads B: fleet stations keep the fleet);
 *   5. NO IMPERSONATION  a member of B presenting __actingOrg(A) is answered
 *                  exactly as that member of B, and never sees an A row.
 * Writes: the acting call cannot write into, or change, B's rows, and what it
 * creates is A's.
 */

import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedRosterAgents } from "../../tests/lib/seedRosterAgents";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("search") && !path.includes("backfill"),
	),
);

// Writes schedule a RAG-sync action; fake timers + `drain` run every scheduled
// call to a terminal state inside its own test (fixPatternsWriteScope.test.ts).
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;
const drain = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

const SERVICE_ACCOUNT = "test-service-account-user-id";
const A = "acting-org-a";
const B = "acting-org-b";
const A_ID = testClerkOrgId(A);
const B_ID = testClerkOrgId(B);
const ROSTER = { [A]: "alice", [B]: "bob" } as const;
const MARK = { [A]: "MARK_ORG_A", [B]: "MARK_ORG_B" } as const;

type Org = typeof A | typeof B;
type Client = ReturnType<T["withIdentity"]>;
type Ref = unknown;

const asService = (t: T) => t.withIdentity({ subject: SERVICE_ACCOUNT });
const asMember = (t: T, org: Org) =>
	t.withIdentity({
		subject: `member-of-${org}`,
		organizationId: org,
		org_id: testClerkOrgId(org),
		organizationSlug: org,
		org_role: "org:admin",
	} as Parameters<T["withIdentity"]>[0]);

type Outcome =
	| { ok: true; value: unknown }
	| { ok: false; code: string };

function codeOf(e: unknown): string {
	const text =
		e instanceof ConvexError ? String(e.data) : String((e as Error).message);
	const m = /([A-Z][A-Z_]{3,}):/.exec(text);
	return m ? m[1] : `UNCODED(${text.slice(0, 120)})`;
}

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
	try {
		return { ok: true, value: await run() };
	} catch (e) {
		return { ok: false, code: codeOf(e) };
	}
}

const actingArgs = (args: Record<string, unknown>, org: Org) => ({
	...args,
	__actingOrg: testClerkOrgId(org),
});

type Kind = "query" | "mutation";

async function call(
	client: Client,
	kind: Kind,
	ref: Ref,
	args: Record<string, unknown>,
): Promise<Outcome> {
	return outcome(() =>
		kind === "query"
			? client.query(ref as never, args as never)
			: client.mutation(ref as never, args as never),
	);
}

const json = (o: Outcome) => JSON.stringify(o);

// ─────────────────────────────────────────────────────────────────────────────
// Seeds: two active client orgs with their roster agents, and one row per
// family per org, each carrying its org's marker.
// ─────────────────────────────────────────────────────────────────────────────

type Seeded = Record<
	Org,
	{
		task: Id<"tasks">;
		mission: Id<"missions">;
		memory: Id<"memories">;
		note: Id<"briefingNotes">;
		recurring: Id<"recurringTasks">;
		mandate: Id<"mandates">;
		pattern: Id<"fixPatterns">;
		message: Id<"messages">;
		agent: Id<"agents">;
	}
>;

async function seed(t: T): Promise<Seeded> {
	await t.run(async (ctx) => {
		for (const org of [A, B] as const) {
			await ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: org,
				clerkOrgId: testClerkOrgId(org),
				allowedOrchestrators: [ROSTER[org]],
				scopes: ["view-own-tasks", "view-own-missions", "view-stats-aggregated"],
				displayName: org,
				isActive: true,
				createdAt: 1,
			});
		}
	});
	const agents = await seedRosterAgents(t);
	return await t.run(async (ctx) => {
		const out = {} as Seeded;
		const now = 1_780_000_000_000;
		for (const org of [A, B] as const) {
			const name = ROSTER[org];
			const agentId = agents[`${org}/${name}`];
			const stamp = { orgId: org, clerkOrgId: testClerkOrgId(org) };
			const mission = await ctx.db.insert("missions", {
				name: `${MARK[org]} mission`,
				project: `${MARK[org]}-project`,
				status: "execute",
				priority: "medium",
				agents: [name],
				pilot: name,
				pilotId: agentId,
				agentIds: [agentId],
				createdBy: name,
				createdAt: now,
				updatedAt: now,
				...stamp,
			} as never);
			const task = await ctx.db.insert("tasks", {
				title: `${MARK[org]} task`,
				assignedTo: name,
				assignedToId: agentId,
				priority: "medium",
				status: "todo",
				missionId: mission,
				createdBy: name,
				createdAt: now,
				updatedAt: now,
				...stamp,
			} as never);
			const memory = await ctx.db.insert("memories", {
				namespace: `team/${testClerkOrgId(org)}`,
				type: "project",
				content: `${MARK[org]} memory`,
				createdBy: name,
				relations: [],
				isLatest: true,
				createdAt: now,
				updatedAt: now,
				clerkOrgId: testClerkOrgId(org),
			} as never);
			await ctx.db.insert("diary", {
				date: "2026-11-01",
				orchestrator: name,
				content: `${MARK[org]} diary`,
				createdAt: now,
				...stamp,
			} as never);
			const note = await ctx.db.insert("briefingNotes", {
				title: `${MARK[org]} note`,
				topic: "t",
				participants: [name],
				content: `${MARK[org]} note body`,
				createdBy: name,
				createdAt: now,
				...stamp,
			} as never);
			const recurring = await ctx.db.insert("recurringTasks", {
				title: `${MARK[org]} recurring`,
				assignedTo: name,
				assignedToId: agentId,
				priority: "medium",
				cronExpression: "0 9 * * *",
				nextRunAt: now + 1000,
				active: true,
				createdBy: name,
				createdAt: now,
				updatedAt: now,
				...stamp,
			} as never);
			const mandate = await ctx.db.insert("mandates", {
				service: `${MARK[org]} service`,
				budget: 100,
				status: "accepted",
				requestedBy: name,
				fulfilledBy: name,
				requestedById: agentId,
				fulfilledById: agentId,
				createdAt: now,
				updatedAt: now,
			} as never);
			const pattern = await ctx.db.insert("fixPatterns", {
				symptom: `${MARK[org]} symptom`,
				rootCause: "rc",
				tags: [],
				stack: [],
				sourceProject: `${MARK[org]}-project`,
				createdBy: name,
				severity: "minor",
				createdAt: now,
				updatedAt: now,
			} as never);
			const message = await ctx.db.insert("messages", {
				from: name,
				channel: "broadcast",
				content: `${MARK[org]} message`,
				createdAt: now,
				tenantId: org,
				tenantOrgId: testClerkOrgId(org),
			} as never);
			await ctx.db.insert("githubOwnerBindings", {
				owner: `${org}-owner`,
				orgId: org,
				installationId: org === A ? 1 : 2,
				accountType: "Organization",
				githubUserLogin: `${MARK[org]}-login`,
				boundBy: `member-of-${org}`,
				boundAt: now,
				active: true,
			} as never);
			await ctx.db.insert("githubRepoMapping", {
				repo: `${org}/${MARK[org]}-repo`,
				orchestrator: name,
				project: `${MARK[org]}-project`,
				active: true,
				...stamp,
			} as never);
			await ctx.db.insert("profiles", {
				orchestratorId: name,
				name: `${MARK[org]} ${name}`,
				instanceId: `${name}-${org}`,
				static: { role: "r", workspace: "w", capabilities: [] },
				dynamic: { lastSeen: now, sessionCount: 1 },
			} as never);
			out[org] = {
				task,
				mission,
				memory,
				note,
				recurring,
				mandate,
				pattern,
				message,
				agent: agentId,
			};
		}
		return out;
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// The read doors of the sweep's LEAK rows, by family. `args(s)` builds the
// arguments that ADDRESS org B's row where the door takes an ID (so isolation
// means "B's row is not served"); `servesOwn` is true where an A member is
// served its own A row by the A-addressed form `ownArgs`.
// ─────────────────────────────────────────────────────────────────────────────

type ReadDoor = {
	family: string;
	door: string;
	ref: Ref;
	/** Arguments naming nothing of either org, or org B's row by ID. */
	args: (s: Seeded) => Record<string, unknown>;
	/** Arguments naming org A's own row by ID (defaults to `args`). */
	ownArgs?: (s: Seeded) => Record<string, unknown>;
};

const READ_DOORS: ReadDoor[] = [
	// tasks
	{ family: "tasks", door: "tasks:getById", ref: api.tasks.getById as Ref, args: (s) => ({ taskId: s[B].task }), ownArgs: (s) => ({ taskId: s[A].task }) },
	{ family: "tasks", door: "tasks:listByMission", ref: api.tasks.listByMission as Ref, args: (s) => ({ missionId: s[B].mission }), ownArgs: (s) => ({ missionId: s[A].mission }) },
	// messages
	{ family: "messages", door: "messages:listMessages", ref: api.messages.listMessages as Ref, args: () => ({}) },
	{ family: "messages", door: "messages:getById", ref: api.messages.getById as Ref, args: (s) => ({ messageId: s[B].message }), ownArgs: (s) => ({ messageId: s[A].message }) },
	// memories / episodes
	{ family: "memories", door: "memories:getMemory", ref: api.memories.getMemory as Ref, args: (s) => ({ memoryId: s[B].memory }), ownArgs: (s) => ({ memoryId: s[A].memory }) },
	{ family: "memories", door: "memories:listMemories", ref: api.memories.listMemories as Ref, args: () => ({ namespace: `team/${B_ID}` }), ownArgs: () => ({ namespace: `team/${A_ID}` }) },
	{ family: "episodes", door: "memories:listMemories(episode)", ref: api.memories.listMemories as Ref, args: () => ({ namespace: `team/${B_ID}`, type: "episode" }) },
	// missions
	{ family: "missions", door: "missions:list", ref: api.missions.list as Ref, args: () => ({}) },
	{ family: "missions", door: "missions:get", ref: api.missions.get as Ref, args: (s) => ({ missionId: s[B].mission }), ownArgs: (s) => ({ missionId: s[A].mission }) },
	// mandates
	{ family: "mandates", door: "mandates:list", ref: api.mandates.list as Ref, args: () => ({}) },
	{ family: "mandates", door: "mandates:get", ref: api.mandates.get as Ref, args: (s) => ({ mandateId: s[B].mandate }) },
	{ family: "mandates", door: "mandates:validateSpending", ref: api.mandates.validateSpending as Ref, args: (s) => ({ mandateId: s[B].mandate, proposedAmount: 1 }) },
	// diaries
	{ family: "diaries", door: "diary:list", ref: api.diary.list as Ref, args: () => ({}) },
	{ family: "diaries", door: "diary:get", ref: api.diary.get as Ref, args: () => ({ date: "2026-11-01", orchestrator: ROSTER[B] }), ownArgs: () => ({ date: "2026-11-01", orchestrator: ROSTER[A] }) },
	// briefing notes
	{ family: "briefing notes", door: "briefingNotes:get", ref: api.briefingNotes.get as Ref, args: (s) => ({ noteId: s[B].note }), ownArgs: (s) => ({ noteId: s[A].note }) },
	{ family: "briefing notes", door: "briefingNotes:list", ref: api.briefingNotes.list as Ref, args: () => ({}) },
	// github bindings / repo mappings
	{ family: "github bindings", door: "githubOwnerBinding:listBindings", ref: api.githubOwnerBinding.listBindings as Ref, args: () => ({}) },
	{ family: "github bindings", door: "githubRepoMapping:getByRepo", ref: api.githubRepoMapping.getByRepo as Ref, args: () => ({ repo: `${B}/${MARK[B]}-repo` }), ownArgs: () => ({ repo: `${A}/${MARK[A]}-repo` }) },
	// recurring tasks
	{ family: "recurring tasks", door: "recurringTasks:list", ref: api.recurringTasks.list as Ref, args: () => ({}) },
	{ family: "recurring tasks", door: "recurringTasks:getById", ref: api.recurringTasks.getById as Ref, args: (s) => ({ recurringTaskId: s[B].recurring }), ownArgs: (s) => ({ recurringTaskId: s[A].recurring }) },
	// fix patterns
	{ family: "fix patterns", door: "fixPatterns:listAll", ref: api.fixPatterns.listAll as Ref, args: () => ({}) },
	{ family: "fix patterns", door: "fixPatterns:get", ref: api.fixPatterns.get as Ref, args: (s) => ({ patternId: s[B].pattern }) },
	{ family: "fix patterns", door: "fixPatterns:listByProject", ref: api.fixPatterns.listByProject as Ref, args: () => ({ sourceProject: `${MARK[B]}-project` }) },
	// peers
	{ family: "peers", door: "profiles:listProfiles", ref: api.profiles.listProfiles as Ref, args: () => ({}) },
];

for (const d of READ_DOORS) {
	describe(`[${d.family}] ${d.door}`, () => {
		test("ISOLATION + EQUIVALENCE: the acting call never returns an org-B row and is answered as an org-A member", async () => {
			const t = createT();
			const s = await seed(t);
			const acting = await call(asService(t), "query", d.ref, actingArgs(d.args(s), A));
			const member = await call(asMember(t, A), "query", d.ref, d.args(s));
			expect(json(acting)).not.toContain(MARK[B]);
			expect(acting).toEqual(member);
		});

		test("OWN ROWS: what an org-A member is served of its own rows, the acting call is served", async () => {
			const t = createT();
			const s = await seed(t);
			const own = d.ownArgs ?? d.args;
			const acting = await call(asService(t), "query", d.ref, actingArgs(own(s), A));
			const member = await call(asMember(t, A), "query", d.ref, own(s));
			expect(acting).toEqual(member);
			expect(json(acting).includes(MARK[A])).toBe(json(member).includes(MARK[A]));
		});

		test("NO IMPERSONATION: a member of B naming org A is answered as that member of B", async () => {
			const t = createT();
			const s = await seed(t);
			const own = d.ownArgs ?? d.args;
			const bPlain = await call(asMember(t, B), "query", d.ref, d.args(s));
			const bNamingA = await call(asMember(t, B), "query", d.ref, actingArgs(d.args(s), A));
			expect(bNamingA).toEqual(bPlain);
			const bNamingAOwn = await call(asMember(t, B), "query", d.ref, actingArgs(own(s), A));
			expect(json(bNamingAOwn)).not.toContain(MARK[A]);
		});
	});
}

// The master pole, stated where the fleet answer is observable: the service
// account without the argument still reads org B's rows.
describe("MASTER UNCHANGED: the fleet service account without __actingOrg still reads every org", () => {
	test("tasks:getById, missions:get, memories:getMemory, mandates:get serve org B's row to the fleet", async () => {
		const t = createT();
		const s = await seed(t);
		const svc = asService(t);
		for (const [ref, args] of [
			[api.tasks.getById, { taskId: s[B].task }],
			[api.missions.get, { missionId: s[B].mission }],
			[api.memories.getMemory, { memoryId: s[B].memory }],
			[api.mandates.get, { mandateId: s[B].mandate }],
		] as const) {
			const o = await call(svc, "query", ref as Ref, args);
			expect(json(o)).toContain(MARK[B]);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

describe("[memories/episodes] writes", () => {
	test("memories:storeMemory acting for A cannot write into B's namespace; into A's it stamps A", async () => {
		const t = createT();
		const svc = asService(t);
		await seed(t);
		const intoB = await call(svc, "mutation", api.memories.storeMemory as Ref, actingArgs({ namespace: `team/${B_ID}`, type: "project", content: "x", createdBy: ROSTER[A] }, A));
		expect(intoB.ok).toBe(false);
		const intoA = await call(svc, "mutation", api.memories.storeMemory as Ref, actingArgs({ namespace: `team/${A_ID}`, type: "project", content: "own", createdBy: ROSTER[A] }, A));
		expect(intoA.ok).toBe(true);
		const row = await t.run(async (ctx) => ctx.db.get((intoA as { value: Id<"memories"> }).value));
		expect(row?.clerkOrgId).toBe(A_ID);
		await drain(t);
	});

	test("episodes:storeEpisode acting for A cannot write into B's namespace", async () => {
		const t = createT();
		await seed(t);
		const o = await call(asService(t), "mutation", api.episodes.storeEpisode as Ref, actingArgs({ namespace: `team/${B_ID}`, createdBy: ROSTER[A], context: "c", goal: "g", action: "a", outcome: "o", insight: "i", severity: "minor" }, A));
		expect(o.ok).toBe(false);
		await drain(t);
	});
});

describe("[recurring tasks] writes", () => {
	test("recurringTasks:update acting for A cannot change B's row", async () => {
		const t = createT();
		const s = await seed(t);
		await call(asService(t), "mutation", api.recurringTasks.update as Ref, actingArgs({ recurringTaskId: s[B].recurring, title: "hijacked" }, A));
		const row = await t.run(async (ctx) => ctx.db.get(s[B].recurring));
		expect(row?.title).toBe(`${MARK[B]} recurring`);
		await drain(t);
	});
});

describe("[mandates] fleet-only doors refuse the acting call", () => {
	test("mandates:create and mandates:validateSpending are fleet-only: the acting call is refused RBAC_DENIED", async () => {
		const t = createT();
		const s = await seed(t);
		const svc = asService(t);
		const create = await call(svc, "mutation", api.mandates.create as Ref, actingArgs({ requestedBy: ROSTER[A], service: "s", budget: 1 }, A));
		expect(create).toEqual({ ok: false, code: "RBAC_DENIED" });
		const spend = await call(svc, "query", api.mandates.validateSpending as Ref, actingArgs({ mandateId: s[B].mandate, proposedAmount: 1 }, A));
		expect(spend).toEqual({ ok: false, code: "RBAC_DENIED" });
	});
});

describe("[briefing notes] writes", () => {
	test("briefingNotes:update acting for A cannot change B's note", async () => {
		const t = createT();
		const s = await seed(t);
		await call(asService(t), "mutation", api.briefingNotes.update as Ref, actingArgs({ noteId: s[B].note, callerOrchestrator: ROSTER[A], title: "hijacked" }, A));
		const row = await t.run(async (ctx) => ctx.db.get(s[B].note));
		expect(row?.title).toBe(`${MARK[B]} note`);
		await drain(t);
	});
});

describe("[fix patterns] writes", () => {
	test("fixPatterns:create acting for A is answered as an org-A member, and B's reader never sees it", async () => {
		const t = createT();
		await seed(t);
		const args = { symptom: "acting-created", rootCause: "r", tags: [], stack: [], sourceProject: "p", createdBy: ROSTER[A], severity: "minor" };
		const acting = await call(asService(t), "mutation", api.fixPatterns.create as Ref, actingArgs(args, A));
		const member = await call(asMember(t, A), "mutation", api.fixPatterns.create as Ref, args);
		expect(acting.ok).toBe(member.ok);
		if (!acting.ok && !member.ok) expect(acting.code).toBe(member.code);
		await drain(t);
	});
});

describe("[tasks] bulk run status", () => {
	test("tasks:getBulkCompleteRun acting for A does not serve B's run", async () => {
		const t = createT();
		await seed(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("bulk_complete_runs", {
				bulkRunId: "run-b",
				orgId: B,
				clerkOrgId: B_ID,
				createdBy: ROSTER[B],
				status: "complete",
				closed: 3,
				remaining: false,
				startedAt: 1,
				updatedAt: 1,
			});
		});
		const o = await call(asService(t), "query", api.tasks.getBulkCompleteRun as Ref, actingArgs({ bulkRunId: "run-b" }, A));
		expect(o.ok && o.value !== null).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The identity layer itself
// ─────────────────────────────────────────────────────────────────────────────

describe("the acting org is resolved by the identity layer", () => {
	test("an inactive or unmapped acting org is REFUSED RBAC_DENIED, never served as the fleet", async () => {
		const t = createT();
		const s = await seed(t);
		await t.run(async (ctx) => {
			const b = await ctx.db
				.query("client_org_mapping")
				.withIndex("by_clerk_slug", (q) => q.eq("clerkOrgSlug", B))
				.unique();
			if (b) await ctx.db.patch(b._id, { isActive: false });
		});
		const inactive = await call(asService(t), "query", api.tasks.getById as Ref, actingArgs({ taskId: s[B].task }, B));
		expect(inactive).toEqual({ ok: false, code: "RBAC_DENIED" });
		const unmapped = await call(asService(t), "query", api.tasks.getById as Ref, { taskId: s[A].task, __actingOrg: "org_Tnobody" });
		expect(unmapped).toEqual({ ok: false, code: "RBAC_DENIED" });
	});

	test("the action scope bridge resolves the acting org as an ordinary member", async () => {
		const t = createT();
		await seed(t);
		const scope = await asService(t).query(
			internal.lib.auth.resolveOrgScopeForAction,
			{ actingOrg: A_ID } as never,
		);
		expect(scope).toMatchObject({ isMaster: false, fleetWide: false, orgSlug: A, orgClerkId: A_ID, refused: false });
		const fleet = await asService(t).query(internal.lib.auth.resolveOrgScopeForAction, {});
		expect(fleet).toMatchObject({ isMaster: true, fleetWide: true });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The proofs the MCP forwards beside the acting org still hold, and are bound
// to it: a seat writes as its verified agent in its own org; a proof naming
// ANOTHER org than the acting one is refused.
// ─────────────────────────────────────────────────────────────────────────────

describe("transport proofs under the acting org", () => {
	const taskArgs = (s: Seeded, org: Org) => ({
		title: "acting task",
		assignedTo: ROSTER[A],
		priority: "medium",
		status: "todo",
		createdBy: ROSTER[A],
		verifiedActor: { agentId: s[A].agent, orgSlug: A },
		verifiedOrg: { orgSlug: org },
	});

	test("tasks:create with the seat's verifiedActor + verifiedOrg of the acting org is stored in that org", async () => {
		const t = createT();
		const s = await seed(t);
		const o = await call(asService(t), "mutation", api.tasks.create as Ref, actingArgs(taskArgs(s, A), A));
		expect(o.ok).toBe(true);
		const value = (o as { value: unknown }).value;
		const taskId = (typeof value === "string" ? value : (value as { taskId: string }).taskId) as Id<"tasks">;
		const row = await t.run(async (ctx) => ctx.db.get(taskId));
		expect(row?.clerkOrgId).toBe(A_ID);
		await drain(t);
	});

	test("a verifiedOrg naming another org than the acting one is refused", async () => {
		const t = createT();
		const s = await seed(t);
		const o = await call(asService(t), "mutation", api.tasks.create as Ref, actingArgs(taskArgs(s, B), A));
		expect(o).toEqual({ ok: false, code: "RBAC_DENIED" });
		await drain(t);
	});

	test("a verifiedActor of another org than the acting one is refused", async () => {
		const t = createT();
		const s = await seed(t);
		const o = await call(asService(t), "mutation", api.tasks.create as Ref, actingArgs({
			title: "acting task",
			assignedTo: ROSTER[B],
			priority: "medium",
			status: "todo",
			createdBy: ROSTER[B],
			verifiedActor: { agentId: s[B].agent, orgSlug: B },
		}, A));
		expect(o.ok).toBe(false);
		await drain(t);
	});
});
