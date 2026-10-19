/// <reference types="vite/client" />
//
// VantagePeers Cloud — task k1778c2hvae8e8vz9f5bbbbbb98g62hw item 3 (EXPAND ONLY).
// An agent can carry the person who owns it, BY ID (`agents.ownerPersonId`, a Clerk
// user ID). Two operator doors store and list that ID: `agents:setAgentOwner` and
// `agents:listAgentsWithoutOwner`. Nothing refuses an agent without an owner and no
// request path reads the field yet.
//
// Poles:
//   SET       two agents get the owner in one call; a replay is changed:false, no write;
//             replace === true moves an agent from one person to another.
//   REFUSED   a different owner without replace (OWNER_CONFLICT), an inactive or unknown
//             agent, a malformed owner ID, a short reason, a batch of 0 or 101: each
//             refusal names its code and writes NOTHING (all-or-nothing).
//   LIST      only active agents with no owner, and the list shrinks after a set.

import { describe, expect, test } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);

const createT = () => convexTest(schema, modules);
type T = ReturnType<typeof createT>;

const REASON = "owner backfill for the expand step";
const ALICE = "user_2abcALICE";
const BOB = "user_2abcBOB";

async function seed(t: T) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const agent = (
			orgSlug: string,
			name: string,
			extra: { isActive?: boolean; ownerPersonId?: string; kind?: "agent" | "service" } = {},
		) =>
			ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: `org_${orgSlug}`,
				name,
				normalizedName: name,
				isActive: extra.isActive ?? true,
				createdAt: now,
				...(extra.ownerPersonId ? { ownerPersonId: extra.ownerPersonId } : {}),
				...(extra.kind ? { kind: extra.kind } : {}),
			});
		const a1 = await agent("acme", "clio");
		const a2 = await agent("acme", "marie");
		const inactive = await agent("acme", "old", { isActive: false });
		const owned = await agent("beta", "nadia", { ownerPersonId: BOB });
		const svc = await agent("beta", "svc", { kind: "service" });
		const gone = await agent("beta", "gone");
		await ctx.db.delete(gone);
		return { a1, a2, inactive, owned, svc, gone };
	});
}

const rows = (t: T) =>
	t.run(async (ctx) => (await ctx.db.query("agents").collect()).map((r) => ({ ...r })));

const setOwner = (
	t: T,
	over: Partial<{
		agentIds: Id<"agents">[];
		ownerPersonId: string;
		reason: string;
		replace: boolean;
	}> & { agentIds: Id<"agents">[] },
) =>
	t.mutation(internal.agents.setAgentOwner, {
		ownerPersonId: ALICE,
		reason: REASON,
		...over,
	});

const refusedWith = async (p: Promise<unknown>, code: string, mention?: string) => {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).not.toBeNull();
	const data = String((err as { data?: unknown }).data ?? err);
	expect(data).toContain(code);
	if (mention) expect(data).toContain(mention);
};

describe("agents:setAgentOwner — set", () => {
	test("sets the owner on two agents and reports previous/current/changed", async () => {
		const t = createT();
		const s = await seed(t);
		const r = await setOwner(t, { agentIds: [s.a1, s.a2] });
		expect(r.results).toEqual([
			{ agentId: s.a1, previous: null, current: ALICE, changed: true },
			{ agentId: s.a2, previous: null, current: ALICE, changed: true },
		]);
		const all = await rows(t);
		expect(all.find((x) => x._id === s.a1)?.ownerPersonId).toBe(ALICE);
		expect(all.find((x) => x._id === s.a2)?.ownerPersonId).toBe(ALICE);
		expect(all.find((x) => x._id === s.owned)?.ownerPersonId).toBe(BOB);
	});

	test("the same owner again is changed:false and writes nothing", async () => {
		const t = createT();
		const s = await seed(t);
		await setOwner(t, { agentIds: [s.a1] });
		const before = await rows(t);
		const r = await setOwner(t, { agentIds: [s.a1] });
		expect(r.results).toEqual([
			{ agentId: s.a1, previous: ALICE, current: ALICE, changed: false },
		]);
		expect(await rows(t)).toEqual(before);
	});

	test("a different owner is refused without replace and accepted with replace", async () => {
		const t = createT();
		const s = await seed(t);
		const before = await rows(t);
		await refusedWith(setOwner(t, { agentIds: [s.owned] }), "OWNER_CONFLICT", s.owned);
		expect(await rows(t)).toEqual(before);
		const r = await setOwner(t, { agentIds: [s.owned], replace: true });
		expect(r.results).toEqual([
			{ agentId: s.owned, previous: BOB, current: ALICE, changed: true },
		]);
		expect((await rows(t)).find((x) => x._id === s.owned)?.ownerPersonId).toBe(ALICE);
	});
});

