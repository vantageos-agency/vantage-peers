/**
 * Identity-zero slice 2b (task k1778c2hvae8e8vz9f5bbbbbb98g62hw): the MCP tools
 * expose the optional agent-ID arguments the Convex doors now take.
 *
 *   send_message    fromAgentId
 *   create_task     assignedToAgentId   (sent beside assignedTo)
 *   update_task     assignedToAgentId   (sent beside assignedTo)
 *   create_mandate  fulfilledByAgentId  (sent beside fulfilledBy)
 *
 * The MCP never turns a name into an ID: it forwards the ID the caller passes,
 * verbatim, and Convex resolves it (convex/__tests__/agentIdArgs.test.ts). Every
 * existing argument is kept and a call that passes no ID is byte-for-byte what it
 * was. The name stays required where a delegation / roster guard reads it: the
 * guards in this file decide on the name, so an ID alone would skip them.
 *
 * Poles:
 *   FORWARD   the ID reaches the Convex door verbatim, beside the name
 *   ABSENT    no ID given -> no ID key sent (the call is unchanged)
 *   REFUSE    send_message: a fromAgentId that is not the verified agent, or a
 *             fromAgentId with neither a verified agent nor a `from`, is refused
 *             before any Convex call; update_task: an ID with no name is refused
 *   DESCRIBE  each description says the ID is the list_peers `agentId`
 *   CONTRACT  rollout order: the MCP requires contract 3, Convex serves 3
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKEND_CONTRACT_VERSION } from "../../convex/lib/backendManifest";
import type { OAuthContext } from "../src/auth.js";
import {
	MCP_CALLED_FUNCTIONS,
	REQUIRED_CONTRACT_VERSION,
} from "../src/backendContract";
import { registerTools } from "../src/tools.js";

type Result = {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CLIO_ID = "jh72scrneffpeqwy51rg8hny1x8fv2c4";
const HELIOS_ID = "jh7a2h3s0957ybsap1hqddek3x882sf3";

function seat(over: Partial<OAuthContext> = {}): OAuthContext {
	return {
		clientId: "client-clio",
		userId: "user-clio",
		scopes: ["vantage:read", "vantage:write"],
		scopeProfile: "clio-acme-hr",
		fromAllowList: ["clio", "helios"],
		namespaceReadPrefixes: ["team/acme-hr"],
		namespaceWritePrefixes: ["team/acme-hr"],
		expiresAt: Date.now() + 3_600_000,
		isMaster: false,
		accessTokenHash: "hash-clio",
		clerkOrgSlug: "acme-hr",
		seatAgent: { agentId: CLIO_ID, orgId: "acme-hr", agentName: "clio" },
		...over,
	};
}

type Call = { kind: string; name: string; args: Record<string, unknown> };

function harness(ctx: OAuthContext) {
	const handlers = new Map<string, Handler>();
	const reg = (...a: unknown[]) => {
		handlers.set(a[0] as string, a[a.length - 1] as Handler);
		return {};
	};
	const calls: Call[] = [];
	const convex = {
		query: async (name: string, args: Record<string, unknown>) => {
			calls.push({ kind: "query", name, args });
			if (name.startsWith("orgRoster:")) return ["clio", "helios"];
			return [];
		},
		mutation: async (name: string, args: Record<string, unknown>) => {
			calls.push({ kind: "mutation", name, args });
			return "doc-id";
		},
		action: async () => null,
	} as unknown as Parameters<typeof registerTools>[1];
	registerTools(
		{ registerTool: reg, tool: reg } as unknown as Parameters<
			typeof registerTools
		>[0],
		convex,
		ctx,
	);
	const call = (tool: string, args: Record<string, unknown>) => {
		const h = handlers.get(tool);
		if (!h) throw new Error(`${tool} not registered`);
		return h(args);
	};
	const to = (name: string) =>
		calls.filter((c) => c.kind === "mutation" && c.name === name);
	return { call, to };
}

describe("FORWARD — the ID reaches the Convex door verbatim", () => {
	it("send_message forwards fromAgentId beside from", async () => {
		const h = harness(seat());
		const res = await h.call("send_message", {
			from: "clio",
			fromAgentId: CLIO_ID,
			recipientAgentIds: [HELIOS_ID],
			content: "x",
		});
		expect(res.isError).toBeFalsy();
		expect(h.to("messages:sendMessage")[0]?.args.fromAgentId).toBe(CLIO_ID);
	});
	it("create_task forwards assignedToAgentId beside assignedTo", async () => {
		const h = harness(seat());
		const res = await h.call("create_task", {
			title: "t",
			assignedTo: "clio",
			assignedToAgentId: CLIO_ID,
			priority: "low",
			status: "todo",
			createdBy: "clio",
		});
		expect(res.isError).toBeFalsy();
		const sent = h.to("tasks:create");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.args.assignedToAgentId).toBe(CLIO_ID);
		expect(sent[0]?.args.assignedTo).toBe("clio");
	});
	it("update_task forwards assignedToAgentId beside assignedTo", async () => {
		const h = harness(seat());
		const res = await h.call("update_task", {
			taskId: "k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			assignedTo: "clio",
			assignedToAgentId: CLIO_ID,
			callerOrchestrator: "clio",
		});
		expect(res.isError).toBeFalsy();
		const sent = h.to("tasks:update");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.args.assignedToAgentId).toBe(CLIO_ID);
	});
	it("create_mandate forwards fulfilledByAgentId beside fulfilledBy", async () => {
		const h = harness(seat());
		const res = await h.call("create_mandate", {
			requestedBy: "clio",
			fulfilledBy: "clio",
			fulfilledByAgentId: CLIO_ID,
			service: "s",
			budget: 1,
		});
		expect(res.isError).toBeFalsy();
		expect(h.to("mandates:create")[0]?.args.fulfilledByAgentId).toBe(CLIO_ID);
	});
});

describe("ABSENT — no ID given, no ID key sent", () => {
	it("send_message / create_task / update_task / create_mandate", async () => {
		const h = harness(seat());
		await h.call("send_message", {
			from: "clio",
			recipientAgentIds: [HELIOS_ID],
			content: "x",
		});
		await h.call("create_task", {
			title: "t",
			assignedTo: "clio",
			priority: "low",
			status: "todo",
			createdBy: "clio",
		});
		await h.call("update_task", {
			taskId: "k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			assignedTo: "clio",
			callerOrchestrator: "clio",
		});
		await h.call("create_mandate", {
			requestedBy: "clio",
			fulfilledBy: "clio",
			service: "s",
			budget: 1,
		});
		for (const [door, key] of [
			["messages:sendMessage", "fromAgentId"],
			["tasks:create", "assignedToAgentId"],
			["tasks:update", "assignedToAgentId"],
			["mandates:create", "fulfilledByAgentId"],
		] as const) {
			const sent = h.to(door);
			expect(sent.length).toBeGreaterThan(0);
			expect(sent[0]?.args[key]).toBeUndefined();
		}
	});
});

describe("REFUSE — before any Convex call", () => {
	it("send_message: a fromAgentId that is not the verified agent", async () => {
		const h = harness(seat());
		const res = await h.call("send_message", {
			from: "clio",
			fromAgentId: HELIOS_ID,
			recipientAgentIds: [HELIOS_ID],
			content: "x",
		});
		expect(res.isError).toBe(true);
		expect(res.content[0]?.text).toContain("AGENT_IDENTITY_MISMATCH");
		expect(h.to("messages:sendMessage")).toEqual([]);
	});
	it("send_message: fromAgentId with no verified agent and no `from`", async () => {
		const h = harness(
			seat({ seatAgent: undefined, fromAllowList: ["clio"] }),
		);
		const res = await h.call("send_message", {
			fromAgentId: CLIO_ID,
			recipientAgentIds: [HELIOS_ID],
			content: "x",
		});
		expect(res.isError).toBe(true);
		expect(h.to("messages:sendMessage")).toEqual([]);
	});
	it("update_task: an ID with no assignedTo (the delegation guard reads the name)", async () => {
		const h = harness(seat());
		const res = await h.call("update_task", {
			taskId: "k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			assignedToAgentId: CLIO_ID,
			callerOrchestrator: "clio",
		});
		expect(res.isError).toBe(true);
		expect(h.to("tasks:update")).toEqual([]);
	});
});

describe("DESCRIBE — the ID is the list_peers agentId", () => {
	const src = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");
	for (const arg of ["fromAgentId", "assignedToAgentId", "fulfilledByAgentId"]) {
		it(`${arg} is declared and says list_peers agentId`, () => {
			const at = src.indexOf(`${arg}: z`);
			expect(at).toBeGreaterThan(-1);
			expect(src.slice(at, at + 700)).toContain("list_peers");
		});
	}
});

describe("CONTRACT — rollout order, Convex first", () => {
	it("the MCP requires contract 6 and Convex serves 6", () => {
		expect(REQUIRED_CONTRACT_VERSION).toBe(6);
		expect(BACKEND_CONTRACT_VERSION).toBe(6);
	});
	it("the MCP calls no Convex function the manifest of contract 6 lacks", () => {
		expect(MCP_CALLED_FUNCTIONS).not.toContain("nameOnlyCalls:summary");
	});
});
