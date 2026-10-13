/**
 * Backend standard R-54, transport half: a claimless service-account call is
 * REFUSED at every Convex door that takes a verified organisation, so every call
 * to such a door must carry one.
 *
 * Every MCP caller reaches Convex as ONE service account. The fleet's own
 * stations (the master bearer) are called for the OPERATOR organisation, which
 * Convex stores (clientOrgMapping:getOperatorOrg, found by
 * @vantageos/cloud-identity's findOperatorOrg); a tenant bearer is called for the
 * organisation it was verified for. The claim is read from the verified
 * oauthContext only, never from a tool argument, and is added by ONE wrapper, so
 * no tool can forget it.
 *
 * Poles: PRESENT (the claim is added, whichever tool made the call), REFUSED-ON-
 * FAILURE (an operator organisation Convex cannot name is not guessed: nothing is
 * added and the door refuses), the claim is never widened (one claim per call,
 * a Clerk session is its own), and a sweep that holds the wrapper's door list to
 * the doors convex/ actually binds to a claim.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { OAuthContext } from "../src/auth.js";
import { CLAIM_BOUND_DOORS, withOperatorClaim } from "../src/operatorClaim.js";
import { forgetOperatorOrg, resolveOperatorOrgSlug } from "../src/operatorOrg.js";
import { registerTools } from "../src/tools.js";

const OPERATOR = "fleet-op";

type Call = { kind: string; fn: string; args: Record<string, unknown> };
type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean };

function stubClient(answer: () => unknown = () => ({ orgSlug: OPERATOR })) {
	const calls: Call[] = [];
	const record = (kind: string) => async (fn: unknown, args: unknown) => {
		calls.push({ kind, fn: String(fn), args: args as Record<string, unknown> });
		if (String(fn) === "clientOrgMapping:getOperatorOrg") return answer();
		if (kind === "query") return { value: [], continueCursor: null, isDone: true };
		return "doc-id";
	};
	const client = {
		query: record("query"),
		mutation: record("mutation"),
		action: record("action"),
	};
	return { client, calls };
}

const master = (operatorOrgSlug: string | null = OPERATOR): OAuthContext => ({
	clientId: "master",
	userId: "master",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "master",
	fromAllowList: ["*"],
	namespaceReadPrefixes: ["*"],
	namespaceWritePrefixes: ["*"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: true,
	viaMasterBearer: true,
	...(operatorOrgSlug !== null ? { operatorOrgSlug } : {}),
});

const tenant = (over: Partial<OAuthContext> = {}): OAuthContext => ({
	clientId: "client-a",
	userId: "user-a",
	scopes: ["vantage:read", "vantage:write"],
	scopeProfile: "client-a-seat",
	fromAllowList: ["alpha"],
	namespaceReadPrefixes: ["team/org-a"],
	namespaceWritePrefixes: ["team/org-a"],
	expiresAt: Date.now() + 3_600_000,
	isMaster: false,
	clerkOrgSlug: "org-a",
	actor: { orgSlug: "org-a", agentName: "alpha" },
	...over,
});

beforeEach(() => {
	forgetOperatorOrg();
});

describe("the master bearer is called for the OPERATOR organisation at every claim-bound door", () => {
	for (const door of [...CLAIM_BOUND_DOORS]) {
		it(`${door} carries verifiedOrg { orgSlug: operator }`, async () => {
			const { client, calls } = stubClient();
			const wrapped = withOperatorClaim(client, master());
			await wrapped.query(door as never, { x: 1 } as never);
			const reached = calls.find((c) => c.fn === door);
			expect(reached?.args).toEqual({ x: 1, verifiedOrg: { orgSlug: OPERATOR } });
		});
	}

	it("a door that is not claim-bound is called as it was, and the operator is not even asked", async () => {
		const { client, calls } = stubClient();
		const wrapped = withOperatorClaim(client, master());
		await wrapped.query("tasks:list" as never, { limit: 1 } as never);
		expect(calls).toEqual([{ kind: "query", fn: "tasks:list", args: { limit: 1 } }]);
	});

	it("the slug is the context's (Convex's answer), not a constant of this package", async () => {
		const { client, calls } = stubClient();
		const wrapped = withOperatorClaim(client, master("renamed-operator"));
		await wrapped.mutation("missions:updateStatus" as never, {} as never);
		expect(calls.find((c) => c.fn === "missions:updateStatus")?.args.verifiedOrg).toEqual({
			orgSlug: "renamed-operator",
		});
	});

	it("actions are covered like queries and mutations", async () => {
		const { client, calls } = stubClient();
		const wrapped = withOperatorClaim(client, master());
		await wrapped.action("kb:softDeleteDocument" as never, { docId: "d" } as never);
		expect(calls.find((c) => c.fn === "kb:softDeleteDocument")?.args.verifiedOrg).toEqual({
			orgSlug: OPERATOR,
		});
	});
});

describe("an operator organisation Convex cannot name is not guessed", () => {
	it("a master context that carries none forwards nothing: the door refuses the claimless call", async () => {
		const { client, calls } = stubClient();
		const wrapped = withOperatorClaim(client, master(null));
		expect(wrapped).toBe(client);
		await wrapped.query("missions:list" as never, { limit: 1 } as never);
		expect(calls.find((c) => c.fn === "missions:list")?.args).toEqual({ limit: 1 });
	});

	for (const [label, answer] of [
		["null (none, or several, operator organisations)", () => null],
		["an empty slug", () => ({ orgSlug: "" })],
		["a malformed answer", () => ({ slug: OPERATOR })],
		["a lookup that throws", () => {
			throw new Error("convex unreachable");
		}],
	] as Array<[string, () => unknown]>) {
		it(`the resolver answers undefined for ${label}`, async () => {
			const { client } = stubClient(answer);
			expect(await resolveOperatorOrgSlug(client)).toBeUndefined();
		});
	}

	it("the resolver returns Convex's slug, asks the stored-data door, and remembers a success", async () => {
		const { client, calls } = stubClient();
		expect(await resolveOperatorOrgSlug(client)).toBe(OPERATOR);
		expect(await resolveOperatorOrgSlug(client)).toBe(OPERATOR);
		expect(calls.map((c) => c.fn)).toEqual(["clientOrgMapping:getOperatorOrg"]);
	});
});

describe("a tenant bearer is called for the organisation it was verified for", () => {
	it("the agent credential's organisation wins over the token row's", async () => {
		const { client, calls } = stubClient();
		const wrapped = withOperatorClaim(
			client,
			tenant({ clerkOrgSlug: "org-token", actor: { orgSlug: "org-actor", agentName: "alpha" } }),
		);
		await wrapped.query("businessUnits:list" as never, {} as never);
		expect(calls.find((c) => c.fn === "businessUnits:list")?.args.verifiedOrg).toEqual({
			orgSlug: "org-actor",
		});
		expect(calls.some((c) => c.fn === "clientOrgMapping:getOperatorOrg")).toBe(false);
	});

	it("a tool argument never names the organisation: the claim is overwritten only when absent, and never taken from args", async () => {
		const { client, calls } = stubClient();
		const wrapped = withOperatorClaim(client, tenant());
		await wrapped.query("businessUnits:list" as never, { orgSlug: "org-b" } as never);
		expect(calls.find((c) => c.fn === "businessUnits:list")?.args.verifiedOrg).toEqual({
			orgSlug: "org-a",
		});
	});

	it("a bearer whose organisation cannot be resolved forwards nothing (the door refuses)", async () => {
		const { client } = stubClient();
		const bare = tenant({ clerkOrgSlug: undefined, actor: undefined });
		expect(withOperatorClaim(client, bare)).toBe(client);
	});
});

describe("one claim per call; a Clerk session is its own", () => {
	it("a call that already carries verifiedOrg is left as it is", async () => {
		const { client, calls } = stubClient();
		const wrapped = withOperatorClaim(client, master());
		await wrapped.query(
			"missions:list" as never,
			{ verifiedOrg: { orgSlug: "chosen" } } as never,
		);
		expect(calls.find((c) => c.fn === "missions:list")?.args.verifiedOrg).toEqual({
			orgSlug: "chosen",
		});
	});

	it("a call that carries a verified person is left as it is", async () => {
		const { client, calls } = stubClient();
		const wrapped = withOperatorClaim(client, tenant());
		await wrapped.mutation(
			"missions:update" as never,
			{ verifiedPerson: { subject: "u" } } as never,
		);
		const reached = calls.find((c) => c.fn === "missions:update");
		expect(reached?.args.verifiedOrg).toBeUndefined();
		expect(reached?.args.verifiedPerson).toEqual({ subject: "u" });
	});

	it("a Clerk-JWT session gets the SAME client back: its own org reaches Convex as its identity", () => {
		const { client } = stubClient();
		expect(withOperatorClaim(client, tenant({ clerkJwt: "jwt" }))).toBe(client);
	});

	it("an absent context gets the SAME client back (absence is never a claim)", () => {
		const { client } = stubClient();
		expect(withOperatorClaim(client, undefined)).toBe(client);
	});
});

describe("through registerTools: the fleet's own tools are called for the operator organisation", () => {
	function harness(ctx: OAuthContext) {
		const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
		const server = {
			tool: (name: string, _d: string, _s: unknown, _a: unknown, h: never) => {
				handlers.set(name, h);
			},
			registerTool: (name: string, _c: unknown, h: never) => {
				handlers.set(name, h);
			},
		} as Parameters<typeof registerTools>[0];
		const { client, calls } = stubClient();
		registerTools(server, client as Parameters<typeof registerTools>[1], ctx);
		return {
			calls,
			call: async (name: string, args: Record<string, unknown>) => {
				const h = handlers.get(name);
				if (!h) throw new Error(`${name} not registered`);
				return (await h(args)) as ToolResult;
			},
		};
	}

	const reached: Array<[string, string, Record<string, unknown>]> = [
		["list_bus", "businessUnits:list", {}],
		["list_missions", "missions:list", {}],
		["list_messages", "messages:listMessages", {}],
		["list_mandates", "mandates:list", {}],
		["list_errors", "errorMonitor:listErrors", {}],
		["list_issues", "issues:listByStatus", { status: "open" }],
		["issue_stats", "issues:getStats", {}],
		["list_fix_patterns", "fixPatterns:listAll", {}],
	];

	for (const [tool, door, args] of reached) {
		it(`${tool} -> ${door} carries verifiedOrg { orgSlug: operator } for the master bearer`, async () => {
			const h = harness(master());
			await h.call(tool, args);
			const call = h.calls.find((c) => c.fn === door);
			expect(call, `${door} was never reached`).toBeDefined();
			expect(call?.args.verifiedOrg).toEqual({ orgSlug: OPERATOR });
		});
	}
});

describe("sweep: the wrapper's door list is the doors convex/ binds to a claim", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const convexDir = join(here, "..", "..", "convex");
	const helpers = [
		"actingClaimOf(",
		"requireClaimedScope(",
		"scopeActingClaim(",
		"claim: { verifiedOrg",
		"writerOf(",
	];

	function found(): Map<string, string> {
		const out = new Map<string, string>();
		for (const file of readdirSync(convexDir)) {
			if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
			const mod = file.slice(0, -3);
			const src = readFileSync(join(convexDir, file), "utf8");
			for (const m of src.matchAll(/^export const (\w+) = (query|mutation|action)\(\{/gm)) {
				const start = m.index ?? 0;
				const end = src.indexOf("\n});\n", start);
				const block = src.slice(start, end === -1 ? src.length : end);
				const declaresClaim =
					m[2] === "action" &&
					(block.includes("claimedOrgArgs") || block.includes("verifiedOrg"));
				if (declaresClaim || helpers.some((h) => block.includes(h))) {
					out.set(`${mod}:${m[1]}`, block);
				}
			}
		}
		return out;
	}

	it("every door that calls a claim helper is in CLAIM_BOUND_DOORS, and nothing else is", () => {
		const doors = [...found().keys()].sort();
		expect(doors).toEqual([...CLAIM_BOUND_DOORS].sort());
	});

	it("every listed door declares the claim argument", () => {
		for (const [door, block] of found()) {
			expect(
				block.includes("verifiedOrg") || block.includes("claimedOrgArgs"),
				`${door} takes no verifiedOrg`,
			).toBe(true);
		}
	});

	it("the operator accessor the transport asks exists in convex/ and is the one the wrapper names", () => {
		const src = readFileSync(join(convexDir, "clientOrgMapping.ts"), "utf8");
		expect(src).toContain("export const getOperatorOrg = query(");
		const wrapper = readFileSync(join(here, "..", "src", "operatorOrg.ts"), "utf8");
		expect(wrapper).toContain('"clientOrgMapping:getOperatorOrg"');
	});

	it("no slug of the operator organisation is typed in the transport", () => {
		const claim = readFileSync(join(here, "..", "src", "operatorClaim.ts"), "utf8");
		const org = readFileSync(join(here, "..", "src", "operatorOrg.ts"), "utf8");
		for (const src of [claim, org]) {
			expect(src).not.toMatch(/orgSlug:\s*["'][a-z]/);
		}
	});
});
