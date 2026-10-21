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
 * error and nothing is written. An ID and a name that name different agents are
 * refused (AGENT_IDENTITY_MISMATCH). A proven caller's fromAgentId must be the
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
};

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
		await ctx.db.insert("profiles", {
			orchestratorId: "pi",
			name: "pi",
			static: { role: "pi", workspace: "w", capabilities: [] },
			dynamic: { lastSeen: 1, sessionCount: 1 },
		});
		return { orgSlug: op.clerkOrgSlug, foreignSigma, retired, deleted };
	});
	return { t, sigma: ids.sigma, pi: ids.pi, ...seeded };
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
	test("BACKEND_CONTRACT_VERSION is 2", () => {
		expect(BACKEND_CONTRACT_VERSION).toBe(2);
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
	test("ID REFUSE: an agent of another organisation -> coded RBAC_DENIED, zero writes", async () => {
		const w = await world();
		expect(await create(w, { assignedToAgentId: w.foreignSigma })).toBe("RBAC_DENIED");
		expect(await taskRows(w.t)).toHaveLength(0);
	});
	test("ID REFUSE: an unknown (deleted) ID -> coded refusal, zero writes", async () => {
		const w = await world();
		expect(await create(w, { assignedToAgentId: w.deleted })).toBe("RBAC_DENIED");
		expect(await taskRows(w.t)).toHaveLength(0);
	});
	test("ID REFUSE: an inactive agent -> coded refusal, zero writes", async () => {
		const w = await world();
		expect(await create(w, { assignedToAgentId: w.retired })).toBe("RBAC_DENIED");
		expect(await taskRows(w.t)).toHaveLength(0);
	});
	test("BOTH-MISMATCH REFUSE: the ID names sigma, the name names pi -> AGENT_IDENTITY_MISMATCH, zero writes, not counted", async () => {
		const w = await world();
		expect(
			await create(w, { assignedTo: "pi", assignedToAgentId: w.sigma }),
		).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await taskRows(w.t)).toHaveLength(0);
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
			"RBAC_DENIED",
		);
		expect((await rowOf(w, id))?.assignedTo).toBe("sigma");
	});
	test("ID REFUSE: unknown and inactive IDs -> coded refusal, the task is unchanged", async () => {
		const w = await world();
		const id = await seedTask(w);
		expect(await reassign(w, id, { assignedToAgentId: w.deleted })).toBe("RBAC_DENIED");
		expect(await reassign(w, id, { assignedToAgentId: w.retired })).toBe("RBAC_DENIED");
		expect((await rowOf(w, id))?.assignedTo).toBe("sigma");
	});
	test("BOTH-MISMATCH REFUSE: name pi, ID sigma -> AGENT_IDENTITY_MISMATCH, unchanged", async () => {
		const w = await world();
		const id = await seedTask(w);
		expect(
			await reassign(w, id, { assignedTo: "sigma", assignedToAgentId: w.pi }),
		).toBe("AGENT_IDENTITY_MISMATCH");
		expect((await rowOf(w, id))?.assignedTo).toBe("sigma");
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
	test("ID REFUSE: another organisation's / unknown / inactive agent -> coded refusal, zero writes", async () => {
		const w = await world();
		for (const id of [w.foreignSigma, w.deleted, w.retired]) {
			expect(await create(w, { fulfilledByAgentId: id })).toBe("RBAC_DENIED");
		}
		expect(await mandateRows(w.t)).toHaveLength(0);
	});
	test("BOTH-MISMATCH REFUSE: name pi, ID sigma -> AGENT_IDENTITY_MISMATCH, zero writes", async () => {
		const w = await world();
		expect(
			await create(w, { fulfilledBy: "pi", fulfilledByAgentId: w.sigma }),
		).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await mandateRows(w.t)).toHaveLength(0);
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
		for (const id of [w.foreignSigma, w.deleted, w.retired]) {
			expect(
				await send(w, { fromAgentId: id, recipientAgentIds: [w.pi] }),
			).toBe("RBAC_DENIED");
		}
		expect(await messageRows(w.t)).toHaveLength(0);
	});
	test("BOTH-MISMATCH REFUSE: from pi, fromAgentId sigma -> AGENT_IDENTITY_MISMATCH, zero messages", async () => {
		const w = await world();
		expect(
			await send(w, {
				from: "pi",
				fromAgentId: w.sigma,
				recipientAgentIds: [w.pi],
			}),
		).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await messageRows(w.t)).toHaveLength(0);
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
				channel: "pi",
				verifiedActor: { agentId: w.sigma, orgSlug: w.orgSlug },
			}),
		).toBe("AGENT_IDENTITY_MISMATCH");
		expect(await messageRows(w.t)).toHaveLength(0);
	});
	test("PROVEN caller with its OWN fromAgentId sends under the row's label", async () => {
		const w = await world();
		expect(
			await send(w, {
				fromAgentId: w.sigma,
				channel: "pi",
				verifiedActor: { agentId: w.sigma, orgSlug: w.orgSlug },
			}),
		).toBe("NO_ERROR");
		expect((await messageRows(w.t))[0]?.from).toBe("sigma");
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
