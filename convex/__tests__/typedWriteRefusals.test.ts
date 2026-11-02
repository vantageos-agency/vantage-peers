/// <reference types="vite/client" />
//
// Task k1783jwzj5q67fycmtehzgjdw18hexvs (VantagePeers Cloud). Live MCP writes were
// reported as a bare "[Request ID: ...] Server Error". Convex redacts the MESSAGE
// of a ConvexError to that same string, so the log line alone cannot tell a typed
// refusal from a crash; the only discriminator is the thrown VALUE. Each of the
// five live shapes is reproduced here and its value pinned:
//   1,2  store_memory orchestrator/<name> by a client seat   -> RBAC_DENIED (already typed)
//   3    send_message client seat -> fleet coordinator name  -> RBAC_DENIED (was code-less)
//   4    send_message to self / by ID                        -> INVALID_RECIPIENTS / RBAC_DENIED
//   5    send_message fleet master -> fleet + client agent   -> RBAC_DENIED (was code-less)
// Every refusal is pinned with the PRESENT pole beside it: nobody newly served,
// nobody newly refused.
import { readFileSync } from "node:fs";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "../../tests/fixtures/convexTestWithServiceAccount";
import { testClerkOrgId } from "../../tests/fixtures/testClerkOrgId";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = Object.fromEntries(
	Object.entries(import.meta.glob("../**/*.ts")).filter(
		([path]) => !path.includes("ragSync") && !path.includes("backfill"),
	),
);
const createT = () => convexTest(schema, modules);
// Scheduled work (message fan-out, RAG sync) is drained before a test ends, so
// it cannot write after the transaction is gone.
let current: ReturnType<typeof createT> | undefined;
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(async () => {
	if (current) await current.finishAllScheduledFunctions(vi.runAllTimers);
	current = undefined;
	vi.useRealTimers();
});
type T = ReturnType<typeof createT>;
type Identity = Parameters<T["withIdentity"]>[0];
const asService = (t: T) =>
	t.withIdentity({ subject: "test-service-account-user-id" } as Identity);

type Agent = { id: Id<"agents">; org: string; name: string };

async function world() {
	const t = createT();
	current = t;
	const made: Record<string, Agent> = {};
	await t.run(async (ctx) => {
		const now = Date.now();
		const agent = async (orgSlug: string, name: string) => {
			const id = await ctx.db.insert("agents", {
				orgSlug,
				clerkOrgId: testClerkOrgId(orgSlug),
				name,
				normalizedName: name,
				isActive: true,
				createdAt: now,
			});
			made[`${orgSlug}/${name}`] = { id, org: orgSlug, name };
		};
		await agent("perello", "pi");
		await agent("perello", "sigma");
		await agent("cgt-alsachimie", "bob");
		await agent("cgt-alsachimie", "mimir");
		await agent("cgt-alsachimie", "vpprobe-a");
		await agent("iris-rh", "victor");
		const org = (slug: string, names: string[], extra: Record<string, unknown>) =>
			ctx.db.insert("client_org_mapping", {
				clerkOrgSlug: slug,
				clerkOrgId: testClerkOrgId(slug),
				allowedOrchestrators: names,
				scopes: ["view-own-tasks"],
				displayName: slug,
				isActive: true,
				createdAt: now,
				...extra,
			} as never);
		await org("perello", ["pi", "sigma"], {
			orgKind: "operator",
			allowedAgentIds: [made["perello/pi"].id, made["perello/sigma"].id],
		});
		await org("cgt-alsachimie", ["bob", "mimir", "vpprobe-a"], {
			allowedAgentIds: [
				made["cgt-alsachimie/bob"].id,
				made["cgt-alsachimie/mimir"].id,
				made["cgt-alsachimie/vpprobe-a"].id,
			],
		});
		await org("iris-rh", ["victor"], { allowedAgentIds: [made["iris-rh/victor"].id] });
		for (const role of ["pi", "sigma", "bob", "mimir", "vpprobe-a", "victor"]) {
			await ctx.db.insert("profiles", {
				orchestratorId: role,
				name: role,
				static: { role, workspace: "test", capabilities: [] },
				dynamic: { lastSeen: now, sessionCount: 1 },
			});
		}
	});
	return { t, a: made };
}