describe("agents:setAgentOwner — refusals write nothing", () => {
	test("a conflict on the second agent leaves the first untouched", async () => {
		const t = createT();
		const s = await seed(t);
		const before = await rows(t);
		await refusedWith(setOwner(t, { agentIds: [s.a1, s.owned] }), "OWNER_CONFLICT");
		expect(await rows(t)).toEqual(before);
	});

	test("an inactive agent is AGENT_INACTIVE, naming the id", async () => {
		const t = createT();
		const s = await seed(t);
		const before = await rows(t);
		await refusedWith(setOwner(t, { agentIds: [s.a1, s.inactive] }), "AGENT_INACTIVE", s.inactive);
		expect(await rows(t)).toEqual(before);
	});

	test("an unknown (deleted) agent is AGENT_NOT_FOUND, naming the id", async () => {
		const t = createT();
		const s = await seed(t);
		const before = await rows(t);
		await refusedWith(setOwner(t, { agentIds: [s.a1, s.gone] }), "AGENT_NOT_FOUND", s.gone);
		expect(await rows(t)).toEqual(before);
	});

	test("a malformed owner id is OWNER_PERSON_ID_INVALID", async () => {
		const t = createT();
		const s = await seed(t);
		const before = await rows(t);
		for (const bad of ["alice", "user_", "user_a-b", "org_123", " user_abc", "user_abc\n"]) {
			await refusedWith(setOwner(t, { agentIds: [s.a1], ownerPersonId: bad }), "OWNER_PERSON_ID_INVALID");
		}
		expect(await rows(t)).toEqual(before);
	});

	test("a reason shorter than 10 characters once trimmed is OWNER_REASON_REQUIRED", async () => {
		const t = createT();
		const s = await seed(t);
		const before = await rows(t);
		await refusedWith(setOwner(t, { agentIds: [s.a1], reason: "   short   " }), "OWNER_REASON_REQUIRED");
		expect(await rows(t)).toEqual(before);
	});

	test("batch bounds: 0 and 101 ids are AGENT_OWNER_BATCH_INVALID; 100 is accepted", async () => {
		const t = createT();
		const s = await seed(t);
		const before = await rows(t);
		await refusedWith(setOwner(t, { agentIds: [] }), "AGENT_OWNER_BATCH_INVALID");
		await refusedWith(
			setOwner(t, { agentIds: Array.from({ length: 101 }, () => s.a1) }),
			"AGENT_OWNER_BATCH_INVALID",
		);
		expect(await rows(t)).toEqual(before);
		const r = await setOwner(t, { agentIds: Array.from({ length: 100 }, () => s.a1) });
		expect(r.results).toHaveLength(100);
		expect((await rows(t)).find((x) => x._id === s.a1)?.ownerPersonId).toBe(ALICE);
	});
});

describe("agents:listAgentsWithoutOwner", () => {
	test("lists only unowned active agents, labels included, and shrinks after a set", async () => {
		const t = createT();
		const s = await seed(t);
		const first = await t.query(internal.agents.listAgentsWithoutOwner, {});
		expect(first.map((x) => x.agentId).sort()).toEqual([s.a1, s.a2, s.svc].sort());
		const clio = first.find((x) => x.agentId === s.a1);
		expect(clio).toEqual({
			agentId: s.a1,
			orgSlug: "acme",
			clerkOrgId: "org_acme",
			name: "clio",
			kind: null,
		});
		expect(first.find((x) => x.agentId === s.svc)?.kind).toBe("service");

		await setOwner(t, { agentIds: [s.a1] });
		const second = await t.query(internal.agents.listAgentsWithoutOwner, {});
		expect(second.map((x) => x.agentId).sort()).toEqual([s.a2, s.svc].sort());
	});

	test("an agent with no clerkOrgId lists clerkOrgId null", async () => {
		const t = createT();
		const id = await t.run((ctx) =>
			ctx.db.insert("agents", { orgSlug: "legacy", name: "old", isActive: true, createdAt: 1 }),
		);
		const r = await t.query(internal.agents.listAgentsWithoutOwner, {});
		expect(r).toEqual([{ agentId: id, orgSlug: "legacy", clerkOrgId: null, name: "old", kind: null }]);
	});

	test("more than 2000 agents is refused AGENT_SCAN_CAP_EXCEEDED, not a short list", async () => {
		const t = createT();
		await t.run(async (ctx) => {
			for (let i = 0; i < 2001; i++) {
				await ctx.db.insert("agents", {
					orgSlug: "big",
					name: `a${i}`,
					isActive: true,
					createdAt: 1,
				});
			}
		});
		await refusedWith(t.query(internal.agents.listAgentsWithoutOwner, {}), "AGENT_SCAN_CAP_EXCEEDED");
	});
});
