/// <reference types="vite/client" />
// allow-missing-refs: new test file created by the specialist
/**
 * Identity-zero slice 2b (task k1778c2hvae8e8vz9f5bbbbbb98g62hw): the doors that
 * took an agent NAME now also take the agent's ID, additively.
 *
 *   messages:sendMessage   fromAgentId        (recipientAgentIds already exists)
 *   tasks:create / update  assignedToAgentId
 *   mandates:create        fulfilledByAgentId
 *
 * An ID is resolved BY ID inside the organisation the write lives in; another
 * org's agent, an unknown ID and an inactive agent are refused with a coded
 * error and nothing is written. When an ID is given it alone decides: a name beside it, even
 * the name of a different agent, is ignored and the call is not counted. A proven caller's fromAgentId must be the
 * proven agent. A call that names an agent by NAME alone still works and is
 * COUNTED, read-only, in `nameOnlyCalls`; the ID path is not counted. The counter
 * is a measurement: it never changes what a door does.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { seedFleetAgents } from "../../tests/lib/seedFleetAgents";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { BACKEND_CONTRACT_VERSION } from "../lib/backendManifest";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) =>
			!path.includes("ragSync") &&
			!path.includes("search") &&
			!path.includes("backfill"),
	),
);

type T = ReturnType<typeof convexTest>;
const createT = (): T =>
	convexTest(schema, modules) as unknown as ReturnType<typeof convexTest>;
const svc = (t: T) => t.withIdentity({ subject: "test-service-account-user-id" });

const CLIENT_ORG = "acme";

type World = {
	t: T;
	orgSlug: string;
	sigma: Id<"agents">;
	pi: Id<"agents">;
	foreignSigma: Id<"agents">; // an active agent of ANOTHER organisation
	retired: Id<"agents">; // an inactive agent of the operator org
	deleted: Id<"agents">; // a well-formed ID whose row no longer exists
	quillA: Id<"agents">; // an agent of a client org with a roster, for the proven pole
	peerA: Id<"agents">; // on org-a's roster
	strangerA: Id<"agents">; // active in org-a, NOT on its roster
};

const ORG_A = "org-a";

async function world(): Promise<World> {
	const t = createT();
	const ids = await seedFleetAgents(t, ["sigma", "pi"]);
	const seeded = await t.run(async (ctx) => {
		const op = (await ctx.db.query("client_org_mapping").collect()).find(
			(m) => m.orgKind === "operator",
		);
		if (op === undefined) throw new Error("fixture: no operator org");
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: CLIENT_ORG,
			clerkOrgId: testClerkOrgId(CLIENT_ORG),
			allowedOrchestrators: [],
			scopes: [],
			displayName: CLIENT_ORG,
			isActive: true,
			createdAt: 1,
		});
		const foreignSigma = await ctx.db.insert("agents", {
			orgSlug: CLIENT_ORG,
			clerkOrgId: testClerkOrgId(CLIENT_ORG),
			name: "sigma",
			normalizedName: "sigma",
			isActive: true,
			createdAt: 1,
		});
		const retired = await ctx.db.insert("agents", {
			orgSlug: op.clerkOrgSlug,
			name: "ghost",
			normalizedName: "ghost",
			isActive: false,
			createdAt: 1,
		});
		const deleted = await ctx.db.insert("agents", {
			orgSlug: op.clerkOrgSlug,
			name: "gone",
			normalizedName: "gone",
			isActive: true,
			createdAt: 1,
		});
		await ctx.db.delete(deleted);
		await ctx.db.insert("client_org_mapping", {
			clerkOrgSlug: ORG_A,
			clerkOrgId: testClerkOrgId(ORG_A),
			allowedOrchestrators: ["quill", "peer"],
			scopes: ["view-own-tasks"],
			displayName: ORG_A,
			isActive: true,
			createdAt: 1,
		});
		const inA = (name: string) =>
			ctx.db.insert("agents", {
				orgSlug: ORG_A,
				clerkOrgId: testClerkOrgId(ORG_A),
				name,
				normalizedName: name,
				isActive: true,
				createdAt: 1,
			});
		const quillA = await inA("quill");
		const peerA = await inA("peer");
		const strangerA = await inA("stranger");
		await ctx.db.insert("profiles", {
			orchestratorId: "peer",
			name: "peer",
			static: { role: "peer", workspace: "w", capabilities: [] },
			dynamic: { lastSeen: 1, sessionCount: 1 },
		});
		await ctx.db.insert("profiles", {
			orchestratorId: "pi",
			name: "pi",
			static: { role: "pi", workspace: "w", capabilities: [] },
			dynamic: { lastSeen: 1, sessionCount: 1 },
		});
		return { orgSlug: op.clerkOrgSlug, foreignSigma, retired, deleted, quillA, peerA, strangerA };
	});
	return { t, sigma: ids.sigma, pi: ids.pi, ...seeded };
}

// The refusals of an ID are the package's own coded errors, said by
// requireAssigneeAgentActive (lib/actingPrincipal.ts) and naming the door.
const FOREIGN = "ORG_MISMATCH";
const UNKNOWN = "VERIFIED_ACTOR_UNKNOWN";
const INACTIVE = "VERIFIED_ACTOR_INACTIVE";

async function text(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "NO_ERROR";
	} catch (e) {
		return e instanceof ConvexError ? String(e.data) : String(e);
	}
}

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "NO_ERROR";
	} catch (e) {
		const text = e instanceof ConvexError ? String(e.data) : String(e);
		return text.replace(/^"/, "").split(":")[0] ?? text;
	}
}

// The counter, read through its internal summary over a window of UTC days that
// brackets today (the mutation stamps the real day).
async function counted(t: T, door: string): Promise<number> {
	const day = (offset: number) =>
		new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
	const rows = (await t.query(
		(internal as never as { nameOnlyCalls: { summary: never } }).nameOnlyCalls
			.summary,
		{ fromDay: day(-1), toDay: day(1) } as never,
	)) as Array<{ door: string; count: number }>;
	return rows.find((r) => r.door === door)?.count ?? 0;
}

const taskRows = (t: T) =>
	t.run(async (ctx) => await ctx.db.query("tasks").collect());
const mandateRows = (t: T) =>
	t.run(async (ctx) => await ctx.db.query("mandates").collect());
const messageRows = (t: T) =>
	t.run(async (ctx) => await ctx.db.query("messages").collect());

const taskBase = {
	title: "slice 2b task",
	priority: "low" as const,
	status: "todo" as const,
	createdBy: "pi",
};

// ─────────────────────────────────────────────────────────────────────────────
describe("contract: the manifest says the new args exist", () => {
	test("BACKEND_CONTRACT_VERSION is 3", () => {
		// 3: memberWriterRoles:assertPersonMayWrite takes the verifiedPerson claim
		// instead of an organisation and a role argument (task k177jrz8k2dr7naqe7yzmp0px18g77n5).
		expect(BACKEND_CONTRACT_VERSION).toBe(3);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("tasks:create assignedToAgentId", () => {
	const create = (w: World, extra: Record<string, unknown>) =>
		code(svc(w.t).mutation(api.tasks.create, { ...taskBase, ...extra } as never));

	test("ID ALLOW: ID alone writes that agent; assignedTo is the row's label, assignedToId its ID; not counted", async () => {
		const w = await world();
		expect(await create(w, { assignedToAgentId: w.sigma })).toBe("NO_ERROR");
		const rows = await taskRows(w.t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.assignedTo).toBe("sigma");
		expect(rows[0]?.assignedToId).toBe(w.sigma);
		expect(await counted(w.t, "tasks:create:assignedTo")).toBe(0);
	});
	test("ID ALLOW: ID plus the same name (re-cased) agrees, written under the row's label, not counted", async () => {
		const w = await world();
		expect(
			await create(w, { assignedTo: " SIGMA ", assignedToAgentId: w.sigma }),
		).toBe("NO_ERROR");
		expect((await taskRows(w.t))[0]?.assignedTo).toBe("sigma");
		expect(await counted(w.t, "tasks:create:assignedTo")).toBe(0);
	});
	test("ID REFUSE: an agent of another organisation -> ORG_MISMATCH naming the door, zero writes", async () => {
		const w = await world();
		const msg = await text(
			svc(w.t).mutation(api.tasks.create, {
				...taskBase,
				assignedToAgentId: w.foreignSigma,
			} as never),
		);
		expect(msg).toContain(FOREIGN);
		expect(msg).toContain("tasks:create");
		expect(await taskRows(w.t)).toHaveLength(0);
		expect(await counted(w.t, "tasks:create:assignedTo")).toBe(0);
	});
	test("ID REFUSE: an unknown (deleted) ID -> VERIFIED_ACTOR_UNKNOWN, zero writes", async () => {
		const w = await world();
		expect(await create(w, { assignedToAgentId: w.deleted })).toBe(UNKNOWN);
		expect(await taskRows(w.t)).toHaveLength(0);
	});
	test("ID REFUSE: an inactive agent -> VERIFIED_ACTOR_INACTIVE, zero writes", async () => {
		const w = await world();
		expect(await create(w, { assignedToAgentId: w.retired })).toBe(INACTIVE);
		expect(await taskRows(w.t)).toHaveLength(0);
	});
	test("ID WINS: the ID names sigma, a contradictory name names pi -> sigma is assigned, label stored, not counted", async () => {
		const w = await world();
		expect(
			await create(w, { assignedTo: "pi", assignedToAgentId: w.sigma }),
		).toBe("NO_ERROR");
		const rows = await taskRows(w.t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.assignedTo).toBe("sigma");
		expect(rows[0]?.assignedToId).toBe(w.sigma);
		expect(await counted(w.t, "tasks:create:assignedTo")).toBe(0);
	});
	test("NAME-ONLY unchanged: still creates, stamps the ID, and is COUNTED", async () => {
		const w = await world();
		expect(await create(w, { assignedTo: "sigma" })).toBe("NO_ERROR");
		const rows = await taskRows(w.t);
		expect(rows[0]?.assignedTo).toBe("sigma");
		expect(rows[0]?.assignedToId).toBe(w.sigma);
		expect(await counted(w.t, "tasks:create:assignedTo")).toBe(1);
	});
	test("neither an ID nor a name -> refused, zero writes", async () => {
		const w = await world();
		expect(await create(w, {})).not.toBe("NO_ERROR");
		expect(await taskRows(w.t)).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("tasks:update assignedToAgentId (reassign)", () => {
	const seedTask = async (w: World) =>
		(await svc(w.t).mutation(api.tasks.create, {
			...taskBase,
			assignedTo: "sigma",
		} as never)) as Id<"tasks">;
	const reassign = (w: World, id: Id<"tasks">, extra: Record<string, unknown>) =>
		code(
			svc(w.t).mutation(api.tasks.update, {
				taskId: id,
				callerOrchestrator: "system",
				...extra,
			} as never),
		);
	const rowOf = (w: World, id: Id<"tasks">) =>
		w.t.run(async (ctx) => await ctx.db.get(id));

	test("ID ALLOW: reassigns to the agent by ID; assignedTo is the row's label; not counted", async () => {
		const w = await world();
		const id = await seedTask(w);
		const before = await counted(w.t, "tasks:update:assignedTo");
		expect(await reassign(w, id, { assignedToAgentId: w.pi })).toBe("NO_ERROR");
		const r = await rowOf(w, id);
		expect(r?.assignedTo).toBe("pi");
		expect(r?.assignedToId).toBe(w.pi);
		expect(r?.lastAssignedTo).toBe("sigma");
		expect(await counted(w.t, "tasks:update:assignedTo")).toBe(before);
	});
	test("ID REFUSE: another organisation's agent -> coded refusal, the task is unchanged", async () => {
		const w = await world();
		const id = await seedTask(w);
		expect(await reassign(w, id, { assignedToAgentId: w.foreignSigma })).toBe(
			FOREIGN,
		);
		expect((await rowOf(w, id))?.assignedTo).toBe("sigma");
	});
	test("ID REFUSE: unknown and inactive IDs -> coded refusal, the task is unchanged", async () => {
		const w = await world();
		const id = await seedTask(w);
		expect(await reassign(w, id, { assignedToAgentId: w.deleted })).toBe(UNKNOWN);
		expect(await reassign(w, id, { assignedToAgentId: w.retired })).toBe(INACTIVE);
		expect((await rowOf(w, id))?.assignedTo).toBe("sigma");
	});
	test("ID WINS: contradictory name sigma, ID pi -> reassigned to pi, label stored, not counted", async () => {
		const w = await world();
		const id = await seedTask(w);
		const before = await counted(w.t, "tasks:update:assignedTo");
		expect(
			await reassign(w, id, { assignedTo: "sigma", assignedToAgentId: w.pi }),
		).toBe("NO_ERROR");
		const r = await rowOf(w, id);
		expect(r?.assignedTo).toBe("pi");
		expect(r?.assignedToId).toBe(w.pi);
		expect(await counted(w.t, "tasks:update:assignedTo")).toBe(before);
	});
	test("NAME-ONLY unchanged: reassigns by name and is COUNTED", async () => {
		const w = await world();
		const id = await seedTask(w);
		expect(await reassign(w, id, { assignedTo: "pi" })).toBe("NO_ERROR");
		expect((await rowOf(w, id))?.assignedTo).toBe("pi");
		expect(await counted(w.t, "tasks:update:assignedTo")).toBe(1);
	});
	test("an update that does not touch the assignee is not counted", async () => {
		const w = await world();
		const id = await seedTask(w);
		expect(await reassign(w, id, { priority: "high" })).toBe("NO_ERROR");
		expect(await counted(w.t, "tasks:update:assignedTo")).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The roster rule on the ID path, under a SCOPED caller (not the master bypass):
// an org:admin Clerk session of org-a acting in its own name (no createdBy: the
// human path), whose scope is org-a's with roster ["quill","peer"]. The service
// account is master and skips the roster rule entirely.
describe("assignee by ID is held to the caller's roster (scoped caller)", () => {
	const admin = (w: World) =>
		w.t.withIdentity({
			subject: "user_admin_a",
			org_slug: ORG_A,
			org_id: testClerkOrgId(ORG_A),
			org_role: "org:admin",
		});
	const ROSTER = "assignee-not-on-roster";
	// A human writer needs the role on the writer allowlist (fleet-wide row).
	const seedWriters = (w: World) =>
		w.t.run((ctx) =>
			ctx.db.insert("memberWriterRoles", { roles: ["org:admin"], updatedAt: 1 }),
		);
	const { createdBy: _by, ...humanBase } = taskBase;
	const createAs = (w: World, extra: Record<string, unknown>) =>
		text(admin(w).mutation(api.tasks.create, { ...humanBase, ...extra } as never));
	const updateAs = (w: World, id: Id<"tasks">, extra: Record<string, unknown>) =>
		text(admin(w).mutation(api.tasks.update, { taskId: id, ...extra } as never));
	const ownTask = async (w: World) =>
		(await admin(w).mutation(api.tasks.create, {
			...humanBase,
			assignedTo: "quill",
		} as never)) as Id<"tasks">;

	test("create ALLOW: an on-roster org-a agent by ID is written", async () => {
		const w = await world();
		await seedWriters(w);
		expect(await createAs(w, { assignedToAgentId: w.peerA })).toBe("NO_ERROR");
		const rows = await taskRows(w.t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.assignedTo).toBe("peer");
		expect(rows[0]?.assignedToId).toBe(w.peerA);
	});
	test("create DENY: an active org-a agent NOT on the roster -> roster refusal, zero rows", async () => {
		const w = await world();
		await seedWriters(w);
		const msg = await createAs(w, { assignedToAgentId: w.strangerA });
		expect(msg).toContain("RBAC_DENIED");
		expect(msg).toContain(ROSTER);
		expect(await taskRows(w.t)).toHaveLength(0);
	});
	test("update ALLOW: reassign by ID to an on-roster agent", async () => {
		const w = await world();
		await seedWriters(w);
		const id = await ownTask(w);
		expect(await updateAs(w, id, { assignedToAgentId: w.peerA })).toBe("NO_ERROR");
		expect((await w.t.run((c) => c.db.get(id)))?.assignedTo).toBe("peer");
	});
	test("update DENY: reassign by ID to an off-roster agent -> roster refusal, task unchanged", async () => {
		const w = await world();
		await seedWriters(w);
		const id = await ownTask(w);
		const msg = await updateAs(w, id, { assignedToAgentId: w.strangerA });
		expect(msg).toContain("RBAC_DENIED");
		expect(msg).toContain(ROSTER);
		expect((await w.t.run((c) => c.db.get(id)))?.assignedTo).toBe("quill");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("mandates:create fulfilledByAgentId", () => {
	const base = { requestedBy: "pi", service: "seo audit", budget: 10 };
	const create = (w: World, extra: Record<string, unknown>) =>
		code(svc(w.t).mutation(api.mandates.create, { ...base, ...extra } as never));

	test("ID ALLOW: ID alone; fulfilledBy is the row's label and fulfilledById its ID; not counted", async () => {
		const w = await world();
		expect(await create(w, { fulfilledByAgentId: w.sigma })).toBe("NO_ERROR");
		const rows = await mandateRows(w.t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.fulfilledBy).toBe("sigma");
		expect(rows[0]?.fulfilledById).toBe(w.sigma);
		expect(await counted(w.t, "mandates:create:fulfilledBy")).toBe(0);
	});
	test("ID REFUSE: another organisation's / unknown / inactive agent -> coded refusal (ORG_MISMATCH / UNKNOWN / INACTIVE), zero writes", async () => {
		const w = await world();
		for (const [id, want] of [
			[w.foreignSigma, FOREIGN],
			[w.deleted, UNKNOWN],
			[w.retired, INACTIVE],
		] as const) {
			expect(await create(w, { fulfilledByAgentId: id })).toBe(want);
		}
		expect(await mandateRows(w.t)).toHaveLength(0);
	});
	test("ID WINS: contradictory name pi, ID sigma -> fulfilledBy is sigma, ID stored, not counted", async () => {
		const w = await world();
		expect(
			await create(w, { fulfilledBy: "pi", fulfilledByAgentId: w.sigma }),
		).toBe("NO_ERROR");
		const rows = await mandateRows(w.t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.fulfilledBy).toBe("sigma");
		expect(rows[0]?.fulfilledById).toBe(w.sigma);
		expect(await counted(w.t, "mandates:create:fulfilledBy")).toBe(0);
	});
	test("NAME-ONLY unchanged: still creates and is COUNTED", async () => {
		const w = await world();
		expect(await create(w, { fulfilledBy: "sigma" })).toBe("NO_ERROR");
		expect((await mandateRows(w.t))[0]?.fulfilledBy).toBe("sigma");
		expect(await counted(w.t, "mandates:create:fulfilledBy")).toBe(1);
	});
	test("neither an ID nor a name -> refused, zero writes", async () => {
		const w = await world();
		expect(await create(w, {})).not.toBe("NO_ERROR");
		expect(await mandateRows(w.t)).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("messages:sendMessage fromAgentId", () => {
	const send = (w: World, extra: Record<string, unknown>) =>
		code(
			svc(w.t).mutation(api.messages.sendMessage, {
				content: "hello",
				...extra,
			} as never),
		);

	test("ID ALLOW: fromAgentId alone; the written `from` is the row's label; ID path is not counted", async () => {
		const w = await world();
		expect(
			await send(w, { fromAgentId: w.sigma, recipientAgentIds: [w.pi] }),
		).toBe("NO_ERROR");
		const rows = await messageRows(w.t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.from).toBe("sigma");
		expect(rows[0]?.fromId).toBe(w.sigma);
		expect(await counted(w.t, "messages:sendMessage:from")).toBe(0);
		expect(await counted(w.t, "messages:sendMessage:channel")).toBe(0);
	});
	test("ID REFUSE: another organisation's / unknown / inactive sender -> coded refusal, zero messages", async () => {
		const w = await world();
		for (const [id, want] of [
			[w.foreignSigma, FOREIGN],
			[w.deleted, UNKNOWN],
			[w.retired, INACTIVE],
		] as const) {
			expect(
				await send(w, { fromAgentId: id, recipientAgentIds: [w.pi] }),
			).toBe(want);
		}
		expect(await messageRows(w.t)).toHaveLength(0);
	});
	test("ID WINS: from pi (contradictory), fromAgentId sigma -> sent as sigma, not counted", async () => {
		const w = await world();
		expect(
			await send(w, {
				from: "pi",
				fromAgentId: w.sigma,
				recipientAgentIds: [w.pi],
			}),
		).toBe("NO_ERROR");
		const rows = await messageRows(w.t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.from).toBe("sigma");
		expect(rows[0]?.fromId).toBe(w.sigma);
		expect(await counted(w.t, "messages:sendMessage:from")).toBe(0);
	});
	test("NAME-ONLY unchanged: `from` + `channel` naming an agent still sends, and both are COUNTED", async () => {
		const w = await world();
		expect(await send(w, { from: "sigma", channel: "pi" })).toBe("NO_ERROR");
		expect((await messageRows(w.t))[0]?.from).toBe("sigma");
		expect(await counted(w.t, "messages:sendMessage:from")).toBe(1);
		expect(await counted(w.t, "messages:sendMessage:channel")).toBe(1);
	});
	test("`broadcast` has no ID form and is NOT counted as a name call", async () => {
		const w = await world();
		await send(w, { fromAgentId: w.sigma, channel: "broadcast" });
		expect(await counted(w.t, "messages:sendMessage:channel")).toBe(0);
	});
	test("PROVEN caller (verifiedActor) with a foreign fromAgentId -> AGENT_IDENTITY_MISMATCH, zero messages", async () => {
		const w = await world();
		expect(
			await send(w, {
				fromAgentId: w.pi,
				recipientAgentIds: [w.sigma],
				verifiedActor: { agentId: w.sigma, orgSlug: w.orgSlug },
			}),
		).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await messageRows(w.t)).toHaveLength(0);
	});
	test("UNPROVEN org member naming an agent by ID gets no more than a name would: AGENT_CREDENTIAL_REQUIRED, zero messages", async () => {
		const w = await world();
		const member = w.t.withIdentity({
			subject: "user_member_1",
			org_slug: ORG_A,
			org_id: testClerkOrgId(ORG_A),
			org_role: "org:member",
		});
		const got = await code(
			member.mutation(api.messages.sendMessage, {
				fromAgentId: w.quillA,
				channel: "peer",
				content: "hello",
			} as never),
		);
		expect(got).toBe("AGENT_CREDENTIAL_REQUIRED");
		expect(await messageRows(w.t)).toHaveLength(0);
	});
	test("PROVEN caller with its OWN fromAgentId (no `from`) sends under the row's label", async () => {
		const w = await world();
		expect(
			await send(w, {
				fromAgentId: w.quillA,
				channel: "peer",
				seatOrgSlug: ORG_A,
				verifiedActor: { agentId: w.quillA, orgSlug: ORG_A },
			}),
		).toBe("NO_ERROR");
		const rows = await messageRows(w.t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.from).toBe("quill");
		expect(rows[0]?.fromId).toBe(w.quillA);
		expect(await counted(w.t, "messages:sendMessage:from")).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the counter stores no secret, body or name", () => {
	test("rows carry only door, UTC day, shard and count", async () => {
		const w = await world();
		await svc(w.t).mutation(api.messages.sendMessage, {
			from: "sigma",
			channel: "pi",
			content: "TOP-SECRET-BODY",
		} as never);
		const rows = await w.t.run(async (ctx) =>
			(
				ctx.db as unknown as {
					query: (n: string) => { collect: () => Promise<Record<string, unknown>[]> };
				}
			)
				.query("nameOnlyCalls")
				.collect(),
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const r of rows) {
			const keys = Object.keys(r)
				.filter((k) => !k.startsWith("_"))
				.sort();
			expect(keys).toEqual(["count", "day", "door", "shard"]);
			expect(JSON.stringify(r)).not.toContain("TOP-SECRET-BODY");
		}
	});
});