type Thrown = { served: false; text: string; reason?: string } | { served: true };

async function outcome(p: Promise<unknown>): Promise<Thrown> {
	try {
		await p;
		return { served: true };
	} catch (e) {
		if (!(e instanceof ConvexError)) {
			// A bare Error reaches the client as "[Request ID: ...] Server Error".
			return { served: false, text: `BARE_ERROR(${String((e as Error).message)})` };
		}
		// convex-test hands a string payload back JSON-encoded; production does not.
		const raw = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
		const text = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
		const tail = /— (\{.*\})\s*$/.exec(text);
		const reason = tail ? (JSON.parse(tail[1]) as { reason?: string }).reason : undefined;
		return { served: false, text, reason };
	}
}
const codeOf = (o: Thrown): string =>
	o.served ? "SERVED" : (/^([A-Z][A-Z_]{3,}):/.exec(o.text)?.[1] ?? `NO_CODE(${o.text.slice(0, 60)})`);

const actor = (x: Agent) => ({ agentId: x.id, orgSlug: x.org });
const send = (w: Awaited<ReturnType<typeof world>>, x: Agent, args: Record<string, unknown>) =>
	asService(w.t).mutation(api.messages.sendMessage, {
		from: x.name,
		content: "hello",
		verifiedActor: actor(x),
		...(x.org === "perello" ? {} : { seatOrgSlug: x.org }),
		...args,
	} as never);
const store = (w: Awaited<ReturnType<typeof world>>, ns: string, type: string, x: Agent, agentIdNs = false) =>
	asService(w.t).mutation(api.memories.storeMemory, {
		namespace: agentIdNs ? `orchestrator/${x.id}` : ns,
		type,
		content: "c",
		createdBy: x.name,
		relations: [],
		verifiedActor: actor(x),
		__actingOrg: testClerkOrgId(x.org),
	} as never);

describe("store_memory by a client seat (cases 1 and 2)", () => {
	test("case 1: orchestrator/bob (cgt-alsachimie) is a typed RBAC_DENIED naming the namespace; its ID namespace is served", async () => {
		const w = await world();
		const bob = w.a["cgt-alsachimie/bob"];
		const refused = await outcome(store(w, "orchestrator/bob", "project", bob));
		expect(codeOf(refused)).toBe("RBAC_DENIED");
		expect(refused.served === false && refused.text).toContain('namespace "orchestrator/bob"');
		expect(await outcome(store(w, "", "project", bob, true))).toEqual({ served: true });
	});
	test("case 2: orchestrator/victor (iris-rh) is a typed RBAC_DENIED; its ID namespace is served", async () => {
		const w = await world();
		const victor = w.a["iris-rh/victor"];
		expect(codeOf(await outcome(store(w, "orchestrator/victor", "feedback", victor)))).toBe("RBAC_DENIED");
		expect(await outcome(store(w, "", "feedback", victor, true))).toEqual({ served: true });
	});
});

describe("send_message refusals carry their code (cases 3, 4, 5)", () => {
	test("case 3: a client seat writing to a fleet coordinator it does not list -> RBAC_DENIED recipient-not-addressable; its own roster is delivered", async () => {
		const w = await world();
		const mimir = w.a["cgt-alsachimie/mimir"];
		const refused = await outcome(send(w, mimir, { channel: "pi" }));
		expect(codeOf(refused)).toBe("RBAC_DENIED");
		expect(refused.served === false && refused.reason).toBe("recipient-not-addressable");
		expect(await outcome(send(w, mimir, { channel: "bob" }))).toEqual({ served: true });
	});
	test("case 4a: a seat writing only to itself by name -> INVALID_RECIPIENTS only-self", async () => {
		const w = await world();
		const probe = w.a["cgt-alsachimie/vpprobe-a"];
		const refused = await outcome(send(w, probe, { channel: "vpprobe-a" }));
		expect(codeOf(refused)).toBe("INVALID_RECIPIENTS");
		expect(refused.served === false && refused.reason).toBe("only-self");
	});
	test("case 4b: recipientAgentIds: self -> INVALID_RECIPIENTS; another org's agent -> RBAC_DENIED; a non-agent ID -> structured wrong-table payload; own roster by ID is delivered", async () => {
		const w = await world();
		const probe = w.a["cgt-alsachimie/vpprobe-a"];
		const self = await outcome(send(w, probe, { recipientAgentIds: [probe.id] }));
		expect(codeOf(self)).toBe("INVALID_RECIPIENTS");
		expect(self.served === false && self.reason).toBe("only-self");
		const foreign = await outcome(send(w, probe, { recipientAgentIds: [w.a["iris-rh/victor"].id] }));
		expect(codeOf(foreign)).toBe("RBAC_DENIED");
		expect(foreign.served === false && foreign.reason).toBe("recipient-agent-not-addressable");
		const bogus = await outcome(send(w, probe, { recipientAgentIds: ["r57b7m38bw947mrem590ks8g898g65nr"] }));
		expect(bogus.served === false && JSON.parse(bogus.text)).toMatchObject({
			path: "recipientAgentIds",
			expectedTable: "agents",
		});
		expect(await outcome(send(w, probe, { recipientAgentIds: [w.a["cgt-alsachimie/bob"].id] }))).toEqual({ served: true });
	});
	test("case 5: the fleet master naming a fleet station plus a client agent of another org -> RBAC_DENIED; the fleet station alone is delivered", async () => {
		const w = await world();
		const pi = w.a["perello/pi"];
		const refused = await outcome(send(w, pi, { channel: "sigma,victor" }));
		expect(codeOf(refused)).toBe("RBAC_DENIED");
		expect(refused.served === false && refused.reason).toBe("recipient-not-addressable");
		expect(await outcome(send(w, pi, { channel: "sigma" }))).toEqual({ served: true });
	});
	test("an empty channel list is INVALID_RECIPIENTS, not a rights refusal", async () => {
		const w = await world();
		const refused = await outcome(send(w, w.a["perello/pi"], { channel: " , " }));
		expect(codeOf(refused)).toBe("INVALID_RECIPIENTS");
		expect(refused.served === false && refused.reason).toBe("no-recipient");
	});
});

describe("a missing message is a typed code, never a bare Error", () => {
	test("deleteMessage on a deleted message -> MESSAGE_NOT_FOUND", async () => {
		const w = await world();
		const probe = w.a["cgt-alsachimie/vpprobe-a"];
		const id = await send(w, probe, { channel: "bob" });
		await w.t.run((ctx) => ctx.db.delete(id as Id<"messages">));
		expect(
			codeOf(await outcome(asService(w.t).mutation(api.messages.deleteMessage, { messageId: id as Id<"messages"> } as never))),
		).toBe("MESSAGE_NOT_FOUND");
	});
});

describe("class pin: no bare Error on the write paths", () => {
	test("convex/messages.ts has no 'throw new Error(' (a refusal or a missing row is a ConvexError with a code)", () => {
		const src = readFileSync(new URL("../messages.ts", import.meta.url), "utf8");
		expect(src.match(/throw new Error\(/g) ?? []).toEqual([]);
	});
	test("convex/memories.ts keeps exactly ONE bare Error: softDeleteMemory's absent-row answer to the fleet account, a contract pinned by memories.softDeleteMemory.wrongTable.test.ts", () => {
		const src = readFileSync(new URL("../memories.ts", import.meta.url), "utf8");
		expect(src.match(/throw new Error\(/g) ?? []).toHaveLength(1);
	});
});
